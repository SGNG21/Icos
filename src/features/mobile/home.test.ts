import { describe, expect, it } from "vitest";

import type { Alert, MissionSummary, TimelineEntry, WorkerView } from "@/features/cockpit/snapshot";
import { isReal, missing, real } from "@/features/cockpit/truth";

import {
  buildMobileHome,
  type MobileHomeInput,
  type PendingApprovalFact,
  type SupervisorSituationFact,
} from "./home";

const mission = (over: Partial<MissionSummary> = {}): MissionSummary => ({
  id: "mission-1",
  title: "Refonte LDS",
  objective: "Livrer le site LDS Rénov",
  status: "running",
  updatedAt: "2026-09-30T10:00:00.000Z",
  total: 4,
  completed: 1,
  running: 1,
  failed: 0,
  ready: 1,
  progressPct: 25,
  remainingCriticalPath: 3,
  attention: false,
  tone: "ok",
  ...over,
});

const worker = (over: Partial<WorkerView> = {}): WorkerView => ({
  id: "worker-1",
  name: "Hermes 1",
  kind: "hermes",
  runtime: "temporal",
  runtimeSupport: "supported",
  status: "active",
  health: "healthy",
  availability: "available",
  probe: { outcome: "ok", at: "2026-09-30T09:00:00.000Z", ageMs: 1_000 },
  model: real("claude-opus-5"),
  provider: real("anthropic"),
  account: missing("not_available", "no account recorded"),
  slots: { used: real(0), max: 2 },
  pool: null,
  capabilities: [],
  features: [],
  tags: [],
  metadata: {},
  metadataHidden: 0,
  assignments: [],
  leases: real([]),
  tone: "ok",
  routable: true,
  ...over,
});

const timelineEntry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: "audit-1",
  at: "2026-09-30T10:00:00.000Z",
  type: "mission.created",
  actor: "owner@example.com",
  actorKind: "human",
  taskId: null,
  tone: "flow",
  ...over,
});

const approval = (over: Partial<PendingApprovalFact> = {}): PendingApprovalFact => ({
  id: "action-1",
  kind: "repository.push",
  risk: "sensitive",
  taskId: "task-2",
  requestedAt: "2026-09-30T08:10:00.000Z",
  requestedBy: "agent-development",
  ...over,
});

const situation = (over: Partial<SupervisorSituationFact> = {}): SupervisorSituationFact => ({
  id: "situation-1",
  domain: "billing",
  eventType: "INVOICE_OVERDUE",
  subject: "invoice:INV-7",
  kind: "problem",
  severity: "high",
  state: "open",
  eventCount: 3,
  lastSeenAt: "2026-09-30T07:00:00.000Z",
  clientScope: null,
  projectScope: null,
  proposal: null,
  ...over,
});

const input = (over: Partial<MobileHomeInput> = {}): MobileHomeInput => ({
  generatedAt: "2026-09-30T10:05:00.000Z",
  health: { level: "healthy", reasons: [] },
  missions: real([mission()]),
  focus: null,
  workers: real([worker()]),
  dispatchLedger: real([]),
  timeline: real([timelineEntry()]),
  alerts: [],
  approvals: real([]),
  canConverse: true,
  canDecideApprovals: true,
  canDecideProposals: true,
  workforce: real({ total: 0, byStatus: {} }),
  supervisor: real([]),
  ...over,
});

