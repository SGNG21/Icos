import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { DEFAULT_PORTFOLIO_POLICY } from "@/core/supervisor/portfolio";

import { ObjectiveCoordinator } from "./objective-coordinator";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const goal = (over: Partial<HighLevelGoal> = {}): HighLevelGoal => ({
  id: "g-1",
  title: "Improve the Mécène",
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => {
  const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
    job: { id: "job-1", missionId: "m-1", ...input },
    created: true,
  }));
  return {
    enqueue,
    deps: {
      scheduler: { enqueue } as never,
      goals: { list: vi.fn(async () => []) } as never,
      missions: { list: vi.fn(async () => []) } as never,
      now: () => NOW,
      ...over,
    },
  };
};

describe("ObjectiveCoordinator", () => {
  it("enqueues the existing start_mission job with a scored priority", async () => {
    const { enqueue, deps: d } = deps();
    const c = new ObjectiveCoordinator(d);

    const r = await c.admit({
      goal: goal({ metadata: { "icos.source": "cognitive_conversation" } }),
      idempotencyKey: "k-1",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("enqueued");
    const call = enqueue.mock.calls[0][0];
    expect(call.kind).toBe("start_mission");
    expect(call.idempotencyKey).toBe("k-1");
    expect(call.priority).toBeGreaterThan(80);
    expect(call.runAt).toBeUndefined();
  });

  it("uses only the existing job kind — it never invents a second one", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(enqueue.mock.calls.every(([c]) => c.kind === "start_mission")).toBe(true);
  });

  it("defers by setting runAt on the same job, never by rejecting", async () => {
    // Saturate RESEARCH, which the default policy caps at 1 concurrent objective.
    const active = Array.from({ length: DEFAULT_PORTFOLIO_POLICY.classes.RESEARCH.maxConcurrent });
    const { enqueue, deps: d } = deps({
      goals: {
        list: vi.fn(async () =>
          active.map((_, i) => ({
            goal: goal({ id: `running-${i}` }),
            status: "converted",
            resultingMissionId: `m-${i}`,
            convertedAt: NOW.toISOString(),
          })),
        ),
      },
      missions: {
        list: vi.fn(async () => active.map((_, i) => ({ id: `m-${i}`, status: "running" }))),
      },
    });

    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-new" }),
      idempotencyKey: "k-2",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("deferred");
    if (r.outcome !== "deferred") throw new Error("unreachable");
    expect(r.reason).toBe("CLASS_CONCURRENCY");
    const call = enqueue.mock.calls[0][0];
    expect(call.kind).toBe("start_mission");
    expect((call.runAt as Date).getTime()).toBe(NOW.getTime() + r.retryAfterMs);
  });

  it("carries the priority and allocation evidence on the result", async () => {
    const { deps: d } = deps();
    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k-3",
      title: "t",
      objective: "o",
    });
    expect(r.evidence.priority.policyVersion).toMatch(/^priority\//);
    expect(r.evidence.allocation.policyVersion).toMatch(/^portfolio\//);
    expect(r.evidence.priority.missing.length).toBeGreaterThan(0);
  });

  it("holds no state between calls", async () => {
    const { deps: d } = deps();
    const c = new ObjectiveCoordinator(d);
    const a = await c.admit({ goal: goal(), idempotencyKey: "k", title: "t", objective: "o" });
    const b = await c.admit({ goal: goal(), idempotencyKey: "k", title: "t", objective: "o" });
    expect(a.evidence).toEqual(b.evidence);
  });

  it("passes the caller's goalId through unchanged", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-abc" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(enqueue.mock.calls[0][0].payload).toEqual({
      title: "t",
      objective: "o",
      goalId: "g-abc",
    });
  });
});

describe("ObjectiveCoordinator — the cap must actually cap (review I3, I6)", () => {
  const pendingJobsOf = (classes: string[]) =>
    classes.map((c, i) => ({
      id: `job-${i}`,
      kind: "start_mission" as const,
      payload: { goalId: `pending-${i}`, workClass: c },
    }));

  it("I3: counts enqueued-but-not-yet-run launches, not only live missions", async () => {
    /*
     * A start_mission job that has not run yet has no mission row and its goal is still
     * `pending`: counting only live missions let 20 approvals in one minute all admit.
     */
    const { enqueue, deps: d } = deps({
      pendingLaunches: {
        countByWorkClass: vi.fn(async () => ({ RESEARCH: 1 })),
      },
    });

    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-new" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("deferred");
    if (r.outcome !== "deferred") throw new Error("unreachable");
    expect(r.reason).toBe("CLASS_CONCURRENCY");
    expect(r.evidence.allocation.activeInClass).toBe(1);
    expect(enqueue.mock.calls[0][0].runAt).toBeDefined();
  });

  it("I3: a pending launch the coordinator cannot count degrades to refusing, not to admitting", async () => {
    const { deps: d } = deps({
      pendingLaunches: {
        countByWorkClass: vi.fn(async () => {
          throw new Error("scheduler unreadable");
        }),
      },
    });
    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(r.outcome).toBe("deferred");
  });

  it("I6: asks the mission store only for the statuses that occupy a slot", async () => {
    const list = vi.fn(async (_f?: { status?: string }) => []);
    const { deps: d } = deps({ missions: { list } });
    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    // Every call must be filtered: an unfiltered list is a full table scan on a write path.
    expect(list.mock.calls.length).toBeGreaterThan(0);
    for (const [filter] of list.mock.calls) expect(filter?.status).toBeDefined();
  });
});

