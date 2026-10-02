import { CURRENT_SINGLE_TENANT_ID, hasPermission } from "@/core/identity";
import { UNKNOWN, type ObjectiveState } from "@/core/supervisor/contracts";
import {
  getCockpitContext,
  loadReadModels,
  loadSnapshot,
  loadSources,
} from "@/features/cockpit/load";
import { isReal, missing, real, type Truth } from "@/features/cockpit/truth";
import { buildWorkforceView } from "@/features/cockpit/workforce";
import { isMissionInScope } from "@/server/administration/mission-scope";
import type { Database } from "@/server/database/client";
import { supervisorReadPort } from "@/server/proactive/read-port";
import {
  buildObjectiveReadModel,
  type ObjectiveView,
} from "@/server/supervisor/objective-read-model";

import {
  STATE_OF_MISSING,
  buildMobileHome,
  type MobileHomeModel,
  type PendingApprovalFact,
  type Section,
  type SupervisorSituationFact,
  type WorkforceCensus,
} from "./home";

/**
 * Server-side loader of the Mobile Home. READ ONLY.
 *
 * It owns nothing: every fact comes from a canonical read path that already exists —
 * the cockpit snapshot (CORE3 missions + worker registry + dispatch ledger + durable
 * audit log, all under the caller's operational scope), the Digital Workforce read
 * model, the canonical action repository and the Proactive Supervisor's durable store.
 *
 * Opening the Mobile Home triggers no mission, no dispatch, no supervisor ingest and no
 * housekeeping: the only calls made here are list/read ones. Each source is read in
 * isolation so one failure degrades that section to UNKNOWN instead of blanking the page.
 */

/** How far back the supervisor digest and the activity feed look. */
export const SUPERVISOR_WINDOW_MS = 7 * 86_400_000;
export const ACTIVITY_LIMIT = 20;
/**
 * Objectives resolved for the phone. The read model costs ~5 queries PER objective and it
 * returns them in priority order, so the home reads the top few rather than the page-sized
 * 100 of `/api/supervisor/objectives`.
 *
 * ponytail: raise this only together with a batched objective query; a bigger number here
 * is a bigger fan-out on the most-opened page in ICOS.
 */
export const MOBILE_OBJECTIVE_LIMIT = 3;

/**
 * One objective as the phone states it (decision 0065 read model, flattened).
 *
 * Every field whose source truth may be absent is a `Truth`, never a stand-in: the owner
 * must be able to tell "ICOS settled 2 of 5 tasks" from "ICOS cannot read the tasks".
 */
export interface ObjectiveLine {
  id: string;
  title: string;
  state: ObjectiveState;
  phase: string;
  missionId: string | null;
  blockedReason: string | null;
  humanDecisionRequired: boolean;
  progress: Truth<string>;
  /** The last thing ICOS actually decided about this objective — the owner's answer. */
  result: Truth<string>;
  /** Always a stated hole today: no ICOS row carries a spend figure yet. */
  cost: Truth<string>;
}

/**
 * Flattens one `ObjectiveView` for the phone. The read model's UNKNOWN sentinel becomes an
 * explicit `Truth`, so nothing uncertain can reach the screen as a value.
 */
export function toObjectiveLine(view: ObjectiveView): ObjectiveLine {
  return {
    id: view.objectiveId,
    title: view.title,
    state: view.state,
    phase: view.phase,
    missionId: view.missionId,
    blockedReason: view.blockedReason,
    humanDecisionRequired: view.humanDecisionRequired,
    progress:
      view.progress === UNKNOWN
        ? missing("unknown", "ICOS n'a pas pu lire les tâches de cet objectif.")
        : real(`${view.progress.tasksSettled}/${view.progress.tasksTotal} tâches réglées`),
    result:
      view.latestMeaningfulResult === UNKNOWN
        ? missing("not_available", "Aucune décision de revue n'est encore enregistrée.")
        : real(view.latestMeaningfulResult),
    /*
     * The read model returns UNKNOWN for cost because no CORE3 row carries one (there is no
     * cost column on task_execution_results). The field is SHOWN and labelled as a hole
     * rather than hidden or zeroed: hiding it would let the owner assume a free run.
     */
    cost:
      view.cost === UNKNOWN
        ? missing(
            "not_available",
            "Aucun relevé de dépense n'existe dans ICOS : aucun chiffre n'est inventé.",
            "BR-05",
          )
        : real(`${view.cost}`),
  };
}

