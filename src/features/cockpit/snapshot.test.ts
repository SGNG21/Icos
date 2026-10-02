import { describe, expect, it } from "vitest";

import type { AuditEntry, Task } from "@/core/contracts";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { Mission, MissionTask } from "@/core/mission/contracts";

import { buildCockpitSnapshot, safeMetadata, type CockpitSources } from "./snapshot";
import { missing, real } from "./truth";

// Test fixtures only — never imported by production code.
const NOW = new Date("2026-09-28T12:00:00Z");

function worker(id: string, over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry {
  return {
    id,
    workerKind: "hermes",
    displayName: `W-${id.slice(0, 4)}`,
    capabilities: [],
    features: [],
    supportsTools: false,
    supportsStructuredOutput: false,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata: {},
    lastProbeAt: "2026-09-28T11:59:00Z",
    lastProbeOutcome: "ok",
    maxConcurrency: 2,
    capacityPool: null,
    capacityPoolLimit: null,
    updatedAt: "2026-09-28T11:59:00Z",
    ...over,
  };
}

const mission = (id: string, status: Mission["status"]): Mission => ({
  id,
  title: `Mission ${id}`,
  objective: "o",
  status,
  createdAt: NOW,
  updatedAt: NOW,
});
const mt = (
  id: string,
  missionId: string,
  status: MissionTask["status"],
  dependsOn: string[] = [],
): MissionTask => ({
  id,
  missionId,
  title: id,
  dependsOn,
  status,
  taskId: `t-${id}`,
});

function sources(over: Partial<CockpitSources> = {}): CockpitSources {
  return {
    now: NOW,
    backend: "postgres",
    scope: "global",
    tasks: real([]),
    missions: real([]),
    workers: real([]),
    activeAssignments: real([]),
    attempts: real([]),
    pendingApprovals: real(0),
    audit: real([]),
    qualityJobs: real([]),
    escalatedJobs: real(0),
    workspaces: real([]),
    ...over,
  };
}

describe("buildCockpitSnapshot — data honesty", () => {
  it("never fabricates telemetry, cost or autonomy", () => {
    const snap = buildCockpitSnapshot(sources());
    for (const key of [
      "autonomyLevel",
      "providerHealth",
      "cost",
      "tokenThroughput",
      "latency",
    ] as const) {
      expect(snap.metrics[key].kind).toBe("not_available");
    }
    expect(snap.metrics.cost).toMatchObject({ requirement: "BR-05" });
  });

  it("propagates an unreadable source as UNKNOWN instead of zero", () => {
    const snap = buildCockpitSnapshot(sources({ missions: missing("unknown", "db down") }));
    expect(snap.metrics.activeMissions).toEqual({ kind: "unknown", reason: "db down" });
    expect(snap.missions.kind).toBe("unknown");
    expect(snap.alerts.some((a) => a.id === "source-missions" && a.category === "RECOVERY")).toBe(
      true,
    );
    expect(snap.health.level).toBe("degraded");
  });

  it("reports health UNKNOWN when there is no worker evidence", () => {
    const snap = buildCockpitSnapshot(sources());
    expect(snap.health.level).toBe("unknown");
    expect(snap.metrics.globalHealth.kind).toBe("unknown");
  });

  it("is healthy only with a routable, freshly probed worker", () => {
    expect(buildCockpitSnapshot(sources({ workers: real([worker("a1")]) })).health.level).toBe(
      "healthy",
    );
    const stale = buildCockpitSnapshot(
      sources({ workers: real([worker("a1", { lastProbeOutcome: "stale" })]) }),
    );
    expect(stale.health.level).toBe("unknown");
    expect(stale.alerts[0]).toMatchObject({ category: "WORKER", severity: "P2" });
  });

  it("flags the in-memory demo backend", () => {
    const snap = buildCockpitSnapshot(sources({ backend: "memory" }));
    expect(snap.alerts[0]).toMatchObject({ id: "backend-memory", category: "CRITICAL" });
  });

  it("raises P0 when work is ready but no worker is routable", () => {
    const snap = buildCockpitSnapshot(
      sources({
        workers: real([worker("a1", { health: "unhealthy" })]),
        missions: real([{ mission: mission("m1", "running"), tasks: [mt("x", "m1", "queued")] }]),
      }),
    );
    expect(snap.alerts.find((a) => a.category === "CAPACITY")?.severity).toBe("P0");
    expect(snap.health.level).toBe("critical");
    expect(snap.metrics.mustNow).toMatchObject({ kind: "real", value: 1 });
    expect(snap.metrics.readyQueue).toMatchObject({ kind: "real", value: 1 });
  });

  it("makes pending approvals a P0 governance item without calling the system unhealthy", () => {
    const snap = buildCockpitSnapshot(
      sources({ workers: real([worker("a1")]), pendingApprovals: real(2) }),
    );
    expect(snap.alerts[0]).toMatchObject({ category: "GOVERNANCE", severity: "P0" });
    expect(snap.health.level).toBe("healthy");
  });
});

describe("workers", () => {
  it("keeps worker, model, provider, account and slots distinct", () => {
    const w = worker("a1", {
      metadata: { model: "nemotron-120b", apiKey: "sk-live", provider: "nvidia" },
    });
    const attempt = {
      id: "d1",
      missionId: "m1",
      missionTaskId: "x",
      taskId: "t-x",
      attempt: 2,
      workflowId: "wf",
      prompt: "p",
      workerId: "a1",
      state: "dispatched",
      createdAt: NOW,
      updatedAt: NOW,
    } as DispatchAttempt;
    const snap = buildCockpitSnapshot(
      sources({
        workers: real([w]),
        activeAssignments: real(["a1", "a1"]),
        attempts: real([attempt]),
      }),
    );
    if (snap.workers.kind !== "real") throw new Error("expected workers");
    const [view] = snap.workers.value;
    expect(view.model).toMatchObject({ kind: "real", value: "nemotron-120b" });
    expect(view.account).toMatchObject({ kind: "not_available", requirement: "BR-03" });
    expect(view.slots).toEqual({
      used: { kind: "real", value: 2, derivation: expect.any(String) },
      max: 2,
    });
    expect(view.metadata).not.toHaveProperty("apiKey");
    expect(view.assignments[0]).toMatchObject({ missionId: "m1", attempt: 2 });
    expect(snap.metrics.activeWorkers).toMatchObject({ kind: "real", value: 1 });
  });

  it("displays allowlisted metadata only and counts the rest", async () => {
    const { hiddenMetadataCount } = await import("./snapshot");
    const meta = {
      region: "eu",
      token: "x",
      DB_PASSWORD: "y",
      privateKeyPath: "z",
      note: "free text",
      modelFamily: "NEMOTRON_120B",
    };
    expect(safeMetadata(meta)).toEqual({ region: "eu", modelFamily: "NEMOTRON_120B" });
    expect(hiddenMetadataCount(meta)).toBe(4);
  });

  it("handles 100 workers without degrading", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      worker(`${String(i).padStart(8, "0")}-w`, { health: i % 7 ? "healthy" : "degraded" }),
    );
    const started = performance.now();
    const snap = buildCockpitSnapshot(
      sources({ workers: real(many), activeAssignments: real(many.map((w) => w.id)) }),
    );
    expect(performance.now() - started).toBeLessThan(100);
    expect(snap.workers.kind === "real" && snap.workers.value.length).toBe(100);
    expect(snap.domains.find((d) => d.key === "workers")!.tone).toBe("warn");
  });

  it("does not show workers outside the caller's scope", () => {
    const snap = buildCockpitSnapshot(
      sources({ scope: "linked", workers: missing("not_available", "outside scope") }),
    );
    expect(snap.workers.kind).toBe("not_available");
    expect(snap.metrics.globalHealth.kind).toBe("unknown");
  });
});

