import { describe, expect, it, vi } from "vitest";

import {
  InMemoryImprovementBacklog,
  createImprovementCandidate,
  type ImprovementCandidate,
} from "@/core/autonomy/improvement-backlog";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryGoalRepository } from "@/server/services/in-memory/goal-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { SelfDevelopmentChain, selfDevelopmentIds } from "./self-development-chain";

/*
 * DEFECT 25 LINK 1 — ONE owner for candidate -> goal -> mission -> plan.
 *
 * Nothing owned this chain: the self-development coordinator took missionId/taskId as INPUT,
 * so self-development could never START from an intent. These pin the owner AND, just as
 * hard, that it owns the chain without reimplementing any link of it.
 */

function candidate(over: Partial<Parameters<typeof createImprovementCandidate>[0]> = {}) {
  return createImprovementCandidate({
    title: "Reap stale worker branches",
    description: "Add a sweeper for abandoned icos/worker branches",
    rationale: "They accumulate and obscure real work",
    category: "maintainability",
    targetComponent: "src/server/workspace-manager",
    priority: "medium",
    proposedBy: "icos-observer",
    ...over,
  });
}

function harness(seed: ImprovementCandidate[] = []) {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit);
  const missions = new InMemoryMissionRepository(tasks);
  const goals = new InMemoryGoalRepository(audit);
  const backlog = new InMemoryImprovementBacklog();

  /*
   * The planner is CALLED, never reimplemented. A spy proves the chain hands off to the
   * canonical planning authority rather than fabricating a plan of its own.
   */
  const plan = vi.fn(async () => ({
    version: 1 as const,
    tasks: [
      {
        key: "t1",
        title: "Implement the sweeper",
        description: "Add it",
        dependsOn: [],
        riskClass: "reversible" as const,
        allowedFileScope: ["src/server/workspace-manager/**"],
      },
    ],
  }));

  /* The REAL in-memory runtime repository: ignition's own state machine is not stubbed. */
  const runtimeRepository = new InMemoryAutonomousMissionRuntimeRepository();

  const chain = new SelfDevelopmentChain({
    backlog,
    goals,
    ignite: {
      missions,
      runtimeRepository,
      supervisor: { run: vi.fn(async () => undefined), reconcilePreparedDispatches: vi.fn(async () => undefined) } as never,
      planner: { plan } as never,
    },
  });

  return { chain, backlog, goals, missions, plan, runtimeRepository, seed };
}

async function seeded(over: Parameters<typeof candidate>[0] = {}) {
  const h = harness();
  const c = candidate(over);
  await h.backlog.add(c);
  return { ...h, candidate: c };
}