describe("active mission mapping", () => {
  it("maps the canonical focus mission with the facts ICOS really states", () => {
    const model = buildMobileHome(
      input({
        focus: {
          missionId: "mission-1",
          path: [
            { id: "t1", title: "Audit du site", status: "COMPLETED" },
            { id: "t2", title: "Maquette mobile", status: "RUNNING" },
          ],
        },
      }),
    );
    expect(model.activeMission.state).toBe("CONNECTED");
    const row = model.activeMission.items[0];
    expect(row.id).toBe("mission-1");
    expect(row.title).toBe("Refonte LDS");
    expect(row.objective).toBe("Livrer le site LDS Rénov");
    expect(row.status).toBe("running");
    // Current task = head of the canonical critical path that is not done.
    expect(row.currentTask).toMatchObject({ kind: "real", value: "Maquette mobile" });
    expect(row.updatedAt).toBe("2026-09-30T10:00:00.000Z");
    expect(row.approvalRequired).toBe(false);
    expect(row.progress).toEqual({ completed: 1, total: 4, pct: 25 });
  });

  it("falls back to an active mission when ICOS states no focus, and says why no task is shown", () => {
    const model = buildMobileHome(input({ missions: real([mission({ status: "blocked" })]) }));
    const task = model.activeMission.items[0].currentTask;
    expect(task.kind).toBe("not_available");
    // Not "undiscoverable": ICOS derives a critical path for the focus mission only.
    expect(task.kind === "not_available" && task.reason).toContain("focus");
    expect(model.activeMission.items[0].status).toBe("blocked");
  });

  it("falls back deterministically when the focus names a mission outside the summaries", () => {
    const model = buildMobileHome(
      input({
        missions: real([mission({ id: "mission-1", status: "running" })]),
        focus: { missionId: "mission-gone", path: [{ id: "t", title: "T", status: "READY" }] },
      }),
    );
    expect(model.activeMission.state).toBe("CONNECTED");
    expect(model.activeMission.items[0].id).toBe("mission-1");
    expect(model.activeMission.items[0].currentTask.kind).toBe("not_available");
  });

  it("states a completed critical path as a fact, not as a missing source", () => {
    const model = buildMobileHome(
      input({
        focus: {
          missionId: "mission-1",
          path: [{ id: "t1", title: "Audit", status: "COMPLETED" }],
        },
      }),
    );
    const task = model.activeMission.items[0].currentTask;
    // ICOS derived the path AND it is finished: that is known, so it is real.
    expect(isReal(task)).toBe(true);
    expect(isReal(task) && task.value).toContain("chemin critique terminé");
  });

  it("marks the mission-level approval gate from the canonical status", () => {
    const model = buildMobileHome(
      input({ missions: real([mission({ status: "awaiting_approval" })]) }),
    );
    expect(model.activeMission.items[0].approvalRequired).toBe(true);
  });

  it("never fabricates a progress percentage for a mission without tasks", () => {
    const model = buildMobileHome(
      input({ missions: real([mission({ total: 0, completed: 0, progressPct: 0 })]) }),
    );
    expect(model.activeMission.items[0].progress).toBeNull();
  });

  it("counts only workers holding a dispatch on this mission", () => {
    const assigned = worker({
      id: "worker-9",
      assignments: [
        {
          missionId: "mission-1",
          missionTaskId: "mt-1",
          taskId: "task-1",
          attempt: 1,
          state: "dispatched",
          dispatchedAt: null,
          failureClass: null,
          lastError: null,
        },
      ],
    });
    const model = buildMobileHome(
      input({ workers: real([worker(), { ...assigned, slots: { used: real(1), max: 2 } }]) }),
    );
    expect(model.activeMission.items[0].workersActive).toMatchObject({ kind: "real", value: 1 });
  });

  it("is EMPTY — not disconnected — when no mission is active", () => {
    const model = buildMobileHome(input({ missions: real([mission({ status: "succeeded" })]) }));
    expect(model.activeMission.state).toBe("EMPTY");
    expect(model.activeMission.items).toEqual([]);
  });

  it("is UNKNOWN when the mission source could not be read (a timeout is not EMPTY)", () => {
    const model = buildMobileHome(
      input({ missions: missing("unknown", "Missions could not be read from ICOS.") }),
    );
    expect(model.activeMission.state).toBe("UNKNOWN");
    expect(model.activeMission.reason).toBe("Missions could not be read from ICOS.");
    expect(model.activeMission.items).toEqual([]);
  });

  it("is DEGRADED when the mission is real but the worker source is not", () => {
    const model = buildMobileHome(
      input({ workers: missing("unknown", "Worker registry could not be read from ICOS.") }),
    );
    expect(model.activeMission.state).toBe("DEGRADED");
    expect(model.activeMission.items[0].workersActive.kind).toBe("unknown");
  });

  it("never reports 'Workers actifs : 0' when the dispatch ledger could not be read", () => {
    const model = buildMobileHome(
      input({ dispatchLedger: missing("unknown", "Dispatch attempts could not be read.") }),
    );
    expect(model.activeMission.state).toBe("DEGRADED");
    const active = model.activeMission.items[0].workersActive;
    expect(active.kind).toBe("unknown");
    // A zero with a "non-terminal dispatch" derivation would be a false provenance claim.
    expect(isReal(active)).toBe(false);
  });

  it("never reports zero active workers when a worker's occupied-slot count is unknown", () => {
    const model = buildMobileHome(
      input({
        workers: real([
          worker({ slots: { used: missing("unknown", "Dispatch ledger unreadable."), max: 2 } }),
        ]),
      }),
    );
    expect(model.activeMission.items[0].workersActive.kind).toBe("unknown");
  });
});

