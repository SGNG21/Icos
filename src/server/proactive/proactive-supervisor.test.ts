import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_INITIATIVE_POLICY, DEFAULT_RELEVANCE_RULES } from "@/core/supervisor/defaults";
import { assess, attentionFor, resolveInitiative } from "@/core/supervisor/policy";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";

import { MissionSubjectStatus } from "./adapters";
import {
  MIN_OBSERVATION_INTERVAL_MS,
  SUPERVISOR_OBSERVE_JOB_KIND,
  createObservationHandler,
  seedObservation,
} from "./observations";
import { describeProactiveSupervisorContract, ev, harness } from "./proactive-supervisor.contract";
import { InMemorySupervisorStore } from "./store";

describeProactiveSupervisorContract("in-memory", async () => new InMemorySupervisorStore());

describe("initiative policy resolution", () => {
  const policy = {
    ...DEFAULT_INITIATIVE_POLICY,
    rules: [
      { domain: "finance", level: "PROPOSE" as const },
      { domain: "finance", clientScope: "client-a", level: "EXECUTE_BOUNDED" as const },
      { domain: "finance", action: "payment_reminder", level: "NOTIFY" as const },
    ],
  };

  it("varies by domain, client and action — most specific wins, ties go to the more restrictive", () => {
    expect(resolveInitiative(policy, { domain: "finance" }).level).toBe("PROPOSE");
    expect(resolveInitiative(policy, { domain: "finance", clientScope: "client-a" }).level).toBe(
      "EXECUTE_BOUNDED",
    );
    expect(
      resolveInitiative(policy, {
        domain: "finance",
        action: "payment_reminder",
        clientScope: "client-a",
      }).level,
    ).toBe("NOTIFY");
    expect(resolveInitiative(policy, { domain: "hr" }).level).toBe("UNKNOWN");
  });

  it("a HUMAN_REQUIRED rule clamps its scope even against a more specific EXECUTE rule", () => {
    const p = {
      ...policy,
      rules: [
        { domain: "legal", level: "HUMAN_REQUIRED" as const },
        {
          domain: "legal",
          clientScope: "client-a",
          action: "sign",
          level: "EXECUTE_BOUNDED" as const,
        },
      ],
    };
    expect(
      resolveInitiative(p, { domain: "legal", clientScope: "client-a", action: "sign" }).level,
    ).toBe("HUMAN_REQUIRED");
  });

  it("rejects two relevance rules for one event type", () => {
    const rule = DEFAULT_RELEVANCE_RULES[0];
    expect(() => harness(new InMemorySupervisorStore(), { rules: [rule, rule] })).toThrow(
      "SUPERVISOR_DUPLICATE_RELEVANCE_RULE",
    );
  });

  it("clamps a human-required domain whatever the rules say", () => {
    const p = {
      ...policy,
      rules: [...policy.rules, { domain: "security", level: "EXECUTE_BOUNDED" as const }],
    };
    expect(resolveInitiative(p, { domain: "security" }).level).toBe("HUMAN_REQUIRED");
  });

  it("caps a low-confidence observation at NOTIFY", () => {
    const rule = DEFAULT_RELEVANCE_RULES.find((r) => r.eventType === "SITE_HEALTH_FAILURE")!;
    const base = {
      rule,
      policy: {
        ...DEFAULT_INITIATIVE_POLICY,
        rules: [{ domain: "web.operations", level: "EXECUTE_BOUNDED" as const }],
      },
      subjectTerminal: false,
      openSituation: null,
      lastTerminal: null,
      newSituationsLastHour: 0,
      executionsLastHour: 0,
      now: new Date(),
    };
    const event = {
      ...ev(),
      summary: {},
      sensitivity: "internal" as const,
      confidence: 0.3,
    } as Parameters<typeof assess>[0]["event"];
    expect(assess({ ...base, event })).toMatchObject({
      disposition: "NOTIFY",
      reasons: ["LOW_CONFIDENCE"],
    });
    expect(assess({ ...base, event: { ...event, confidence: 1 } }).disposition).toBe(
      "CREATE_BOUNDED_GOAL",
    );
  });

  it("never acts in a domain another runtime owns, even with an action and execution authority", () => {
    const owned = {
      ...DEFAULT_RELEVANCE_RULES.find((r) => r.eventType === "SITE_HEALTH_FAILURE")!,
      owner: "compute-routing",
    };
    const decision = assess({
      event: { ...ev(), summary: {}, sensitivity: "internal", confidence: 1 } as Parameters<
        typeof assess
      >[0]["event"],
      rule: owned,
      policy: {
        ...DEFAULT_INITIATIVE_POLICY,
        rules: [{ domain: "web.operations", level: "EXECUTE_BOUNDED" }],
      },
      subjectTerminal: false,
      openSituation: null,
      lastTerminal: null,
      newSituationsLastHour: 0,
      executionsLastHour: 0,
      now: new Date(),
    });
    expect(decision).toMatchObject({
      disposition: "NOTIFY",
      reasons: ["OWNED_BY:compute-routing"],
    });
  });

  it("never pushes RECORD_ONLY, and a pending human decision is never quieter than ACTIONABLE", () => {
    expect(attentionFor("RECORD_ONLY", "critical")).toBeNull();
    expect(attentionFor("PROPOSE_ACTION", "low")).toBe("ACTIONABLE");
    expect(attentionFor("NOTIFY", "low")).toBe("INFO");
  });
});