describe("DEFECT 25 LINK 1 — self-development chain owner", () => {
  it("TURNS A CANDIDATE INTO goal -> mission -> plan through the CANONICAL services", async () => {
    const h = await seeded();

    const outcome = await h.chain.advance();

    expect(outcome.status).toBe("STARTED");
    if (outcome.status !== "STARTED") throw new Error("unreachable");

    /* The goal exists, carries its provenance, and is linked to the mission. */
    const stored = await h.goals.getById(outcome.goalId);
    expect(stored?.goal.metadata).toMatchObject({
      source: "self-development",
      candidateId: h.candidate.id,
    });

    /* The mission exists and carries the goal — lineage, not a detached mission. */
    const mission = await h.missions.findById(outcome.missionId);
    expect(mission?.goalId).toBe(outcome.goalId);

    /* The CANONICAL planner was invoked; no plan was fabricated here. */
    expect(h.plan).toHaveBeenCalledTimes(1);
  });

  it("IDENTITY IS DERIVED from the candidate, so a retry computes the SAME ids", () => {
    const a = selfDevelopmentIds(candidate());
    const b = selfDevelopmentIds(candidate());
    expect(a).toEqual(b);
    expect(a.goalId).toMatch(/^sd-goal-[0-9a-f]{16}$/);
    expect(a.missionId).toMatch(/^sd-mission-[0-9a-f]{16}$/);

    /* A DIFFERENT improvement is a different chain. */
    const other = selfDevelopmentIds(candidate({ title: "Something else entirely" }));
    expect(other.goalId).not.toBe(a.goalId);
  });

  it("DUPLICATE INVOCATION creates NO second goal, mission or plan", async () => {
    const h = await seeded();

    const first = await h.chain.advance();
    const second = await h.chain.advance();

    expect(first.status).toBe("STARTED");
    expect(second.status).toBe("STARTED");
    if (first.status !== "STARTED" || second.status !== "STARTED") throw new Error("unreachable");

    /* Same chain, and the second call knows it reused rather than created. */
    expect(second.goalId).toBe(first.goalId);
    expect(second.missionId).toBe(first.missionId);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);

    /*
     * The decisive assertion: exactly ONE mission exists. A second would mean the same
     * improvement was being worked twice, on two branches, competing to integrate.
     */
    const all = await h.missions.list();
    expect(all.filter((m) => m.id === first.missionId)).toHaveLength(1);
  });

  it("RESTART-SAFE: a NEW chain instance reuses the existing goal and mission", async () => {
    const h = await seeded();
    const first = await h.chain.advance();
    if (first.status !== "STARTED") throw new Error("unreachable");

    /*
     * A restarted process: new chain object, nothing in memory. Idempotence survives only
     * because the ids are DERIVED from the candidate rather than generated and remembered.
     */
    const restarted = new SelfDevelopmentChain({
      backlog: h.backlog,
      goals: h.goals,
      ignite: {
        missions: h.missions,
        runtimeRepository: h.runtimeRepository,
        supervisor: { run: vi.fn(async () => undefined), reconcilePreparedDispatches: vi.fn(async () => undefined) } as never,
        planner: { plan: h.plan } as never,
      },
    });

    const again = await restarted.advance();
    if (again.status !== "STARTED") throw new Error("unreachable");
    expect(again.goalId).toBe(first.goalId);
    expect(again.missionId).toBe(first.missionId);
    expect(again.created).toBe(false);
  });

  it("RECORDS SELECTION EVIDENCE durably, before any mission exists", async () => {
    const h = await seeded();

    await h.chain.advance();

    const stored = await h.backlog.get(h.candidate.id);
    /*
     * Evidence first: if the process dies after this, the backlog already says this
     * candidate was chosen and why, so a restart does not silently pick a different one.
     */
    expect(stored?.status).toBe("under_review");
    expect(stored?.reviewNotes).toContain("selected for self-development");
    expect(stored?.reviewNotes).toContain(selfDevelopmentIds(h.candidate).missionId);
  });

  it("PRIORITISES using the backlog's OWN ordering, not a new score", async () => {
    const h = harness();
    await h.backlog.add(candidate({ title: "Low priority work", priority: "low" }));
    const critical = candidate({ title: "Critical security fix", priority: "critical" });
    await h.backlog.add(critical);

    const outcome = await h.chain.advance();

    if (outcome.status !== "STARTED") throw new Error("unreachable");
    expect(outcome.candidate.id).toBe(critical.id);
  });

  it("IN-FLIGHT WORK IS RESUMED BEFORE NEW WORK IS STARTED", async () => {
    const h = await seeded();
    const started = await h.chain.advance();
    if (started.status !== "STARTED") throw new Error("unreachable");

    /* A more urgent candidate arrives while the first is still in flight. */
    const urgent = candidate({ title: "Urgent new thing", priority: "critical" });
    await h.backlog.add(urgent);

    const next = await h.chain.advance();
    if (next.status !== "STARTED") throw new Error("unreachable");

    /*
     * The in-flight improvement wins despite the lower priority. Starting the urgent one now
     * would strand the first mid-flight and put two self-development missions in play at once.
     */
    expect(next.candidate.id).toBe(started.candidate.id);
  });

  it("AN EMPTY BACKLOG IS NOT AN ERROR — there is simply nothing to do", async () => {
    const h = harness();
    const outcome = await h.chain.advance();
    expect(outcome.status).toBe("NO_CANDIDATE");
  });

  it("AN UNKNOWN CANDIDATE ID FAILS CLOSED rather than selecting something else", async () => {
    const h = await seeded();
    const outcome = await h.chain.advance("imp-does-not-exist");
    /* Silently substituting a different improvement would be the worst possible answer. */
    expect(outcome.status).toBe("NO_CANDIDATE");
  });
});

describe("objective — the target path the planner must scope to", () => {
  const objectiveFor = async (targetComponent: string) => {
    const h = await seeded({ targetComponent });
    const outcome = await h.chain.advance();
    if (outcome.status !== "STARTED") throw new Error("unreachable");
    return (await h.missions.findById(outcome.missionId))!.objective;
  };

  it("A DIRECTORY TARGET IS WRITTEN AS A DIRECTORY", async () => {
    /*
     * The scope matcher compiles `docs` to `^docs$` — a FILE named `docs`, nothing inside
     * it — while `docs/` expands to `docs/**`. The planner reproduces this path verbatim in
     * `allowedFileScope`, so a bare directory name fences the writer out of the very place
     * it was asked to write.
     */
    expect(await objectiveFor("docs")).toContain("Target path: docs/");
    expect(await objectiveFor("src/server/autonomy")).toContain(
      "Target path: src/server/autonomy/",
    );
  });

  it("A FILE TARGET IS LEFT EXACTLY AS DECLARED", async () => {
    expect(await objectiveFor("src/core/context/contracts.ts")).toContain(
      "Target path: src/core/context/contracts.ts",
    );
  });
});