/**
 * VERROU C7 — L'ADMISSION ÉTAIT UN CHECK-THEN-ENQUEUE.
 *
 * `admit()` observait la charge, décidait, puis enfilait, sans rien entre les trois. Plusieurs
 * approbations simultanées lisaient donc le même « 0 actif » et étaient TOUTES admises : un
 * plafond de classe à 1 en laissait passer autant qu'il y avait d'appels simultanés.
 *
 * Ce que ce fichier prouve : la sérialisation est réelle (les appels ne s'entrelacent pas) et
 * la capacité n'est pas dépassée. Ce qu'il ne prouve PAS : la sérialisation ENTRE PROCESSUS,
 * qui est une propriété de PostgreSQL — voir `postgres-admission-serializer.ts`.
 */
describe("ObjectiveCoordinator — l'admission simultanée ne dépasse pas la capacité (C7)", () => {
  /** RESEARCH : `maxConcurrent: 1` dans la politique par défaut. Le plafond le plus serré. */
  const research = goal({ id: "g-r", metadata: { "icos.work_class": "RESEARCH" } });

  /**
   * Une charge observée qui REFLÈTE les admissions déjà accordées. Sans cela, le test ne
   * mesurerait que la file d'attente et pas le plafond : la deuxième admission doit voir ce
   * que la première a créé, ce qui est exactement ce que la sérialisation rend possible.
   *
   * Le `await` dans `countByWorkClass` est délibéré : il force un point de reprise au MILIEU
   * de la section critique, donc un `admit` non sérialisé s'y entrelace à coup sûr.
   */
  const admittedQueue = () => {
    const admitted: string[] = [];
    return {
      admitted,
      pendingLaunches: {
        countByWorkClass: async () => {
          await Promise.resolve();
          return { RESEARCH: admitted.length };
        },
      },
    };
  };

  it("trois approbations SIMULTANÉES n'en admettent qu'UNE sous un plafond de 1", async () => {
    const { admitted, pendingLaunches } = admittedQueue();
    const enqueue = vi.fn(async (input: { runAt?: Date }) => {
      if (input.runAt === undefined) admitted.push("x");
      return { job: { id: "job", missionId: "m" }, created: true };
    });
    const c = new ObjectiveCoordinator({
      scheduler: { enqueue } as never,
      goals: { list: vi.fn(async () => []) } as never,
      missions: { list: vi.fn(async () => []) } as never,
      now: () => NOW,
      pendingLaunches,
    });

    /* Trois promesses créées SANS await, résolues ensemble : la course est réelle. */
    const results = await Promise.all(
      ["a", "b", "c"].map((k) =>
        c.admit({ goal: research, idempotencyKey: k, title: "t", objective: "o" }),
      ),
    );

    expect(results.filter((r) => r.outcome === "enqueued")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "deferred")).toHaveLength(2);
    /* L'INVARIANT dit directement : la capacité de la classe n'a jamais été dépassée. */
    expect(admitted).toHaveLength(1);
    for (const deferred of results.filter((r) => r.outcome === "deferred")) {
      expect(deferred).toMatchObject({ reason: "CLASS_CONCURRENCY" });
    }
  });

  it("une admission qui ÉCHOUE ne bloque pas la file : la suivante démarre quand même", async () => {
    let first = true;
    const enqueue = vi.fn(async () => {
      if (first) {
        first = false;
        throw new Error("ordonnanceur indisponible");
      }
      return { job: { id: "job", missionId: "m" }, created: true };
    });
    const c = new ObjectiveCoordinator({
      scheduler: { enqueue } as never,
      goals: { list: vi.fn(async () => []) } as never,
      missions: { list: vi.fn(async () => []) } as never,
      now: () => NOW,
    });

    const [a, b] = await Promise.allSettled([
      c.admit({ goal: goal(), idempotencyKey: "a", title: "t", objective: "o" }),
      c.admit({ goal: goal(), idempotencyKey: "b", title: "t", objective: "o" }),
    ]);
    expect(a?.status).toBe("rejected");
    expect(b?.status).toBe("fulfilled");
  });

  it("DEUX classes distinctes ne se bloquent pas l'une l'autre pour rien", async () => {
    /* La sérialisation est globale : elle doit ORDONNER, jamais REFUSER ce qui tient. */
    const enqueue = vi.fn(async () => ({ job: { id: "job", missionId: "m" }, created: true }));
    const c = new ObjectiveCoordinator({
      scheduler: { enqueue } as never,
      goals: { list: vi.fn(async () => []) } as never,
      missions: { list: vi.fn(async () => []) } as never,
      now: () => NOW,
    });
    const results = await Promise.all([
      c.admit({ goal: research, idempotencyKey: "a", title: "t", objective: "o" }),
      c.admit({
        goal: goal({ id: "g-s", metadata: { "icos.work_class": "SECURITY" } }),
        idempotencyKey: "b",
        title: "t",
        objective: "o",
      }),
    ]);
    expect(results.every((r) => r.outcome === "enqueued")).toBe(true);
  });
});

