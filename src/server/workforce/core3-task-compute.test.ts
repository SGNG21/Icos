import { beforeEach, describe, expect, it } from "vitest";

import type { WorkforceRuntime } from "./composition";
import { workforceTaskCompute } from "./core3-task-compute";
import type { WorkforceStore } from "./ports";
import { as, buildOrg, head, makeService, req, specialist, system } from "./test-support";
import type { WorkforceService } from "./workforce-service";

/**
 * The CORE3 ↔ workforce compute seam. `requestFor` had no caller at all; these are the proofs
 * of what the caller may and may not learn from a brain assignment — difficulty and worker
 * capabilities, plus the approval hold, and NEVER a model.
 */

let service: WorkforceService;
let runtime: WorkforceRuntime;
let store: WorkforceStore;

beforeEach(async () => {
  ({ service, runtime, store } = makeService());
  await buildOrg(service, ["CYBER_SECURITY_LEAD", "APPSEC_SPECIALIST"]);
  await head(
    service,
    "security-lead",
    "CYBER_SECURITY_LEAD",
    "security",
    ["repo_read", "scanners", "logs"],
    ["icos"],
  );
  await specialist(
    service,
    "security-lead",
    "appsec-1",
    "APPSEC_SPECIALIST",
    ["repo_read", "scanners"],
    ["icos"],
  );
});

const source = () => workforceTaskCompute({ compute: runtime.compute, store, system });

/** The parent assignment the last `assign()` delegated under, so a SECOND one can reuse it. */
let parentAssignmentId: string | null = null;

/** One assignment on `mission-sec` / `appsec`, optionally gated by an action class. */
async function assign(actionClass?: string) {
  const top = await service.delegate(as("icos-central"), {
    requests: [req("mission-sec", "audit", ["threat_modeling"], "icos")],
    parentAssignmentId: null,
  });
  await service.start(as("security-lead"), top.assignments[0].assignmentId);
  parentAssignmentId = top.assignments[0].assignmentId;
  const sub = await service.delegate(as("security-lead"), {
    requests: [req("mission-sec", "appsec", ["appsec"], "icos", actionClass)],
    parentAssignmentId: top.assignments[0].assignmentId,
  });
  expect(sub.gaps).toEqual([]);
  return sub.assignments[0];
}

