import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { CognitionOutput, MemoryCandidate } from "@/core/cognitive/contracts";
import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { ExecutionScopeReader } from "@/server/execution/execution-scope-reader";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { SupervisorService } from "@/server/supervisor/supervisor-service";

import { OWNER_STATEMENT_2026_10_11, seedClientDirectory } from "./client-directory-seed";
import { buildCognitiveRuntime, type CognitiveActor } from "./index";
import { PostgresCognitiveMemoryStore } from "./memory-store";
import { CanonicalGoalLauncher } from "./mission-gateway";
import { answer, ScriptedCognitionEngine } from "./testing/support";

/**
 * THE LDS P0 END TO END (2026-10-11), on real PostgreSQL with a deterministic cognition
 * double — no model is called.
 *
 * Live defect: « Qu'est-ce que tu peux me dire sur ce dossier LDS Rénov ? » was answered
 * « De quel client ou projet parlez-vous ? Aucun périmètre n'est actif. ». Proven here, in
 * order: (1) « Que sais-tu de LDS Rénov ? » resolves lds-renov without asking; (2) no
 * clarification; (3) the context snapshot holds LDS knowledge WITH provenance; (4) « Améliore
 * son SEO. »; (5) the scope stays LDS; (6) the goal, the start_mission job, the mission, its
 * tasks, their audit trail and the execution scope a worker would receive all carry LDS;
 * (7) the other client's records are absent from every snapshot.
 *
 * The directory comes from the SAME seed production now runs at boot.
 */
const TENANT = "default";
const ME: CognitiveActor = { tenantId: TENANT, userId: "user-geoffrey", roles: ["owner"] };
const LDS = "lds-renov";
const MECENE = "editions-du-mecene";
let container: Container;
let key = 0;
const k = () => `lds-e2e-${String(++key).padStart(6, "0")}`;

const SEO_REQUEST: CognitionOutput = {
  result: {
    kind: "MISSION_REQUEST",
    text: "Je propose une mission SEO pour LDS Rénov'.",
    goal: {
      title: "SEO du site LDS Rénov'",
      objective: "Améliorer le référencement naturel de lds-renov.fr pour la rénovation à Cannes",
      successCriteria: [],
      constraints: [],
      riskLevel: "reversible",
    },
  },
  memorySuggestions: [],
};

/** Deterministic double: a work request about SEO proposes a mission, anything else answers. */
const engine = () =>
  new ScriptedCognitionEngine((input) =>
    /seo/i.test(input.userText) ? SEO_REQUEST : answer("Voici ce que je sais de LDS Rénov'."),
  );

const dispatch = vi.fn(async (input: { workflowId?: string; taskId: string }) => ({
  workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
}));
const planner = {
  plan: vi.fn(async () => ({
    version: 1,
    tasks: [
      { key: "audit", title: "Audit SEO", description: "Auditer lds-renov.fr", dependsOn: [] },
      { key: "fix", title: "Corriger", description: "Corriger", dependsOn: ["audit"] },
    ],
  })),
};

/** CORE3's production composition of the Durable Scheduler (see production-services.ts). */
function core3Scheduler(): DurableScheduler {
  const supervisor = new SupervisorService(
    container.mission,
    container.tasks,
    { dispatch } as never,
    container.durableMemory,
    container.dispatchAttempts,
  );
  const handlers = createSchedulerHandlers({
    ignite: {
      missions: container.mission,
      runtimeRepository: container.autonomousRuntime!,
      supervisor,
      planner: planner as never,
      goals: container.goalRepository,
    },
    missions: container.mission,
    wakeup: { wake: vi.fn().mockResolvedValue(null) },
  });
  return new DurableScheduler(container.scheduledJobs, handlers, { leaseMs: 60_000 });
}

/** Owner knowledge written through the governed API path (USER_ASSERTED needs `api`). */
const ownerFact = (clientId: string, subjectKey: string, content: string): MemoryCandidate => ({
  type: "project",
  subjectKey,
  content,
  epistemic: "USER_ASSERTED",
  statementKind: "fact",
  confidence: 1,
  originTrust: "trusted",
  provenance: {
    sourceType: "api",
    sourceId: "user:user-geoffrey",
    conversationId: null,
    turnId: null,
    engine: null,
  },
  entityKey: clientId,
});

let mecenePriorityId: string;

beforeAll(async () => {
  container = await buildPostgresContainer(
    TEST_DATABASE_URL,
    undefined,
    loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL: TEST_DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "cognitive-test-key",
      ICOS_REVIEWER_MODEL: "cognitive-test-reviewer",
      ICOS_REVIEWER_TIMEOUT_MS: "1000",
    }),
  );
});