/**
 * An EMPTY approval queue is NOT_CONNECTED, not calm.
 *
 * `ActionRepository` exposes list/get only — it has no create method, and nothing in ICOS
 * outside the tests inserts an `actions` row — so this queue cannot fill. Showing "aucune
 * action en attente" would teach the owner that silence means nothing needs him, while real
 * escalations reach him as conversational proposals instead. Rows that DO exist are still
 * returned untouched, and an unreadable repository stays its own kind of missing.
 */
export function approvalQueueTruth(
  rows: Truth<readonly PendingApprovalFact[]>,
): Truth<readonly PendingApprovalFact[]> {
  if (!isReal(rows) || rows.value.length > 0) return rows;
  return missing(
    "not_connected",
    "Aucun chemin de code ne crée d'action à approuver : cette file ne peut pas se remplir, donc son silence ne signifie pas « rien ne vous attend ». Les vraies demandes arrivent en propositions dans la conversation.",
  );
}

/**
 * `Truth` → section vocabulary, the same mapping `buildMobileHome` applies to its own
 * sources. Inlined because `home.ts`'s `section()` is private to that module; it is the one
 * shape, not a second one.
 */
function toSection<A, B>(truth: Truth<readonly A[]>, map: (a: A) => B): Section<B> {
  if (!isReal(truth)) {
    return {
      state: STATE_OF_MISSING[truth.kind],
      items: [],
      reason: truth.reason,
      requirement: truth.requirement ?? null,
    };
  }
  const items = truth.value.map(map);
  return { state: items.length ? "CONNECTED" : "EMPTY", items, reason: null, requirement: null };
}

/**
 * What the Mobile Home renders: the canonical model plus the objective read model, which
 * `buildMobileHome` does not own. Structurally a `MobileHomeModel`, so every existing
 * consumer keeps working.
 */
export type MobileHomeView = MobileHomeModel & { objectives: Section<ObjectiveLine> };

async function read<T>(label: string, fn: () => Promise<T>): Promise<Truth<T>> {
  try {
    return real(await fn());
  } catch {
    // The error text may carry internals; the phone only states the fact.
    return missing("unknown", `${label} could not be read from ICOS.`);
  }
}