describe("workforceTaskCompute", () => {
  it("turns a brain assignment into capabilities + difficulty, and never names a model", async () => {
    const a = await assign();
    const need = await source().forTask("mission-sec", "appsec");
    expect(need).toEqual({
      assignmentIds: [a.assignmentId],
      agentIds: ["appsec-1"],
      // The bootstrap skills declare no worker capabilities: the brain ADDS none here, and
      // saying so is the point — an empty list must never be mistaken for a wildcard.
      workerCapabilities: [],
      complexity: "high",
      approvalPending: false,
    });
    expect(JSON.stringify(need)).not.toMatch(/model|opus|sonnet|haiku|gpt|nemotron|claude/i);
  });

  it("reports a missing human approval as pending, so CORE3 holds the dispatch", async () => {
    await assign("destructive_remediation");
    expect(await source().forTask("mission-sec", "appsec")).toMatchObject({
      approvalPending: true,
    });
  });

  it("answers null for a task no brain is assigned to, and once the assignment is running", async () => {
    const a = await assign();
    expect(await source().forTask("mission-sec", "autre-tache")).toBeNull();
    expect(await source().forTask("autre-mission", "appsec")).toBeNull();
    await service.start(as("appsec-1"), a.assignmentId);
    expect(await source().forTask("mission-sec", "appsec")).toBeNull();
  });

  it("is composed ready-to-use on the runtime, bound to its own system principal", async () => {
    const a = await assign();
    // What the integrator actually passes to the supervisor — no store, no `runtime` facet.
    expect(await runtime.core3Compute.forTask("mission-sec", "appsec")).toMatchObject({
      assignmentIds: [a.assignmentId],
      agentIds: ["appsec-1"],
    });
  });

  /**
   * VERROU C6 — LE CONTOURNEMENT D'APPROBATION PAR ORDRE LEXICOGRAPHIQUE.
   *
   * Ce seam prenait la PREMIÈRE affectation vivante trouvée, c'est-à-dire la première par
   * ordre d'id. Deux affectations vivantes sur la même tâche de mission — une reprise, une
   * ré-affectation, une double écriture — et la plus STRICTE pouvait être tout simplement
   * ignorée : sa capacité supplémentaire disparaissait du routage et, bien pire, son
   * approbation humaine requise cessait de retenir le dispatch.
   *
   * Un contrôle qu'on contourne en nommant son id « avant » l'autre n'est pas un contrôle.
   */
  describe("plusieurs affectations vivantes sur UNE tâche : la plus stricte gagne", () => {
    /*
     * Deux affectations vivantes sur une tâche demandent DEUX agents : le service refuse
     * d'en donner deux au même. C'est exactement le cas réel — une ré-affectation vers un
     * autre cerveau, ou une seconde délégation — et c'est là que l'ordre lexicographique
     * décidait laquelle comptait.
     */
    beforeEach(async () => {
      await specialist(
        service,
        "security-lead",
        "appsec-2",
        "APPSEC_SPECIALIST",
        ["repo_read", "scanners"],
        ["icos"],
      );
    });

    /** Une seconde affectation vivante sur la MÊME tâche, gated par une classe d'action. */
    const second = async (actionClass?: string) => {
      const sub = await service.delegate(as("security-lead"), {
        requests: [req("mission-sec", "appsec", ["appsec"], "icos", actionClass)],
        parentAssignmentId,
      });
      expect(sub.gaps).toEqual([]);
      return sub.assignments[0]!;
    };

    it("une approbation requise sur la SECONDE retient quand même le dispatch", async () => {
      await assign(); // la première : aucune approbation requise
      await second("destructive_remediation"); // la seconde : approbation humaine requise

      const need = await source().forTask("mission-sec", "appsec");
      /* Avant le correctif : `approvalPending: false`, et la tâche partait. */
      expect(need?.approvalPending).toBe(true);
      expect(need?.assignmentIds).toHaveLength(2);
    });

    it("l'ordre des affectations ne change RIEN au résultat", async () => {
      await assign("destructive_remediation"); // la stricte d'abord
      await second();
      const strictFirst = await source().forTask("mission-sec", "appsec");
      expect(strictFirst?.approvalPending).toBe(true);
      /* Le même couple dans l'autre sens est déjà couvert par le test précédent. */
      expect(strictFirst?.assignmentIds).toHaveLength(2);
    });

    it("rend l'UNION des capacités et la difficulté la PLUS HAUTE, jamais la première venue", async () => {
      /*
       * Prouvé contre un faux `requestFor`, parce que les gabarits d'amorçage ne déclarent
       * aucune capacité worker et ne peuvent donc pas distinguer union et première. Le vrai
       * chemin reste couvert par les tests ci-dessus ; celui-ci isole la COMPOSITION.
       */
      await assign();
      await second();

      /* Chaque affectation répond une capacité et une difficulté DIFFÉRENTES. */
      const answers = [
        { caps: ["a"], complexity: "low" as const },
        { caps: ["b"], complexity: "high" as const },
      ];
      let nth = 0;
      const need = await workforceTaskCompute({
        store,
        system,
        compute: {
          requestFor: async (_p: unknown, assignmentId: string) => {
            const answer = answers[nth++ % answers.length]!;
            return {
              assignmentId,
              agent: { agentId: "appsec-1" },
              workerRequirement: { requiredCapabilities: answer.caps },
              compute: { complexity: answer.complexity },
              approval: { required: false, satisfied: true },
            };
          },
        } as never,
      }).forTask("mission-sec", "appsec");

      /* Ni la première ni la dernière : les DEUX, et la difficulté la plus haute. */
      expect(new Set(need?.workerCapabilities)).toEqual(new Set(["a", "b"]));
      expect(need?.complexity).toBe("high");
    });
  });

  it("refuses to answer a caller that is not the trusted runtime", async () => {
    await assign();
    const forged = { ...system };
    await expect(
      workforceTaskCompute({ compute: runtime.compute, store, system: forged }).forTask(
        "mission-sec",
        "appsec",
      ),
    ).rejects.toThrow();
  });
});
