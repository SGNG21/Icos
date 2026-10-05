import { beforeEach, describe, expect, it } from "vitest";

import { BRAIN_ROLES } from "@/core/workforce/brains";
import { requiredRoleTests } from "@/core/workforce/role-composer";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import { brainRegistry } from "./brain-registry";
import {
  chiefDelegation,
  planTaskBindings,
  reviewAssignmentTaskId,
  type BindableTask,
  type ChiefDelegation,
} from "./chief-delegation";
import { seedBrains } from "./brain-seed";
import { grantBrainTools } from "./brain-tool-grants";
import { BRAIN_IDS } from "@/core/workforce/brains";
import { workforceTaskCompute } from "./core3-task-compute";
import type { WorkforceStore } from "./ports";
import { as, bootstrap, certifier, makeService, owner, system } from "./test-support";
import type { WorkforceService } from "./workforce-service";

/**
 * C6 — LES DOUZE CERVEAUX SONT PORTEURS, PROUVÉ DE BOUT EN BOUT.
 *
 *   Goal → Chief → sélection de cerveau → plan de délégation → affectation → dispatch
 *
 * Chaque maillon était écrit et aucun n'était relié : `seedBrains`, `planObjectiveDelegation`
 * et `WorkforceService.delegate` n'avaient aucun appelant, donc zéro ligne et zéro
 * affectation. Ces preuves parcourent la chaîne RÉELLE — vraies données d'amorçage, vrais
 * rôles certifiés, vraie gouvernance — et finissent là où CORE3 lit, pour qu'un cerveau
 * « routé » veuille dire « le dispatcheur le voit ».
 */

let service: WorkforceService;
let store: WorkforceStore;
let chief: ChiefDelegation;

/** L'objectif tel qu'il arrive de l'intake : c'est le TEXTE BRUT qui est classé. */
const goal = (
  rawInput: string,
  metadata: Record<string, string> = {},
  id = "g-1",
): HighLevelGoal => ({
  id,
  title: rawInput,
  objective: rawInput,
  rawInput,
  normalizedIntent: rawInput,
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata,
  createdAt: "2026-10-02T00:00:00.000Z",
});

/**
 * L'amorçage CANONIQUE complet : skills + rôles, les neuf rôles des cerveaux certifiés par
 * un humain INDÉPENDANT puis activés, et les douze cerveaux créés par le seeder réel.
 * Rien n'est contourné — si la gouvernance refusait, ces tests échoueraient ici.
 */
async function bootstrapBrains() {
  await service.seedBootstrap(owner, bootstrap);
  for (const { roleId, version } of BRAIN_ROLES) {
    const role = bootstrap.roles.find((r) => r.roleId === roleId && r.version === version)!;
    await service.certifyRole(
      certifier,
      roleId,
      version,
      requiredRoleTests(role, bootstrap.skills),
    );
    await service.activateRole(owner, roleId, version);
  }
  const seeded = await seedBrains({ service, store }, owner);
  /*
   * L'ÉTAPE QUI MANQUAIT, et sans laquelle « porteur » reste un mot. Un cerveau seedé n'a
   * aucun outil (`a grant comes from a human`), donc la gouvernance refuse chacune de ses
   * affectations en `MISSING_TOOL_GRANT` : douze lignes que le dispatcheur ignore, très
   * exactement ce que la revue reprochait. Le propriétaire accorde ici le MINIMUM que
   * chaque rôle certifié déclare, jamais « tous les outils ».
   */
  const granted = await grantBrainTools({ service, store }, owner, BRAIN_IDS);
  expect(granted.complete).toBe(true);
  return seeded;
}

beforeEach(async () => {
  ({ service, store } = makeService());
  const report = await bootstrapBrains();
  expect(report.complete).toBe(true);
  chief = chiefDelegation({
    registry: brainRegistry(store),
    service,
    store,
    chief: as("brain-chief"),
  });
});

/** CORE3 tasks as the planner leaves them: real ids, and usually NO capability (23/26 live). */
const TASKS: readonly BindableTask[] = [
  { taskId: "task-a1", capability: null },
  { taskId: "task-b2", capability: "code_write" },
];

