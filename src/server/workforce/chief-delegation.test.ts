import { beforeEach, describe, expect, it } from "vitest";

import { BRAIN_ROLES } from "@/core/workforce/brains";
import { requiredRoleTests } from "@/core/workforce/role-composer";
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import { brainRegistry } from "./brain-registry";
import { chiefDelegation, stageTaskId, type ChiefDelegation } from "./chief-delegation";
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
    chief: as("brain-chief"),
  });
});

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
    const outcome = await chief.delegateGoal(goal(rawInput, metadata), missionId);
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

describe("C6 — l'affectation est VUE par le dispatcheur CORE3", () => {
  it("ce que le Chief a affecté est exactement ce que `forTask` rend au dispatch", async () => {
    /*
     * LA preuve que « porteur » n'est pas un mot. La chaîne s'arrête ici en production :
     * CORE3 appelle `forTask` au moment de préparer un dispatch, et ne doit trouver l'étape
     * que parce que le Chief l'a réellement enregistrée.
     */
    const outcome = await chief.delegateGoal(goal("Améliore ICOS."), "m-core3");
    if (!outcome.ok) throw new Error("attendu un plan");

    const compute = workforceTaskCompute({
      compute: makeService(store).runtime.compute,
      store,
      system,
    });
    const need = await compute.forTask("m-core3", stageTaskId("m-core3", "EVOLUTION"));
    expect(need).not.toBeNull();
    expect(need?.agentIds).toEqual(["brain-evolution"]);
  });

  it("une tâche qu'aucun cerveau ne porte reste nulle : rien n'est inventé au dispatch", async () => {
    await chief.delegateGoal(goal("Améliore ICOS."), "m-core3");
    const compute = workforceTaskCompute({
      compute: makeService(store).runtime.compute,
      store,
      system,
    });
    expect(await compute.forTask("m-core3", "m-core3:inexistante")).toBeNull();
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
    const outcome = await chief.delegateGoal(goal("Explore les options de cache."), "m-default");
    if (!outcome.ok) throw new Error(`refusé : ${outcome.refusals.join(",")}`);
    expect(outcome.plan.workClass).toBe("RESEARCH");
    expect(outcome.plan.assignments.map((a) => a.brainId)).toEqual(["brain-research"]);
  });

  it("un cerveau SUSPENDU n'est pas remplacé en silence par son jumeau de capacités", async () => {
    await service.changeStatus(owner, "brain-evolution", "suspended");
    const outcome = await chief.delegateGoal(goal("Améliore ICOS."), "m-susp");
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
      chief: as("brain-builder"),
    });
    const outcome = await impostor.delegateGoal(goal("Améliore ICOS."), "m-impostor");
    if (!outcome.ok) throw new Error("le plan est le même : c'est l'ENREGISTREMENT qui refuse");
    /* Le plan existe (c'est de la politique pure) mais rien n'est accordé. */
    expect(outcome.assignments).toEqual([]);
    expect(outcome.gaps.length).toBeGreaterThan(0);
  });
});
