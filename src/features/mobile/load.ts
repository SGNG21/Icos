import { CURRENT_SINGLE_TENANT_ID, hasPermission } from "@/core/identity";
import {
  getCockpitContext,
  loadReadModels,
  loadSnapshot,
  loadSources,
} from "@/features/cockpit/load";
import { isReal, missing, real, type Truth } from "@/features/cockpit/truth";
import { buildWorkforceView } from "@/features/cockpit/workforce";
import type { Database } from "@/server/database/client";
import { supervisorReadPort } from "@/server/proactive/read-port";

import {
  buildMobileHome,
  type MobileHomeModel,
  type PendingApprovalFact,
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

async function read<T>(label: string, fn: () => Promise<T>): Promise<Truth<T>> {
  try {
    return real(await fn());
  } catch {
    // The error text may carry internals; the phone only states the fact.
    return missing("unknown", `${label} could not be read from ICOS.`);
  }
}

/** `null` = authenticated but not allowed to read: the page renders the denial. */
export async function loadMobileHome(): Promise<MobileHomeModel | null> {
  const ctx = await getCockpitContext();
  if (!ctx) return null;
  const [snapshot, sources] = await Promise.all([loadSnapshot(), loadSources()]);
  if (!snapshot || !sources) return null;
  const { container, session, scope } = ctx;
  const global = scope.kind === "global";

  const [approvals, readModels, supervisor] = await Promise.all([
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
  ]);

  const workforce: Truth<WorkforceCensus> = (() => {
    if (!isReal(readModels)) return readModels as Truth<WorkforceCensus>;
    const wf = readModels.value?.workforce;
    if (!wf) return missing("unknown", "The workforce read model could not be read.");
    if (!isReal(wf)) return wf as Truth<WorkforceCensus>;
    const view = buildWorkforceView(wf.value, new Date());
    return real({ total: view.agents.total, byStatus: view.agents.byStatus });
  })();

  return buildMobileHome({
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