describe("amorçage des douze cerveaux — exactement douze, et idempotent", () => {
  it("crée EXACTEMENT les douze identités canoniques", async () => {
    const agents = (await store.listAgents("default")).filter((a) => a.kind === "DURABLE_AGENT");
    expect(agents.map((a) => a.agentId).sort()).toEqual([
      "brain-architect",
      "brain-builder",
      "brain-business",
      "brain-chief",
      "brain-delivery",
      "brain-evolution",
      "brain-growth",
      "brain-memory",
      "brain-planner",
      "brain-recovery",
      "brain-research",
      "brain-reviewer",
    ]);
  });

  it("un SECOND amorçage ne crée aucun doublon et ne réécrit rien", async () => {
    const before = await store.listAgents("default");
    const again = await seedBrains({ service, store }, owner);
    expect(again.results.every((r) => r.outcome === "already-present")).toBe(true);
    expect(again.complete).toBe(true);
    expect(await store.listAgents("default")).toEqual(before);
  });

  it("reprend un état PARTIEL sans toucher à ce qui existe déjà", async () => {
    /* Le cas du redémarrage au milieu : la moitié est là, l'autre pas. */
    ({ service, store } = makeService());
    await service.seedBootstrap(owner, bootstrap);
    for (const { roleId, version } of BRAIN_ROLES) {
      const role = bootstrap.roles.find((r) => r.roleId === roleId && r.version === version)!;
      await service.certifyRole(
        certifier,
        roleId,
        version,
        requiredRoleTests(role, bootstrap.skills),
      );
      await service.activateRole(owner, roleId, version);
    }
    /* Premier passage interrompu : on ne crée QUE le Chief (racine, requise par le FK). */
    const partial = await seedBrains(
      {
        service,
        store: {
          getAgent: async (tenantId, agentId) =>
            agentId === "brain-chief" ? store.getAgent(tenantId, agentId) : null,
        },
      },
      owner,
    );
    expect(partial.complete).toBe(true);
    const full = await seedBrains({ service, store }, owner);
    expect(full.results.filter((r) => r.outcome === "created")).toHaveLength(0);
    expect((await store.listAgents("default")).length).toBe(12);
  });

  it("le registre voit les douze avec les capacités de LEUR RÔLE, jamais inventées", async () => {
    const brains = await brainRegistry(store).list("default");
    expect(brains).toHaveLength(12);
    const byId = new Map(brains.map((b) => [b.brainId, b]));
    /* Les capacités viennent des skills du rôle : aucune n'est redéclarée par un cerveau. */
    expect(byId.get("brain-builder")?.capabilities).toContain("code_write");
    expect(byId.get("brain-planner")?.capabilities).toContain("planning");
    expect(byId.get("brain-reviewer")?.capabilities).toContain("independent_review");
    /* Et la collision réelle est bien là : trois cerveaux, les mêmes capacités. */
    expect(byId.get("brain-evolution")?.capabilities).toEqual(
      byId.get("brain-builder")?.capabilities,
    );
  });
});