describe("mission subject status", () => {
  it("treats succeeded/failed/cancelled missions as terminal, and nothing else", async () => {
    const statuses: Record<string, string> = { m1: "succeeded", m2: "running", m3: "cancelled" };
    const port = new MissionSubjectStatus({
      findById: async (id: string) => (statuses[id] ? ({ status: statuses[id] } as never) : null),
    });
    expect(await port.isTerminal("mission:m1")).toBe(true);
    expect(await port.isTerminal("mission:m2")).toBe(false);
    expect(await port.isTerminal("mission:m3")).toBe(true);
    expect(await port.isTerminal("mission:unknown")).toBe(false);
    expect(await port.isTerminal("site:x")).toBe(false);
  });
});

describe("scheduled observations on the canonical durable scheduler", () => {
  const schedule = { observationKey: "uptime", tenantId: "tenant-a", intervalMs: 5 * 60_000 };

  it("refuses high-frequency polling", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    await expect(
      seedObservation(jobs, { ...schedule, intervalMs: MIN_OBSERVATION_INTERVAL_MS - 1 }),
    ).rejects.toThrow("SUPERVISOR_OBSERVATION_INTERVAL_TOO_SHORT");
  });

  it("ignition is idempotent: every boot and replica computes the same occurrence", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const now = new Date("2026-09-29T22:01:00Z");
    expect((await seedObservation(jobs, schedule, now)).created).toBe(true);
    expect((await seedObservation(jobs, schedule, new Date(now.getTime() + 30_000))).created).toBe(
      false,
    );
  });

  it("a run observes, ingests, and schedules exactly one next occurrence", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const store = new InMemorySupervisorStore();
    const { supervisor } = harness(store);
    let observed = 0;
    const handler = createObservationHandler({
      supervisor,
      jobs,
      sources: {
        uptime: {
          observe: async ({ tenantId }) => {
            observed += 1;
            return [
              ev({ tenantId, dedupKey: "check-1", origin: "scheduled" }),
              ev({ tenantId: "tenant-other", dedupKey: "escape" }), // a source cannot write elsewhere
            ];
          },
        },
      },
    });
    const scheduler = new DurableScheduler(jobs, { [SUPERVISOR_OBSERVE_JOB_KIND]: handler });
    await seedObservation(jobs, schedule, new Date(Date.now() - schedule.intervalMs));
    const sweep = await scheduler.sweep();
    expect(sweep).toMatchObject({ discovered: 1, succeeded: 1 });
    expect(observed).toBe(1);
    const digest = await supervisor.digest("tenant-a", {
      since: new Date(0),
      until: new Date(Date.now() + 1e7),
    });
    expect(digest.eventCount).toBe(1);
    expect(
      (
        await supervisor.digest("tenant-other", {
          since: new Date(0),
          until: new Date(Date.now() + 1e7),
        })
      ).eventCount,
    ).toBe(0);
    // Next occurrence exists once (a second enqueue of the same instant is refused as a duplicate).
    expect((await seedObservation(jobs, schedule)).created).toBe(false);
  });

  it("a failing source or a malformed observation never kills the recurrence", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const { supervisor } = harness(new InMemorySupervisorStore());
    let calls = 0;
    const handler = createObservationHandler({
      supervisor,
      jobs,
      sources: {
        uptime: {
          observe: async ({ tenantId }) => {
            calls += 1;
            if (calls === 1) throw new Error("source down");
            return [{ ...ev({ tenantId }), type: "not-upper" }, ev({ tenantId, dedupKey: "good" })];
          },
        },
      },
    });
    const scheduler = new DurableScheduler(jobs, { [SUPERVISOR_OBSERVE_JOB_KIND]: handler });
    await seedObservation(jobs, schedule, new Date(Date.now() - schedule.intervalMs));
    expect(await scheduler.sweep()).toMatchObject({ failed: 1 });
    // The successor was enqueued before the source failed.
    expect((await seedObservation(jobs, schedule)).created).toBe(false);

    const result = await handler(
      { payload: { ...schedule, scheduledFor: new Date().toISOString() } } as never,
      { signal: new AbortController().signal },
    );
    expect(result).toMatchObject({ observed: 2, recorded: 1, rejected: 1 });
  });

  it("an unknown observation source is a permanent failure, not a silent success", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const handler = createObservationHandler({
      supervisor: harness(new InMemorySupervisorStore()).supervisor,
      jobs,
      sources: {},
    });
    const scheduler = new DurableScheduler(jobs, { [SUPERVISOR_OBSERVE_JOB_KIND]: handler });
    await seedObservation(
      jobs,
      { ...schedule, observationKey: "nope" },
      new Date(Date.now() - schedule.intervalMs),
    );
    expect(await scheduler.sweep()).toMatchObject({ discovered: 1, failed: 1 });
    expect(await jobs.claimDue("probe", 1_000)).toBeNull(); // dead, never retried, no successor
  });
});

describe("architecture boundary", () => {
  it("the supervisor never imports a connector, a tool client, a worker or the mission runner", () => {
    const dir = join(process.cwd(), "src/server/proactive");
    const sources = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".contract."))
      .concat(
        readdirSync(join(process.cwd(), "src/core/supervisor")).map(
          (f) => `../../core/supervisor/${f}`,
        ),
      )
      .map((f) => readFileSync(join(dir, f), "utf8"));
    const forbidden =
      /from "[^"]*(gmail|browser|connectors|tool-gateway\/|workers\/execution|autonomous-mission-runner|ignite-autonomous-mission|mission-service|dispatch)[^"]*"/i;
    for (const source of sources) expect(source).not.toMatch(forbidden);
  });
});