describe("missions mapping", () => {
  it("renders the canonical status and derived progress only", () => {
    const model = buildMobileHome(input());
    expect(model.missions.state).toBe("CONNECTED");
    expect(model.missions.items[0]).toMatchObject({
      id: "mission-1",
      status: "running",
      attention: "none",
      progress: { completed: 1, total: 4, pct: 25 },
    });
  });

  it("distinguishes EMPTY from UNAVAILABLE and NOT_CONNECTED", () => {
    expect(buildMobileHome(input({ missions: real([]) })).missions.state).toBe("EMPTY");
    expect(
      buildMobileHome(input({ missions: missing("not_available", "out of scope") })).missions.state,
    ).toBe("UNAVAILABLE");
    expect(
      buildMobileHome(input({ missions: missing("not_connected", "no backend") })).missions.state,
    ).toBe("NOT_CONNECTED");
  });

  it("raises attention from a failed task even on a mission that is not blocked", () => {
    expect(
      buildMobileHome(
        input({ missions: real([mission({ status: "running", failed: 1, attention: true })]) }),
      ).missions.items[0].attention,
    ).toBe("blocked");
  });

  it("raises attention from the canonical mission state", () => {
    expect(
      buildMobileHome(input({ missions: real([mission({ status: "blocked", attention: true })]) }))
        .missions.items[0].attention,
    ).toBe("blocked");
    expect(
      buildMobileHome(
        input({ missions: real([mission({ status: "awaiting_approval", attention: true })]) }),
      ).missions.items[0].attention,
    ).toBe("needs_review");
  });
});

describe("worker mapping", () => {
  it("maps registry truth: health, model, provider, capacity and current dispatch", () => {
    const model = buildMobileHome(
      input({
        workers: real([
          worker({
            assignments: [
              {
                missionId: "mission-1",
                missionTaskId: "mt-1",
                taskId: "task-1",
                attempt: 1,
                state: "dispatched",
                dispatchedAt: null,
                failureClass: null,
                lastError: null,
              },
            ],
          }),
        ]),
      }),
    );
    expect(model.workers.state).toBe("CONNECTED");
    const row = model.workers.items[0];
    expect(row.health).toBe("healthy");
    expect(row.model).toMatchObject({ kind: "real", value: "claude-opus-5" });
    expect(row.provider).toMatchObject({ kind: "real", value: "anthropic" });
    expect(row.slots).toMatchObject({ max: 2 });
    expect(row.currentTask).toMatchObject({
      kind: "real",
      value: { missionId: "mission-1", taskId: "task-1", state: "dispatched", others: 0 },
    });
    expect(row.routable).toBe(true);
  });

  it("keeps an UNKNOWN worker unknown — a registered worker is not a healthy one", () => {
    const model = buildMobileHome(
      input({
        workers: real([
          worker({
            health: "unknown",
            probe: { outcome: "never", at: null, ageMs: null },
            routable: false,
          }),
        ]),
      }),
    );
    const row = model.workers.items[0];
    expect(row.health).toBe("unknown");
    expect(row.probeOutcome).toBe("never");
    expect(row.routable).toBe(false);
  });

  it("does not record a declared model as verified when the registry has none", () => {
    const model = buildMobileHome(
      input({
        workers: real([worker({ model: missing("not_available", "no model recorded", "BR-03") })]),
      }),
    );
    expect(model.workers.items[0].model.kind).toBe("not_available");
  });

  it("is DEGRADED when the registry is real but the dispatch ledger is not", () => {
    const model = buildMobileHome(
      input({
        workers: real([
          worker({
            slots: { used: missing("unknown", "Dispatch ledger could not be read."), max: 2 },
          }),
        ]),
      }),
    );
    expect(model.workers.state).toBe("DEGRADED");
    expect(model.workers.reason).toBe("Dispatch ledger could not be read.");
  });

  it("maps the Digital Workforce census separately from the worker registry", () => {
    expect(
      buildMobileHome(input({ workforce: missing("not_connected", "lane D not wired") })).workforce
        .state,
    ).toBe("NOT_CONNECTED");
    expect(
      buildMobileHome(input({ workforce: real({ total: 2, byStatus: { active: 2 } }) })).workforce
        .items[0],
    ).toEqual({ total: 2, byStatus: { active: 2 } });
  });

  it("reports an empty registry as EMPTY, never as disconnected", () => {
    expect(buildMobileHome(input({ workers: real([]) })).workers.state).toBe("EMPTY");
  });
});

describe("activity mapping", () => {
  it("maps the durable audit timeline and caps what the phone shows", () => {
    const entries = Array.from({ length: 30 }, (_, i) =>
      timelineEntry({ id: `audit-${i}`, type: "task.completed" }),
    );
    const model = buildMobileHome(input({ timeline: real(entries), activityLimit: 5 }));
    expect(model.activity.state).toBe("CONNECTED");
    expect(model.activity.items).toHaveLength(5);
    expect(model.activity.items[0]).toMatchObject({
      type: "task.completed",
      actor: "owner@example.com",
      actorKind: "human",
    });
  });

  it("stays UNAVAILABLE when the audit timeline is permission-gated", () => {
    const model = buildMobileHome(
      input({ timeline: missing("not_available", "requires audit.read.full") }),
    );
    expect(model.activity.state).toBe("UNAVAILABLE");
    expect(model.activity.items).toEqual([]);
  });

  it("is EMPTY when the audit log answered with nothing", () => {
    expect(buildMobileHome(input({ timeline: real([]) })).activity.state).toBe("EMPTY");
  });
});