describe("C6 — un objectif est routé vers le BON cerveau, et l'affectation est durable", () => {
  /** Les cerveaux réellement affectés pour cet objectif, lus en base. */
  const routed = async (
    rawInput: string,
    missionId: string,
    metadata: Record<string, string> = {},
  ) => {
    const outcome = await chief.delegateGoal(goal(rawInput, metadata), missionId, TASKS);
    if (!outcome.ok) throw new Error(`refusé : ${outcome.refusals.join(",")}`);
    return {
      outcome,
      brains: outcome.assignments.map((a) => a.assigneeAgentId).sort(),
      stages: outcome.plan.assignments.map((a) => a.stage),
    };
  };

  it("SELF_IMPROVEMENT « Améliore ICOS » entre par EVOLUTION, pas par Builder", async () => {
    const { outcome, brains, stages } = await routed("Améliore ICOS.", "m-self");
    expect(outcome.plan.workClass).toBe("SELF_IMPROVEMENT");
    /* L'étape d'entrée, vague 0, est Evolution — malgré trois cerveaux capacité-identiques. */
    expect(stages[0]).toBe("EVOLUTION");
    expect(outcome.plan.assignments[0]?.brainId).toBe("brain-evolution");
    expect(brains).toContain("brain-evolution");
  });

  it("un objectif logiciel ORDINAIRE passe par Planner puis Builder", async () => {
    /* La métadonnée que l'intake conversationnel pose réellement sur un goal parlé. */
    const { outcome, brains } = await routed(
      "Ajoute une page de paramètres utilisateur.",
      "m-user",
      { "icos.source": "cognitive_conversation" },
    );
    expect(outcome.plan.workClass).toBe("USER");
    expect(outcome.plan.assignments.map((a) => a.brainId)).toEqual([
      "brain-planner",
      "brain-builder",
    ]);
    expect(brains).toContain("brain-planner");
    expect(brains).toContain("brain-builder");
  });

  it("une RÉPARATION va à Recovery, et pas à Builder qui a les mêmes capacités", async () => {
    const { outcome } = await routed("Répare la régression de connexion.", "m-fix", {
      "icos.domain": "maintenance",
    });
    expect(outcome.plan.workClass).toBe("MAINTENANCE");
    expect(outcome.plan.assignments.map((a) => a.brainId)).toEqual(["brain-recovery"]);
  });

  it("la RELECTURE revient toujours au relecteur indépendant, jamais à Business", async () => {
    /*
     * SALES_DIRECTOR déclare `independent_review` : sans le relecteur canonique nommé,
     * `brain-business` remportait la relecture par simple ordre alphabétique.
     */
    for (const [raw, mission] of [
      ["Améliore ICOS.", "m-r1"],
      ["Ajoute une page de paramètres utilisateur.", "m-r2"],
    ] as const) {
      const { outcome } = await routed(raw, mission, {
        "icos.source": "cognitive_conversation",
      });
      expect(outcome.plan.review.brainId).toBe("brain-reviewer");
      /* Et le relecteur n'est jamais l'un des implémenteurs du même plan. */
      expect(outcome.plan.assignments.map((a) => a.brainId)).not.toContain("brain-reviewer");
    }
  });

  it("un objectif CLIENT atteint le cerveau métier", async () => {
    const { outcome } = await routed("Audite le client LDS et propose un plan.", "m-client");
    expect(["CLIENT", "REVENUE"]).toContain(outcome.plan.workClass);
    expect(outcome.plan.assignments.map((a) => a.brainId)).toContain("brain-business");
  });
});