/** `null` = authenticated but not allowed to read: the page renders the denial. */
export async function loadMobileHome(): Promise<MobileHomeView | null> {
  const ctx = await getCockpitContext();
  if (!ctx) return null;
  const [snapshot, sources] = await Promise.all([loadSnapshot(), loadSources()]);
  if (!snapshot || !sources) return null;
  const { container, session, scope } = ctx;
  const global = scope.kind === "global";

  const [actionRows, readModels, supervisor, objectiveViews] = await Promise.all([
    read("Approvals", async () =>
      (await container.actions.listForScope(scope, { approvalStatus: "pending" })).map(
        (a): PendingApprovalFact => ({
          id: a.id,
          kind: a.kind,
          risk: a.risk,
          taskId: a.taskId ?? null,
          requestedAt: a.requestedAt,
          requestedBy: a.initiatedByAgentId,
        }),
      ),
    ),
    // Contained like every other source: `loadReadModels` has no error handling of its
    // own and the workforce port awaits four service calls that can throw (an unavailable
    // database raises). Uncontained, one of those would 500 the whole home page instead of
    // degrading one line to UNKNOWN — the opposite of what this loader promises above.
    read("Read models", loadReadModels),
    readSupervisor(container.db, global),
    // Same containment as every other source, and the BUILDER directly: a server component
    // fetching its own HTTP route would re-authenticate itself and hide failures as 500s.
    read("Objectifs", () =>
      buildObjectiveReadModel(
        {
          goals: container.goalRepository,
          missions: container.mission,
          reviews: container.reviewDecisions,
          runtimes: { get: (missionId) => container.autonomousRuntime.get(missionId) },
          controlHolds: {
            /* Read-only: the canonical authority answers whether a mission is held. */
            async isHeld(missionId) {
              return !(await container.controlGuard.dispatch(missionId)).allowed;
            },
          },
          visibility: {
            // Identical to /api/supervisor/objectives: a goal with no mission has no task to
            // scope by, so only a global reader sees it. Scope is never widened for a phone.
            unconvertedVisible: global,
            isMissionVisible: (missionId, tasks) =>
              isMissionInScope(container, missionId, scope, tasks ?? undefined),
          },
        },
        { limit: MOBILE_OBJECTIVE_LIMIT },
      ),
    ),
  ]);

  const approvals = approvalQueueTruth(actionRows);

  const workforce: Truth<WorkforceCensus> = (() => {
    if (!isReal(readModels)) return readModels as Truth<WorkforceCensus>;
    const wf = readModels.value?.workforce;
    if (!wf) return missing("unknown", "The workforce read model could not be read.");
    if (!isReal(wf)) return wf as Truth<WorkforceCensus>;
    const view = buildWorkforceView(wf.value, new Date());
    return real({ total: view.agents.total, byStatus: view.agents.byStatus });
  })();

  const model = buildMobileHome({
    generatedAt: snapshot.generatedAt,
    health: snapshot.health,
    // Which perimeter these facts were read under. `resolveOperationalScope` fails CLOSED
    // to an empty linked scope when the operational-access service is absent, so without
    // this an owner would read a silently minimal perimeter as "nothing exists".
    scope: snapshot.scope,
    missions: snapshot.missions,
    focus: snapshot.focus,
    workers: snapshot.workers,
    // `WorkerView.assignments` is a plain array, so the projection needs the ledger's own
    // truth to tell "this worker holds no task" from "the ledger could not be read".
    dispatchLedger: sources.attempts,
    timeline: snapshot.timeline,
    alerts: snapshot.alerts,
    approvals,
    canConverse: hasPermission(session.roles, "tasks.write"),
    canDecideApprovals: hasPermission(session.roles, "approvals.decide"),
    canDecideProposals: hasPermission(session.roles, "missions.write"),
    workforce,
    supervisor,
    activityLimit: ACTIVITY_LIMIT,
  });

  return { ...model, objectives: toSection(objectiveViews, toObjectiveLine) };
}

/**
 * Proactive Supervisor situations + their proposals, from the supervisor's OWN durable
 * store (decision 0060, `digest`). PostgreSQL only, and owner/admin scope only: the
 * supervisor's rows are tenant-scoped, with no per-user operational scope to apply, so a
 * linked (non-global) caller never sees them rather than seeing too much.
 */
async function readSupervisor(
  db: Database | undefined,
  global: boolean,
): Promise<Truth<readonly SupervisorSituationFact[]>> {
  if (!global)
    return missing(
      "not_available",
      "Les situations du superviseur proactif sont visibles en périmètre propriétaire/admin uniquement.",
    );
  if (!db)
    return missing(
      "not_connected",
      "Le superviseur proactif exige PostgreSQL : ce processus n'a pas de base durable.",
    );
  const until = new Date();
  const since = new Date(until.getTime() - SUPERVISOR_WINDOW_MS);
  return read("Proactive Supervisor", async () => {
    // A digest-only port: this read path never holds the supervisor's write surface.
    const digest = await supervisorReadPort(db).digest(CURRENT_SINGLE_TENANT_ID, { since, until });
    return digest.situations.map((s): SupervisorSituationFact => ({
      id: s.id,
      domain: s.domain,
      eventType: s.eventType,
      subject: s.subject,
      kind: s.kind,
      severity: s.severity,
      state: s.state,
      eventCount: s.eventCount,
      lastSeenAt: s.lastSeenAt.toISOString(),
      // The digest spans every client/project of the tenant: carry the scope so the owner
      // can tell which client a situation belongs to.
      clientScope: s.clientScope ?? null,
      projectScope: s.projectScope ?? null,
      proposal: s.proposal
        ? {
            action: s.proposal.proposal.action,
            desiredOutcome: s.proposal.proposal.desiredOutcome,
            reason: s.proposal.proposal.reason,
            risk: s.proposal.proposal.risk,
            urgency: s.proposal.proposal.urgency,
            state: s.proposal.state,
          }
        : null,
    }));
  });
}