/** La politique par défaut doit bien porter le plafond que le test ci-dessus exerce. */
describe("DEFAULT_PORTFOLIO_POLICY — le plafond exercé par les preuves C7", () => {
  it("RESEARCH est bien plafonné à une seule admission concurrente", () => {
    expect(DEFAULT_PORTFOLIO_POLICY.classes.RESEARCH.maxConcurrent).toBe(1);
  });
});

/**
 * VERROU C5 — LE CHAÎNON MANQUANT ENTRE L'INTAKE ET LE RUNTIME.
 *
 * Le mécanisme des caps existait de bout en bout : `requestedBoundsSchema` -> payload du job
 * durable -> handler `start_mission` -> `igniteAutonomousMission` -> colonnes
 * `autonomous_mission_runtime`, que la boucle relit à chaque cycle (donc replan, réveil et
 * redémarrage repartent des caps PERSISTÉS — prouvé dans
 * `autonomous-mission-runner-restart.integration.test.ts` et
 * `bounded-autonomy-admission.integration.test.ts`).
 *
 * Il manquait le PREMIER maillon : l'admission laissait tomber la demande, donc rien ne
 * pouvait l'alimenter depuis l'intake et toute mission tournait au plafond de politique.
 * Ce qui suit est ce maillon, et seulement lui.
 */
describe("ObjectiveCoordinator — les caps demandés atteignent le job durable (C5)", () => {
  it("porte bounds et computePolicy DANS LE PAYLOAD, pas dans la mémoire du processus", async () => {
    const { enqueue, deps: d } = deps();
    const bounds = { maxRuntimeMs: 1_800_000, maxCycles: 20, maxReplans: 2 };
    const computePolicy = { allowedModels: ["cheap-model"] };

    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
      bounds,
      computePolicy,
    });

    /* Le payload est ce qui SURVIT au processus : il repart de la base en jsonb. */
    expect(enqueue.mock.calls[0][0].payload).toMatchObject({ bounds, computePolicy });
  });

  it("n'écrit PAS les clés absentes : un `undefined` en jsonb deviendrait un null refusé", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    const payload = enqueue.mock.calls[0][0].payload as Record<string, unknown>;
    expect("bounds" in payload).toBe(false);
    expect("computePolicy" in payload).toBe(false);
  });

  it("porte les caps AUSSI sur une admission DIFFÉRÉE : un report ne les perd pas", async () => {
    /*
     * Le cas qui compte vraiment. Une admission différée enfile le MÊME job avec un `runAt`,
     * et c'est le scheduler qui le rejoue plus tard. Si les caps ne voyageaient que sur le
     * chemin « admis tout de suite », toute mission mise en attente par la pression du
     * portefeuille repartirait au plafond — une restriction perdue par le simple fait
     * d'avoir attendu.
     */
    const { enqueue, deps: d } = deps({
      pendingLaunches: { countByWorkClass: async () => ({ RESEARCH: 5 }) },
    });
    const bounds = { maxCycles: 3 };

    const result = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-r", metadata: { "icos.work_class": "RESEARCH" } }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
      bounds,
    });

    expect(result.outcome).toBe("deferred");
    expect(enqueue.mock.calls[0][0].runAt).toBeInstanceOf(Date);
    expect(enqueue.mock.calls[0][0].payload).toMatchObject({ bounds });
  });
});