describe("décision 0070 — l'affectation porte l'identité CORE3 et le dispatcheur la LIT", () => {
  const compute = () =>
    workforceTaskCompute({ compute: makeService(store).runtime.compute, store, system });

  it("une tâche SANS capacité appartient au cerveau de tête ; une capacité déclarée va au spécialiste", () => {
    const plan = {
      assignments: [
        { stage: "PLANNER", capability: "planning", brainId: "brain-planner", wave: 0 },
        { stage: "BUILDER", capability: "code_write", brainId: "brain-builder", wave: 1 },
      ],
    } as never;
    const { bound, unbound } = planTaskBindings(plan, [
      ...TASKS,
      { taskId: "task-c3", capability: "seo_audit" },
    ]);
    expect(bound.map((b) => [b.taskId, b.stages.map((s) => s.brainId)])).toEqual([
      ["task-a1", ["brain-planner"]],
      ["task-b2", ["brain-builder"]],
    ]);
    /* Une capacité que le plan ne porte pas n'est PAS devinée vers le cerveau de tête. */
    expect(unbound.map((t) => t.taskId)).toEqual(["task-c3"]);
  });

  it("objectif logiciel : la tâche va à Planner, la tâche code_write à Builder, et forTask les rend", async () => {
    const outcome = await chief.delegateGoal(
      goal("Ajoute une page de paramètres utilisateur.", {
        "icos.source": "cognitive_conversation",
      }),
      "m-core3",
      TASKS,
    );
    if (!outcome.ok) throw new Error("attendu un plan");
    expect(outcome.unbound).toEqual([]);
    /* Les lignes portent l'identité CORE3, jamais `<mission>:étape`. */
    expect(outcome.assignments.map((a) => [a.taskId, a.assigneeAgentId]).sort()).toEqual([
      [reviewAssignmentTaskId("m-core3"), "brain-reviewer"],
      ["task-a1", "brain-planner"],
      ["task-b2", "brain-builder"],
    ]);
    expect((await compute().forTask("m-core3", "task-a1"))?.agentIds).toEqual(["brain-planner"]);
    expect((await compute().forTask("m-core3", "task-b2"))?.agentIds).toEqual(["brain-builder"]);
    /* La relecture est l'affaire du relecteur, sous sa propre clé : CORE3 ne route jamais sous cet id. */
    expect(
      (await compute().forTask("m-core3", reviewAssignmentTaskId("m-core3")))?.agentIds,
    ).toEqual(["brain-reviewer"]);
  });

  it("auto-amélioration : Evolution porte la tâche, et une tâche code_write lie Evolution ET Builder", async () => {
    const outcome = await chief.delegateGoal(goal("Améliore ICOS."), "m-self", TASKS);
    if (!outcome.ok) throw new Error("attendu un plan");
    expect((await compute().forTask("m-self", "task-a1"))?.agentIds).toEqual(["brain-evolution"]);
    expect([...((await compute().forTask("m-self", "task-b2"))?.agentIds ?? [])].sort()).toEqual([
      "brain-builder",
      "brain-evolution",
    ]);
  });

  it("réparation → Recovery ; client → Business ; revenu → Business puis Growth", async () => {
    const fix = await chief.delegateGoal(
      goal("Répare la régression de connexion.", { "icos.domain": "maintenance" }),
      "m-fix",
      [TASKS[0]!],
    );
    if (!fix.ok) throw new Error("attendu un plan");
    expect((await compute().forTask("m-fix", "task-a1"))?.agentIds).toEqual(["brain-recovery"]);

    const client = await chief.delegateGoal(
      goal("Audite le client LDS et propose un plan."),
      "m-client",
      [TASKS[0]!],
    );
    if (!client.ok) throw new Error("attendu un plan");
    expect((await compute().forTask("m-client", "task-a1"))?.agentIds).toEqual(["brain-business"]);

    const revenue = await chief.delegateGoal(
      goal("Augmente le chiffre d'affaires du trimestre.", { "icos.domain": "revenue" }),
      "m-rev",
      [TASKS[0]!, { taskId: "task-seo", capability: "seo_audit" }],
    );
    if (!revenue.ok) throw new Error("attendu un plan");
    expect((await compute().forTask("m-rev", "task-a1"))?.agentIds).toEqual(["brain-business"]);
    expect((await compute().forTask("m-rev", "task-seo"))?.agentIds).toEqual(["brain-growth"]);
  });

  it("IDEMPOTENT : une seconde délégation des mêmes tâches ne crée rien, une nouvelle tâche est liée", async () => {
    const g = goal("Améliore ICOS.");
    const first = await chief.delegateGoal(g, "m-idem", TASKS);
    if (!first.ok) throw new Error("attendu un plan");
    const before = (await store.listAssignments("default")).filter((a) => a.missionId === "m-idem");
    const again = await chief.delegateGoal(g, "m-idem", TASKS);
    if (!again.ok) throw new Error("attendu un plan");
    expect(again.assignments).toEqual([]);
    /* Toutes les liaisons de TÂCHE existaient déjà ; la relecture est comptée à part. */
    expect(again.alreadyBound).toBe(before.length - 1);
    /* Un replan ajoute une tâche : seule celle-là est liée. */
    const replanned = await chief.delegateGoal(g, "m-idem", [...TASKS, { taskId: "task-new" }]);
    if (!replanned.ok) throw new Error("attendu un plan");
    expect(replanned.assignments.map((a) => a.taskId)).toEqual(["task-new"]);
    /* RETRY / RESUME : une nouvelle lecture, même magasin, même affectation. */
    const once = await compute().forTask("m-idem", "task-a1");
    const twice = await compute().forTask("m-idem", "task-a1");
    expect(twice?.assignmentIds).toEqual(once?.assignmentIds);
  });

  it("un replan ou une tâche terminée REND le créneau du cerveau ; la relecture reste", async () => {
    const g = goal("Ajoute une page de paramètres utilisateur.", {
      "icos.source": "cognitive_conversation",
    });
    await chief.delegateGoal(g, "m-rel", [
      { taskId: "task-old", status: "queued" },
      { taskId: "task-done", status: "running" },
    ]);
    /* Replan: task-old is superseded (gone from the list), task-done finished, task-new appears. */
    const again = await chief.delegateGoal(g, "m-rel", [
      { taskId: "task-done", status: "succeeded" },
      { taskId: "task-new", status: "queued" },
    ]);
    if (!again.ok) throw new Error("attendu un plan");
    expect(again.released).toBe(2);
    expect(again.assignments.map((a) => a.taskId)).toEqual(["task-new"]);
    const rows = (await store.listAssignments("default")).filter((a) => a.missionId === "m-rel");
    expect(rows.map((a) => [a.taskId, a.status]).sort()).toEqual([
      [reviewAssignmentTaskId("m-rel"), "assigned"],
      ["task-done", "cancelled"],
      ["task-new", "assigned"],
      ["task-old", "cancelled"],
    ]);
    /* The dispatcher no longer sees the released ones, and the new one is live. */
    expect(await compute().forTask("m-rel", "task-old")).toBeNull();
    expect((await compute().forTask("m-rel", "task-new"))?.agentIds).toEqual(["brain-planner"]);
  });

  it("une tâche qu'aucun cerveau ne porte reste nulle : rien n'est inventé au dispatch", async () => {
    await chief.delegateGoal(goal("Améliore ICOS."), "m-core3", TASKS);
    expect(await compute().forTask("m-core3", "task-inexistante")).toBeNull();
  });
});

