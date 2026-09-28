import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { hasPermission, type AuthenticatedSession } from "@/core/identity";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { Mission } from "@/core/mission/contracts";
import { isMissionInScope, resolveOperationalScope } from "@/server/administration/mission-scope";
import { resolveCockpitAccess } from "@/server/auth/cockpit-access";
import { getContainer, type Container } from "@/server/container";
import type { AgentScope } from "@/server/repositories/ports";

import { buildDag, type DagInputTask, type DagModel } from "./dag";
import { buildCockpitSnapshot, type CockpitSources, type MissionWithTasks } from "./snapshot";
import { isReal, missing, real, type Truth } from "./truth";

/**
 * Server-side loader of the cockpit. The ONLY place the cockpit touches ICOS:
 * canonical repositories, read-only, under the caller's operational scope.
 * Each source is read in isolation so one failure degrades to UNKNOWN instead
 * of blanking the cockpit (it must stay observable during incidents).
 */
export interface CockpitContext {
  container: Container;
  session: AuthenticatedSession;
  scope: AgentScope;
}

/** Per-request auth. `null` = authenticated but not allowed: the layout renders the denial. */
export const getCockpitContext = cache(async (): Promise<CockpitContext | null> => {
  const container = await getContainer();
  const access = await resolveCockpitAccess(container, await headers());
  if (access.kind === "redirect") redirect("/login?next=%2Fcockpit");
  if (access.kind === "forbidden") return null;
  return { container, session: access.session, scope: await resolveOperationalScope(container, access.session) };
});

async function read<T>(label: string, fn: () => Promise<T>): Promise<Truth<T>> {
  try {
    return real(await fn());
  } catch {
    // The error text may carry internals; the cockpit only states the fact.
    return missing("unknown", `${label} could not be read from ICOS.`);
  }
}

const ACTIVE_TASK = new Set(["queued", "running", "review_pending"]);

async function nonTerminalAttempts(container: Container, missions: readonly MissionWithTasks[]): Promise<DispatchAttempt[]> {
  // ponytail: one query per active mission task; replace with a cross-mission listing (BR-16) past ~100 active tasks.
  const active = missions.flatMap((m) => m.tasks).filter((t) => ACTIVE_TASK.has(t.status));
  const lists = await Promise.all(active.map((t) => container.dispatchAttempts.listNonTerminalByMissionTaskId(t.id)));
  return lists.flat();
}

export const loadSources = cache(async (): Promise<CockpitSources | null> => {
  const ctx = await getCockpitContext();
  if (!ctx) return null;
  const { container, session, scope } = ctx;
  const global = scope.kind === "global";
  const outOfScope = missing("not_available", "Worker infrastructure is visible to owner/admin scope only.");

  const [tasks, missions, workers, activeAssignments, pendingApprovals] = await Promise.all([
    read("Tasks", () => container.tasks.listForScope(scope)),
    read("Missions", async () => {
      // ponytail: N+1 over missions, same as GET /api/missions; paginate when missions reach hundreds.
      const out: MissionWithTasks[] = [];
      for (const mission of await container.mission.list()) {
        const tasks = await container.mission.listTasks(mission.id);
        if (await isMissionInScope(container, mission.id, scope, tasks)) out.push({ mission, tasks });
      }
      return out;
    }),
    global ? read("Worker registry", () => container.workerRegistryStore.list()) : outOfScope,
    global ? read("Dispatch ledger", () => container.dispatchAttempts.listActiveWorkerAssignments()) : outOfScope,
    read("Approvals", async () => (await container.actions.listForScope(scope, { approvalStatus: "pending" })).length),
  ]);

  const attempts = isReal(missions)
    ? await read("Dispatch attempts", () => nonTerminalAttempts(container, missions.value))
    : missions;

  let audit: CockpitSources["audit"];
  if (!hasPermission(session.roles, "audit.read.full")) {
    audit = missing("not_available", "The audit timeline requires the audit.read.full permission.");
  } else if (global) {
    audit = await read("Audit log", () => container.audit.list());
  } else if (isReal(tasks)) {
    // Linked scope: only entries about tasks the caller can already see.
    const visible = new Set(tasks.value.map((t) => t.id));
    audit = await read("Audit log", async () => (await container.audit.list()).filter((e) => e.taskId && visible.has(e.taskId)));
  } else {
    audit = tasks;
  }

  return {
    now: new Date(),
    backend: container.db ? "postgres" : "memory",
    scope: global ? "global" : "linked",
    tasks,
    missions,
    workers,
    activeAssignments,
    attempts,
    pendingApprovals,
    audit,
  };
});

export const loadSnapshot = cache(async () => {
  const sources = await loadSources();
  return sources ? buildCockpitSnapshot(sources) : null;
});

export interface MissionDetail {
  mission: Mission;
  dag: DagModel;
  attempts: Truth<DispatchAttempt[]>;
  reviews: Truth<ReviewDecisionRecord[]>;
}

export async function loadMissionDetail(id: string): Promise<MissionDetail | null> {
  const ctx = await getCockpitContext();
  if (!ctx) return null;
  const { container, scope } = ctx;
  const mission = await container.mission.findById(id);
  // Out of scope is indistinguishable from unknown, as in GET /api/missions/[id].
  if (!mission) notFound();
  const tasks = await container.mission.listTasks(id);
  if (!(await isMissionInScope(container, id, scope, tasks))) notFound();

  const [attempts, reviews] = await Promise.all([
    read("Dispatch attempts", () => nonTerminalAttempts(container, [{ mission, tasks }])),
    read("Review decisions", () => container.reviewDecisions.listByMissionId(id)),
  ]);

  const attemptByTask = new Map(isReal(attempts) ? attempts.value.map((a) => [a.missionTaskId, a]) : []);
  const latestReview = new Map<string, ReviewDecisionRecord>();
  if (isReal(reviews)) {
    for (const r of [...reviews.value].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) latestReview.set(r.taskId, r);
  }

  const input: DagInputTask[] = tasks.map((task) => {
    const a = attemptByTask.get(task.id);
    const r = latestReview.get(task.taskId);
    return {
      task,
      attempt: a && {
        attempt: a.attempt,
        state: a.state,
        workerId: a.workerId,
        workerKind: a.workerKind,
        failureClass: a.failureClass,
        lastError: a.lastError,
        dispatchedAt: a.dispatchedAt ? new Date(a.dispatchedAt).toISOString() : undefined,
      },
      review: r && {
        decision: r.decision,
        reasons: r.reasons,
        reviewerKind: r.reviewerKind,
        provider: r.providerMetadata?.provider,
        model: r.providerMetadata?.model,
        createdAt: r.createdAt,
      },
    };
  });

  return { mission, dag: buildDag(input), attempts, reviews };
}
