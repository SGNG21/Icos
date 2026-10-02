import { beforeEach, describe, expect, it } from "vitest";

import { BRAIN_IDS, BRAIN_ROLES } from "@/core/workforce/brains";

import { bootstrapWorkforce } from "./bootstrap-workforce";
import type { WorkforceStore } from "./ports";
import { certifier, makeService, owner } from "./test-support";
import type { WorkforceService } from "./workforce-service";

/**
 * AMORÇAGE CANONIQUE — premier démarrage, second démarrage, redémarrage, état partiel,
 * absence de doublon. Les cinq cas que le propriétaire a demandés, dans cet ordre.
 *
 * Ce qui est prouvé : l'amorçage est idempotent à CHAQUE étage (rôles, cerveaux, outils) et
 * un passage interrompu se reprend sans rien réécrire. Ce qui ne l'est PAS ici : le SQL réel
 * — l'unicité de `(tenant_id, agent_id)` est une contrainte PostgreSQL et se prouve contre
 * une vraie base.
 */

let service: WorkforceService;
let store: WorkforceStore;

beforeEach(() => {
  ({ service, store } = makeService());
});

const durableIds = async () =>
  (await store.listAgents("default"))
    .filter((a) => a.kind === "DURABLE_AGENT")
    .map((a) => a.agentId)
    .sort();

describe("bootstrapWorkforce", () => {
  it("PREMIER démarrage : douze cerveaux, neuf rôles actifs, outils accordés", async () => {
    const report = await bootstrapWorkforce({ service, store }, owner, certifier);

    expect(report.complete).toBe(true);
    expect([...report.rolesActivated].sort()).toEqual(
      [...new Set(BRAIN_ROLES.map((r) => r.roleId))].sort(),
    );
    expect(report.rolesAlreadyActive).toEqual([]);
    expect(await durableIds()).toEqual([...BRAIN_IDS].sort());
    expect(report.brains.results.every((r) => r.outcome === "created")).toBe(true);
    /* Chaque cerveau porte des outils, ou n'en a besoin d'aucun. Jamais « refusé ». */
    expect(report.grants.results.some((r) => r.outcome === "refused")).toBe(false);
  });

  it("SECOND démarrage : rien de créé, rien de recertifié, rien de réaccordé", async () => {
    await bootstrapWorkforce({ service, store }, owner, certifier);
    const before = await store.listAgents("default");

    const again = await bootstrapWorkforce({ service, store }, owner, certifier);

    expect(again.complete).toBe(true);
    expect(again.rolesActivated).toEqual([]);
    expect(again.rolesAlreadyActive).toHaveLength(
      [...new Set(BRAIN_ROLES.map((r) => r.roleId))].length,
    );
    expect(again.brains.results.every((r) => r.outcome === "already-present")).toBe(true);
    expect(again.grants.results.every((r) => r.outcome !== "granted")).toBe(true);
    /* L'état durable est octet pour octet le même : aucune version d'agent n'a bougé. */
    expect(await store.listAgents("default")).toEqual(before);
  });

  it("AUCUN DOUBLON : trois passages laissent exactement douze identités", async () => {
    for (let i = 0; i < 3; i += 1) await bootstrapWorkforce({ service, store }, owner, certifier);
    const ids = await durableIds();
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });

  it("ÉTAT PARTIEL : un passage interrompu après les rôles se reprend sans rien réécrire", async () => {
    /* On n'amorce QUE les rôles, en coupant avant les cerveaux. */
    await bootstrapWorkforce(
      {
        service,
        /* `getAgent` qui ment « déjà présent » : le seeder n'en crée aucun. */
        store: {
          getAgent: async () => ({}) as never,
          getRole: (tenantId, roleId, version) => store.getRole(tenantId, roleId, version),
          listAgents: (tenantId) => store.listAgents(tenantId),
        },
      },
      owner,
      certifier,
    );
    expect(await durableIds()).toEqual([]);

    const resumed = await bootstrapWorkforce({ service, store }, owner, certifier);
    expect(resumed.complete).toBe(true);
    /* Les rôles étaient déjà actifs : repris, pas recertifiés. */
    expect(resumed.rolesActivated).toEqual([]);
    expect(await durableIds()).toEqual([...BRAIN_IDS].sort());
  });

  it("REDÉMARRAGE sur un état complet : la reprise est un no-op observable", async () => {
    await bootstrapWorkforce({ service, store }, owner, certifier);
    /* Un nouveau processus, le MÊME magasin : c'est ce qu'est un redémarrage. */
    const { service: restarted } = makeService(store);
    const after = await bootstrapWorkforce({ service: restarted, store }, owner, certifier);
    expect(after.complete).toBe(true);
    expect(after.brains.results.every((r) => r.outcome === "already-present")).toBe(true);
    expect(await durableIds()).toHaveLength(12);
  });

  it("l'indépendance de certification est vérifiée contre le CRÉATEUR du rôle", async () => {
    /*
     * Ce que la règle dit VRAIMENT, et pas ce qu'on aimerait qu'elle dise : `SELF_CERTIFICATION`
     * compare le certificateur au CRÉATEUR du rôle. Les rôles d'amorçage sont créés par
     * `{kind: system, id: workforce-bootstrap}`, donc le propriétaire PEUT les certifier —
     * il n'est pas leur auteur. Le frottement « deux personnes » protège un rôle composé
     * dynamiquement par un humain, pas un gabarit livré avec le dépôt.
     *
     * On le teste explicitement pour que personne ne lise cette signature à deux principals
     * comme une séparation plus forte qu'elle ne l'est. Un certificateur SYSTÈME, lui, reste
     * refusé en toutes circonstances.
     */
    const report = await bootstrapWorkforce({ service, store }, owner, owner);
    expect(report.complete).toBe(true);

    const systemCertifier = { ...owner, kind: "system" as const };
    const { service: fresh, store: freshStore } = makeService();
    await expect(
      bootstrapWorkforce({ service: fresh, store: freshStore }, owner, systemCertifier),
    ).rejects.toThrow();
  });

  it("les outils accordés sont le MINIMUM du rôle, jamais tout le catalogue", async () => {
    await bootstrapWorkforce({ service, store }, owner, certifier);
    const agents = new Map((await store.listAgents("default")).map((a) => [a.agentId, a]));

    /* Un cerveau ne reçoit QUE ce que ses skills déclarent. */
    const builder = agents.get("brain-builder")!;
    expect(builder.policy.toolGrants.map((g) => g.toolId).sort()).toEqual([
      "repo_read",
      "repo_write",
    ]);
    /* Un cerveau de recherche n'obtient aucun accès au dépôt. */
    const research = agents.get("brain-research")!;
    expect(research.policy.toolGrants.map((g) => g.toolId)).toEqual(["web_research"]);
    /* La racine détient l'union de ce qu'elle délègue — c'est la règle d'autorité. */
    const chief = agents.get("brain-chief")!;
    const fleet = new Set(
      [...agents.values()].flatMap((a) => a.policy.toolGrants.map((g) => g.toolId)),
    );
    expect(new Set(chief.policy.toolGrants.map((g) => g.toolId))).toEqual(fleet);
  });

  it("chaque grant porte l'identité de l'HUMAIN qui a amorcé, jamais celle d'un agent", async () => {
    await bootstrapWorkforce({ service, store }, owner, certifier);
    const agents = await store.listAgents("default");
    for (const agent of agents) {
      for (const grant of agent.policy.toolGrants) {
        expect(grant.grantedBy.kind).toBe("human");
        expect(grant.grantedBy.id).toBe(owner.id);
      }
    }
  });
});