describe("approvals mapping", () => {
  it("maps every pending action, including one not flagged requiresHumanApproval", () => {
    const model = buildMobileHome(
      input({ approvals: real([approval(), approval({ id: "action-2", risk: "reversible" })]) }),
    );
    expect(model.approvals.state).toBe("CONNECTED");
    expect(model.approvals.items.map((a) => a.id)).toEqual(["action-1", "action-2"]);
  });

  it("does not report a zero count when the action source is unavailable", () => {
    const model = buildMobileHome(
      input({ approvals: missing("unknown", "Approvals could not be read from ICOS.") }),
    );
    expect(model.approvals.state).toBe("UNKNOWN");
    expect(model.approvals.items).toEqual([]);
  });

  it("carries the decider permissions so a read-only session gets no control", () => {
    expect(buildMobileHome(input({ canDecideApprovals: false })).canDecideApprovals).toBe(false);
    expect(buildMobileHome(input({ canDecideProposals: false })).canDecideProposals).toBe(false);
    expect(buildMobileHome(input({ canConverse: false })).canConverse).toBe(false);
  });
});

describe("incident and proposal mapping", () => {
  const alert = (over: Partial<Alert> = {}): Alert => ({
    id: "alert-1",
    category: "MISSION",
    severity: "P0",
    title: "Mission bloquée",
    detail: "mission-1 est bloquée",
    at: "2026-09-30T09:30:00.000Z",
    ...over,
  });

  it("merges derived alerts with open supervisor problems", () => {
    const model = buildMobileHome(input({ alerts: [alert()], supervisor: real([situation()]) }));
    expect(model.incidents.state).toBe("CONNECTED");
    expect(model.incidents.items.map((i) => i.source)).toEqual(["alert", "supervisor"]);
    expect(model.incidents.items[0].severity).toBe("critical");
    expect(model.incidents.items[1].title).toContain("INVOICE_OVERDUE");
  });

  it("drops cockpit-only (P2) alerts and terminal or non-problem situations", () => {
    const model = buildMobileHome(
      input({
        alerts: [alert({ severity: "P2" })],
        supervisor: real([
          situation({ id: "s-closed", state: "resolved" }),
          situation({ id: "s-info", kind: "information" }),
        ]),
      }),
    );
    expect(model.incidents.state).toBe("EMPTY");
  });

  it("is DEGRADED when alerts are real but the supervisor could not be read", () => {
    const model = buildMobileHome(
      input({ alerts: [alert()], supervisor: missing("unknown", "supervisor store unreachable") }),
    );
    expect(model.incidents.state).toBe("DEGRADED");
    expect(model.incidents.items).toHaveLength(1);
  });

  it("is UNAVAILABLE — never an empty list — when the supervisor is out of scope", () => {
    const model = buildMobileHome(
      input({ supervisor: missing("not_available", "owner/admin scope only") }),
    );
    expect(model.incidents.state).toBe("UNAVAILABLE");
    expect(model.proposals.state).toBe("UNAVAILABLE");
  });

  it("maps supervisor proposals verbatim, with no decision invented here", () => {
    const model = buildMobileHome(
      input({
        supervisor: real([
          situation({
            proposal: {
              action: "payment_reminder",
              desiredOutcome: "Relancer la facture INV-7",
              reason: "échue depuis 12 jours",
              risk: "reversible",
              urgency: "high",
              state: "awaiting_human",
            },
            clientScope: "lds-renov",
          }),
        ]),
      }),
    );
    expect(model.proposals.state).toBe("CONNECTED");
    expect(model.proposals.items[0]).toMatchObject({
      title: "payment_reminder",
      description: "Relancer la facture INV-7",
      state: "awaiting_human",
      cssState: "awaiting_approval",
      // The digest spans every client of the tenant: say which one this is.
      scope: "lds-renov",
    });
  });

  it("reports no supervisor proposal as EMPTY", () => {
    expect(buildMobileHome(input({ supervisor: real([situation()]) })).proposals.state).toBe(
      "EMPTY",
    );
  });
});

describe("health", () => {
  it("passes the canonical health level through without upgrading UNKNOWN", () => {
    const model = buildMobileHome(
      input({ health: { level: "unknown", reasons: ["no worker evidence"] } }),
    );
    expect(model.health).toEqual({ level: "unknown", reasons: ["no worker evidence"] });
  });
});