describe("missions, focus and timeline", () => {
  it("picks the mission needing attention as the critical-path focus", () => {
    const snap = buildCockpitSnapshot(
      sources({
        missions: real([
          {
            mission: mission("m1", "running"),
            tasks: [
              mt("a", "m1", "queued"),
              mt("b", "m1", "queued", ["a"]),
              mt("c", "m1", "queued", ["b"]),
            ],
          },
          {
            mission: mission("m2", "blocked"),
            tasks: [mt("z", "m2", "failed"), mt("y", "m2", "queued", ["z"])],
          },
        ]),
      }),
    );
    expect(snap.focus?.missionId).toBe("m2");
    expect(snap.missions.kind === "real" && snap.missions.value[0].id).toBe("m2");
  });

  it("orders the timeline newest first and counts human interventions", () => {
    const entry = (id: string, at: string, kind: "human" | "system", type = "task.transitioned") =>
      ({
        id,
        occurredAt: at,
        createdAt: at,
        eventType: type,
        actor: { kind, id: kind },
        details: {},
      }) as AuditEntry;
    const snap = buildCockpitSnapshot(
      sources({
        audit: real([
          entry("1", "2026-09-28T10:00:00Z", "human"),
          entry("2", "2026-09-28T11:00:00Z", "system"),
          entry("3", "2026-09-28T09:00:00Z", "human", "auth.login.succeeded"),
          entry("4", "2026-09-20T09:00:00Z", "human"),
        ]),
      }),
    );
    expect(snap.timeline.kind === "real" && snap.timeline.value.map((e) => e.id)).toEqual([
      "2",
      "1",
      "3",
      "4",
    ]);
    expect(snap.metrics.humanInterventions).toMatchObject({ kind: "real", value: 1 });
  });

  it("counts review backlog from canonical task status", () => {
    const tasks = [{ status: "review_pending" }, { status: "running" }] as Task[];
    expect(
      buildCockpitSnapshot(sources({ tasks: real(tasks) })).metrics.reviewBacklog,
    ).toMatchObject({ value: 1 });
  });
});