beforeEach(async () => {
  vi.clearAllMocks();
  await container.db!.execute(
    sql.raw(`TRUNCATE TABLE cognitive_events, cognitive_context_snapshots, cognitive_turn_refs, cognitive_turns,
      cognitive_participants, cognitive_conversations, memory_records, memory_relations, memory_entities,
      memory_retrieval_log, goal_previews, goals, scheduled_jobs, missions, tasks, actions, decisions
      RESTART IDENTITY CASCADE`),
  );
  const memory = new PostgresCognitiveMemoryStore(container.db!);
  await seedClientDirectory(memory, TENANT);
  const scope = (clientId: string) => ({
    tenantId: TENANT,
    userId: "user-geoffrey",
    clientId,
    projectId: null,
  });
  await memory.write(
    scope(LDS),
    ownerFact(LDS, "client.lds-renov.priorite", "Priorité LDS : le SEO local du site."),
  );
  const mecene = await memory.write(
    scope(MECENE),
    ownerFact(MECENE, "client.editions-du-mecene.priorite", "Priorité Mécène : le prochain titre."),
  );
  if (mecene.kind !== "accepted") throw new Error("seed failed");
  mecenePriorityId = mecene.record.id;
});

afterAll(async () => {
  await container?.close();
});

describe("LDS P0 end to end — resolve, know, act, carry", () => {
  it("resolves LDS without asking, knows it with provenance, keeps the scope and carries it to every hop", async () => {
    const e = engine();
    const rt = buildCognitiveRuntime(container.db!, {
      engine: e,
      missions: new CanonicalGoalLauncher(container),
      operational: null,
    });
    const conv = await rt.createConversation(ME, {});

    // (1)(2) No clarification: the model IS consulted, under LDS.
    const first = await rt.submitTurn(ME, conv.id, {
      text: "Que sais-tu de LDS Rénov ?",
      idempotencyKey: k(),
    });
    expect(first.turn.outcome).not.toBe("CLARIFICATION");
    expect(first.turn.clientId).toBe(LDS);
    expect(e.inputs).toHaveLength(1);
    const events = await rt.events(ME, conv.id, 0);
    expect(events.find((ev) => ev.type === "context.resolved")?.payload).toMatchObject({
      source: "canonical_name",
      entityKey: LDS,
    });

    // (3) LDS knowledge, with provenance: the owner statement and the owner's API assertion.
    const ctx = await rt.getContext(ME, conv.id, first.turn.id);
    expect(ctx?.snapshot.scope.clientId).toBe(LDS);
    const sources = ctx!.memories.map((m) => m.provenance.sourceId);
    expect(sources).toContain(OWNER_STATEMENT_2026_10_11);
    expect(sources).toContain("user:user-geoffrey");
    expect(ctx!.memories.every((m) => m.clientId === LDS)).toBe(true);
    expect(e.inputs[0].context).toContain("lds-renov.fr");
    expect(e.inputs[0].context).toContain("Cannes");
    expect(e.inputs[0].context).toContain("Priorité LDS");
    expect(e.inputs[0].context).not.toContain("Mécène");

    // (4)(5) « Améliore son SEO. » — the possessive keeps LDS; the proposal is LDS's.
    const second = await rt.submitTurn(ME, conv.id, {
      text: "Améliore son SEO.",
      idempotencyKey: k(),
    });
    expect(second.turn.clientId).toBe(LDS);
    expect(second.proposal).toMatchObject({ clientId: LDS, status: "approval_required" });
    expect(e.inputs[1].context).not.toContain("Mécène");
    const decided = await rt.decideProposal(ME, conv.id, second.proposal!.id, "approve");
    const launched = decided.ok ? decided.proposal : null;
    expect(launched?.status).toBe("launched");

    // (6a) goal metadata — the one source.
    const [goal] = await container.db!.execute(
      sql`select metadata from goals where id = ${launched!.goalId}`,
    );
    expect(goal.metadata).toMatchObject({ clientId: LDS, tenantId: TENANT });

    // (6b) the start_mission job carries it.
    const jobs = await container.db!.execute(
      sql`select payload from scheduled_jobs where kind = 'start_mission'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload).toMatchObject({ goalId: launched!.goalId, clientId: LDS });

    // (6c) the mission and its tasks, through CORE3's own scheduler + planner.
    expect(await core3Scheduler().sweep()).toMatchObject({ succeeded: 1, failed: 0 });
    const mission = await container.mission.findById(launched!.missionId!);
    expect(mission?.goalId).toBe(launched!.goalId);
    const missionTasks = await container.mission.listTasks(mission!.id);
    expect(missionTasks).toHaveLength(2);
    const reader = new ExecutionScopeReader({
      goals: container.goalRepository,
      missions: container.mission,
      tasks: container.tasks,
    });
    expect(await reader.forMission(mission!.id)).toMatchObject({
      tenantId: TENANT,
      clientId: LDS,
      allowedDataScope: "client",
    });
    for (const mt of missionTasks) {
      const task = await container.tasks.getById(mt.taskId);
      expect(task?.goalId).toBe(launched!.goalId);
      // (6d) what a worker's grant would carry.
      expect(await reader.forTask(mission!.id, mt.taskId)).toMatchObject({
        clientId: LDS,
        taskId: mt.taskId,
        missionId: mission!.id,
      });
    }

    // (6e) the audit trail says whose tasks were created.
    const audits = await container.db!.execute(
      sql`select details from audit_entries where event_type = 'task.created'
          and task_id in (select id from tasks where goal_id = ${launched!.goalId})`,
    );
    expect(audits).toHaveLength(2);
    for (const a of audits) expect(a.details).toMatchObject({ clientId: LDS });

    // (6f) …and whose execution completed: read from the goal, never from the worker.
    const recorded = await container.executionResults.record({
      taskId: missionTasks[0].taskId,
      workflowId: `wf-lds-${missionTasks[0].taskId}`,
      outcome: "success",
      result: "Audit SEO terminé",
      completedAt: new Date().toISOString(),
    });
    expect(recorded.ok).toBe(true);
    const completed = await container.db!.execute(
      sql`select details from audit_entries where event_type = 'task.execution.completed'
          and task_id = ${missionTasks[0].taskId}`,
    );
    expect(completed).toHaveLength(1);
    expect(completed[0].details).toMatchObject({ clientId: LDS });

    // (7) The other client's records are absent from EVERY snapshot.
    const snapshots = await container.db!.execute(
      sql`select items::text as items from cognitive_context_snapshots`,
    );
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
    for (const s of snapshots) {
      expect(s.items).not.toContain(mecenePriorityId);
      expect(s.items).not.toContain("Mécène");
    }
  });

  it("the live sentence « fichier / ce dossier LDS Rénov et ce site internet » resolves LDS, no question", async () => {
    const e = engine();
    const rt = buildCognitiveRuntime(container.db!, {
      engine: e,
      missions: null,
      operational: null,
    });
    const conv = await rt.createConversation(ME, {});
    const res = await rt.submitTurn(ME, conv.id, {
      text: "Est-ce que tu as accès au fichier LDS Rénov ? Qu'est-ce que tu peux me dire sur ce dossier LDS Rénov et ce site internet ?",
      idempotencyKey: k(),
    });
    expect(res.turn.outcome).not.toBe("CLARIFICATION");
    expect(res.turn.clientId).toBe(LDS);
    expect(e.inputs[0].context).toContain("lds-renov.fr");
  });

  it("the domain and « le client rénovation Cannes » resolve LDS through the seeded directory", async () => {
    for (const text of ["Où en est lds-renov.fr ?", "Et le client rénovation Cannes ?"]) {
      const e = engine();
      const rt = buildCognitiveRuntime(container.db!, {
        engine: e,
        missions: null,
        operational: null,
      });
      const conv = await rt.createConversation(ME, {});
      const res = await rt.submitTurn(ME, conv.id, { text, idempotencyKey: k() });
      expect(res.turn.clientId, text).toBe(LDS);
      expect(e.inputs, text).toHaveLength(1);
    }
  });

  it("FAIL_CLOSED: a task re-pointed at another client's goal is never presented under either scope", async () => {
    const rt = buildCognitiveRuntime(container.db!, {
      engine: engine(),
      missions: new CanonicalGoalLauncher(container),
      operational: null,
    });
    const conv = await rt.createConversation(ME, { clientId: LDS });
    const proposed = await rt.submitTurn(ME, conv.id, {
      text: "Améliore son SEO.",
      idempotencyKey: k(),
    });
    const decided = await rt.decideProposal(ME, conv.id, proposed.proposal!.id, "approve");
    const launched = decided.ok ? decided.proposal : null;
    await core3Scheduler().sweep();
    const [mt] = await container.mission.listTasks(launched!.missionId!);

    // A Mécène goal exists; the task's lineage is tampered to point at it.
    await container.db!.execute(
      sql`insert into goals (id, "goalId", title, objective, "rawInput", "normalizedIntent", metadata, "createdAt", "updatedAt")
          values ('g-mecene', 'g-mecene', 't', 'o', 'r', 'n', ${JSON.stringify({ clientId: MECENE })}::jsonb, now(), now())`,
    );
    await container.db!.execute(sql`update tasks set goal_id = 'g-mecene' where id = ${mt.taskId}`);

    const reader = new ExecutionScopeReader({
      goals: container.goalRepository,
      missions: container.mission,
      tasks: container.tasks,
    });
    await expect(reader.forTask(launched!.missionId!, mt.taskId)).rejects.toThrow(
      "EXECUTION_SCOPE_MISMATCH",
    );
  });
});
