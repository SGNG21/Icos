import { describe, expect, it } from "vitest";

import type { RecoveryUnitRef, RecoveryUnitRepository } from "@/core/contracts/recovery";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ref = (key = "m1@1"): RecoveryUnitRef => ({ kind: "waiting_settled", key, missionId: "m1" });

/** Contrat partagé in-memory / PostgreSQL. Durées réelles courtes : l'horloge est celle de l'implémentation. */
export function describeRecoveryUnitRepositoryContract(
  name: string,
  create: () => Promise<RecoveryUnitRepository>,
): void {
  describe(`${name} — RecoveryUnitRepository contract`, () => {
    it("grants a unit to exactly one of many concurrent claimants", async () => {
      const repo = await create();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => repo.claim(ref(), `owner-${i}`, 5_000, 5)),
      );
      expect(results.filter((r) => r === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r === "held")).toHaveLength(7);
    });

    it("re-grants after the lease expires (crashed owner), and fences the old owner", async () => {
      const repo = await create();
      expect(await repo.claim(ref(), "dead", 60, 5)).toBe("claimed");
      expect(await repo.claim(ref(), "other", 60, 5)).toBe("held");
      await sleep(120);
      expect(await repo.claim(ref(), "alive", 5_000, 5)).toBe("claimed");
      expect(await repo.complete(ref(), "dead", "resolved")).toBe(false);
      expect(await repo.complete(ref(), "alive", "resolved")).toBe(true);
    });

    it("a resolved unit is never claimable again", async () => {
      const repo = await create();
      await repo.claim(ref(), "a", 5_000, 5);
      await repo.complete(ref(), "a", "resolved");
      expect(await repo.claim(ref(), "b", 5_000, 5)).toBe("resolved");
    });

    it("defer releases without consuming an attempt, after the cooldown", async () => {
      const repo = await create();
      for (let i = 0; i < 4; i += 1) {
        expect(await repo.claim(ref(), `o${i}`, 5_000, 1)).toBe("claimed"); // maxAttempts=1 would exhaust on fail
        expect(await repo.defer(ref(), `o${i}`, "WORKFLOW_RUNNING", 30)).toBe(true);
        await sleep(60);
      }
    });

    it("fail consumes an attempt with backoff; exhaustion is reported exactly once", async () => {
      const repo = await create();
      expect(await repo.claim(ref(), "a", 5_000, 2)).toBe("claimed");
      expect(await repo.fail(ref(), "a", "DISPATCH_FAILED", 40)).toBe(true);
      expect(await repo.claim(ref(), "b", 5_000, 2)).toBe("held"); // backoff running
      await sleep(80);
      expect(await repo.claim(ref(), "b", 5_000, 2)).toBe("claimed");
      expect(await repo.fail(ref(), "b", "DISPATCH_FAILED", 0)).toBe(true);
      await sleep(5);
      const verdicts = await Promise.all([
        repo.claim(ref(), "c", 5_000, 2),
        repo.claim(ref(), "d", 5_000, 2),
      ]);
      expect(verdicts.filter((v) => v === "exhausted")).toHaveLength(1);
      expect(await repo.claim(ref(), "e", 5_000, 2)).toBe("resolved");
    });

    it("different fingerprints are independent units", async () => {
      const repo = await create();
      expect(await repo.claim(ref("m1@1"), "a", 5_000, 5)).toBe("claimed");
      expect(await repo.claim(ref("m1@2"), "b", 5_000, 5)).toBe("claimed");
    });
  });
}