describe("C6 — fermé par défaut : le Chief ne contourne pas la gouvernance", () => {
  it("une classe SANS FORME est refusée et n'enregistre AUCUNE affectation", async () => {
    /*
     * SECURITY n'a volontairement aucune forme de délégation : aucun des douze cerveaux
     * n'a de rôle couvrant la sécurité, et improviser une affectation sécurité serait pire
     * que la refuser. Le refus précède tout effet de bord — rien n'est enregistré à moitié.
     */
    const before = (await store.listAssignments("default")).length;
    const outcome = await chief.delegateGoal(
      goal("Corrige la faille.", { "icos.domain": "security" }),
      "m-sec",
      TASKS,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toContain("NO_SHAPE_FOR_WORK_CLASS");
    expect((await store.listAssignments("default")).length).toBe(before);
  });

  it("un goal SANS signal retombe sur la classe de la FICHE, jamais sur une devinette", async () => {
    /*
     * Conséquence assumée de la précédence : arrivé ici, l'objet EST un goal — l'intake a
     * déjà décidé que c'était du travail. On ne peut donc plus répondre « ce n'est pas
     * classé » ; on reprend la classe que l'ADMISSION utilise déjà pour la même fiche, au
     * lieu d'en inventer une troisième. Sans métadonnée, c'est la classe par défaut.
     */
    const outcome = await chief.delegateGoal(
      goal("Explore les options de cache."),
      "m-default",
      TASKS,
    );
    if (!outcome.ok) throw new Error(`refusé : ${outcome.refusals.join(",")}`);
    expect(outcome.plan.workClass).toBe("RESEARCH");
    expect(outcome.plan.assignments.map((a) => a.brainId)).toEqual(["brain-research"]);
  });

  it("un cerveau SUSPENDU n'est pas remplacé en silence par son jumeau de capacités", async () => {
    await service.changeStatus(owner, "brain-evolution", "suspended");
    const outcome = await chief.delegateGoal(goal("Améliore ICOS."), "m-susp", TASKS);
    if (!outcome.ok) throw new Error("attendu un plan");
    /* Builder et Recovery ont EXACTEMENT les mêmes capacités : aucun ne prend la place. */
    expect(outcome.plan.assignments.map((a) => a.brainId)).not.toContain("brain-evolution");
    expect(outcome.plan.unmetNeeds.map((u) => u.stage)).toContain("EVOLUTION");
    expect(outcome.plan.excludedBrains.map((b) => b.brainId)).toContain("brain-evolution");
  });

  it("un cerveau ne peut pas être affecté par quelqu'un qui n'est pas son superviseur", async () => {
    const impostor = chiefDelegation({
      registry: brainRegistry(store),
      service,
      store,
      chief: as("brain-builder"),
    });
    const outcome = await impostor.delegateGoal(goal("Améliore ICOS."), "m-impostor", TASKS);
    if (!outcome.ok) throw new Error("le plan est le même : c'est l'ENREGISTREMENT qui refuse");
    /* Le plan existe (c'est de la politique pure) mais rien n'est accordé. */
    expect(outcome.assignments).toEqual([]);
    expect(outcome.gaps.length).toBeGreaterThan(0);
  });
});
