import { describe, expect, it } from "vitest";

import {
  EXECUTION_OUTCOMES,
  executionOutcomeOf,
  recordLeaksSecret,
  type ExecutionRecord,
} from "./execution-record";

/**
 * L'UNIQUE PIÈCE DURABLE D'UNE EXÉCUTION (verrou C8 §8). Ce qui est vérifié ici : qu'elle
 * répond seule aux questions qu'on lui pose, qu'elle ne peut pas porter de secret, et
 * qu'elle ne prétend pas savoir ce qu'elle ignore.
 */

const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  executionId: "exec-1",
  goalId: "g-1",
  missionId: "m-1",
  taskId: "m-1:builder",
  brainId: "brain-builder",
  workerId: "worker-7",
  executor: "hermes",
  provider: "custom",
  model: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  worktree: "/tmp/icos-worktree-1",
  confinement: "seatbelt",
  networkEnforced: false,
  startedAt: "2026-10-02T20:00:00.000Z",
  endedAt: "2026-10-02T20:00:07.000Z",
  durationMs: 7_000,
  outcome: "COMPLETED",
  exitCode: 0,
  signal: null,
  usage: {
    kind: "MEASURED",
    usage: { promptTokens: 23953, completionTokens: 50, totalTokens: 24003 },
    source: "hermes:usage-file",
  },
  filesChanged: ["src/a.ts"],
  commitBefore: "abc1234",
  commitAfter: "def5678",
  credentialGrants: [
    {
      capabilityId: "nvidia",
      kind: "file",
      target: ".hermes/auth.json",
      grantedAt: "2026-10-02T20:00:00.000Z",
      revokedAt: "2026-10-02T20:00:07.000Z",
    },
  ],
  reviewRequired: true,
  ...over,
});

describe("ExecutionRecord — une seule pièce répond à toutes les questions", () => {
  it("porte le lien complet du goal jusqu'à l'exécutable", () => {
    const r = record();
    for (const field of [
      r.goalId,
      r.missionId,
      r.taskId,
      r.brainId,
      r.workerId,
      r.executor,
      r.model,
      r.worktree,
    ]) {
      expect(field).toBeTruthy();
    }
  });

  it("dit ce qui a RÉELLEMENT confiné, pas ce qu'on croyait configurer", () => {
    expect(record().confinement).toBe("seatbelt");
    /* Et le réseau n'est pas prétendu isolé quand il ne l'est pas. */
    expect(record().networkEnforced).toBe(false);
  });

  it("NE PEUT PAS porter une valeur de secret", () => {
    const secrets = ["sk-ant-xxxx", "postgres://user:motdepasse@h/db", "motdepasse"];
    expect(recordLeaksSecret(record(), secrets)).toBe(false);
    /* Les octrois ne portent que des NOMS de capacités et des instants. */
    expect(JSON.stringify(record().credentialGrants)).not.toMatch(/sk-|motdepasse|postgres:/);
  });

  it("le garde-fou DÉTECTE une fuite, sinon il ne prouverait rien", () => {
    /* Un test qui ne peut pas échouer n'est pas un test : on vérifie le détecteur. */
    const leaky = record({ worktree: "/tmp/sk-ant-xxxx" });
    expect(recordLeaksSecret(leaky, ["sk-ant-xxxx"])).toBe(true);
  });

  it("une consommation NON MESURÉE est dite, jamais remplacée par zéro", () => {
    const r = record({ usage: { kind: "UNMEASURED", reason: "CODEX_TOKENS_ABSENT" } });
    expect(r.usage.kind).toBe("UNMEASURED");
    expect(JSON.stringify(r.usage)).toContain("CODEX_TOKENS_ABSENT");
  });

  it("il n'existe AUCUN champ de coût : aucun exécuteur ne le rapporte honnêtement", () => {
    /*
     * Hermes écrit lui-même `cost_status: "unknown"`. Un champ coût rempli de zéros serait
     * une fabrication ; son absence est la vérité, et ce test empêche de l'ajouter sans y
     * penser.
     */
    expect(Object.keys(record())).not.toContain("cost");
  });
});

describe("executionOutcomeOf — l'ordre de priorité ne flatte jamais le résultat", () => {
  it("un BAIL PERDU l'emporte sur un code de sortie 0", () => {
    /*
     * Le cas qui compte. Un résultat qu'on n'a plus le droit de retenir n'est pas un
     * succès : un autre runner a pu refaire le travail, et deux résultats pour une seule
     * tentative logique est la double-intégration que tout ce niveau existe pour empêcher.
     */
    expect(executionOutcomeOf({ timedOut: false, lostLease: true, exitCode: 0 })).toBe(
      "LEASE_LOST",
    );
  });

  it("une ANNULATION l'emporte sur un succès tardif", () => {
    expect(executionOutcomeOf({ timedOut: false, cancelled: true, exitCode: 0 })).toBe("CANCELLED");
  });

  it("un délai dépassé est TIMED_OUT, même si le processus a rendu un code", () => {
    expect(executionOutcomeOf({ timedOut: true, exitCode: 137 })).toBe("TIMED_OUT");
  });

  it("aucun verdict et aucun délai dépassé = ABANDONNÉ, pas « échoué »", () => {
    /* La distinction qui permet à un balayage de reprendre la tâche au lieu de la clore. */
    expect(executionOutcomeOf({ timedOut: false, exitCode: null })).toBe("ABANDONED");
  });

  it("succès et échec ordinaires", () => {
    expect(executionOutcomeOf({ timedOut: false, exitCode: 0 })).toBe("COMPLETED");
    expect(executionOutcomeOf({ timedOut: false, exitCode: 1 })).toBe("FAILED");
  });

  it("chaque issue déclarée est atteignable par une combinaison de faits", () => {
    const reached = new Set([
      executionOutcomeOf({ timedOut: false, exitCode: 0 }),
      executionOutcomeOf({ timedOut: true, exitCode: null }),
      executionOutcomeOf({ timedOut: false, cancelled: true, exitCode: 0 }),
      executionOutcomeOf({ timedOut: false, lostLease: true, exitCode: 0 }),
      executionOutcomeOf({ timedOut: false, exitCode: null }),
      executionOutcomeOf({ timedOut: false, exitCode: 2 }),
    ]);
    expect([...reached].sort()).toEqual([...EXECUTION_OUTCOMES].sort());
  });
});