describe("health rationale", () => {
  it("names active workers without evidence even when overall health is green", async () => {
    const { deriveHealth } = await import("./snapshot");
    const w = (tone: "ok" | "unknown", routable: boolean) =>
      ({ status: "active", tone, routable }) as never;
    const h = deriveHealth([], [w("ok", true), w("unknown", false), w("unknown", false)]);
    expect(h.level).toBe("healthy");
    expect(h.reasons.join(" ")).toContain("2 active worker(s) have no health evidence");
  });
});

describe("metadata secret filter", () => {
  it("drops credential-looking values whatever the key", async () => {
    const { safeMetadata } = await import("./snapshot");
    expect(
      safeMetadata({
        provider: "https://user:pw@host/v1",
        region: "Bearer abc.def",
        account: "sk-abcdef1234567890",
        model: "nvidia/nemotron-3-super-120b-a12b",
        apiKey: "x",
      }),
    ).toEqual({ model: "nvidia/nemotron-3-super-120b-a12b" });
  });
});

/**
 * SAFE_WORKER_METADATA / SECRET_VALUE_NEVER_RENDERED.
 *
 * `declared()` used to read `w.metadata` RAW while the `metadata` block beside it went through
 * `safeMetadata`. A `model`/`provider`/`account` value that looks like a credential was
 * therefore filtered out of the metadata list and then rendered anyway as the worker's
 * declared model, provider or account.
 */
describe("worker read model uses sanitized metadata only", () => {
  const CREDENTIALS = {
    model: "sk-abcdef1234567890",
    provider: "https://user:pw@internal-host/v1",
    account: "Bearer abc.def.ghi",
  } as const;

  it("never renders a credential-looking model, provider or account", () => {
    const snap = buildCockpitSnapshot(
      sources({ workers: real([worker("aaaaaaaa-w", { metadata: { ...CREDENTIALS } })]) }),
    );
    expect(snap.workers.kind).toBe("real");
    if (snap.workers.kind !== "real") return;
    const view = snap.workers.value[0];

    for (const field of ["model", "provider", "account"] as const) {
      expect(view[field].kind, field).toBe("not_available");
    }
    const rendered = JSON.stringify(view);
    for (const secret of Object.values(CREDENTIALS)) {
      expect(rendered).not.toContain(secret);
    }
    expect(view.metadata).toEqual({});
    expect(view.metadataHidden).toBe(3);
  });

  it("still exposes a safe model and provider to an authorized reader", () => {
    const direct = buildCockpitSnapshot(
      sources({
        workers: real([
          worker("bbbbbbbb-w", {
            metadata: {
              model: "nvidia/nemotron-3-super-120b-a12b",
              provider: "omniroute",
              account: "holding-ia",
            },
          }),
        ]),
      }),
    );
    expect(direct.workers.kind).toBe("real");
    if (direct.workers.kind !== "real") return;
    const view = direct.workers.value[0];
    expect(view.model).toMatchObject({ kind: "real", value: "nvidia/nemotron-3-super-120b-a12b" });
    expect(view.provider).toMatchObject({ kind: "real", value: "omniroute" });
    expect(view.account).toMatchObject({ kind: "real", value: "holding-ia" });
    expect(view.metadataHidden).toBe(0);
  });

  it("a secret hidden behind a non-allowlisted key is never surfaced either", () => {
    const snap = buildCockpitSnapshot(
      sources({
        workers: real([
          worker("cccccccc-w", {
            metadata: { OMNIROUTE_API_KEY: "sk-deadbeef12345678", note: "https://u:p@h/x" },
          }),
        ]),
      }),
    );
    if (snap.workers.kind !== "real") throw new Error("expected workers");
    const rendered = JSON.stringify(snap.workers.value[0]);
    expect(rendered).not.toContain("sk-deadbeef12345678");
    expect(rendered).not.toContain("u:p@h");
  });
});

describe("error text exposure", () => {
  it("raw error text reaches owner/admin scope only, truncated", async () => {
    const { redactError } = await import("./snapshot");
    expect(redactError("x".repeat(500), true)).toHaveLength(200);
    expect(redactError("provider https://internal/v1 failed", false)).toBeUndefined();
    expect(redactError(undefined, true)).toBeUndefined();
  });
});
