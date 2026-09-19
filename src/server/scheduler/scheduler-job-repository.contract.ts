import { describe, expect, it } from "vitest";

import type { ScheduledJobRepository } from "@/core/contracts/scheduler";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (deltaMs: number) => new Date(Date.now() + deltaMs);
let seq = 0;
const job = (overrides: Record<string, unknown> = {}) => ({
  kind: "start_mission" as const,
  payload: { title: "t", objective: "o" },
  payloadHash: `hash-${++seq}`,
  idempotencyKey: `key-${seq}-${Math.random()}`,
  runAt: at(-1_000),
  ...overrides,
});

/**
 * Contrat du Durable Scheduler : exécuté contre l'implémentation in-memory ET
 * contre PostgreSQL réel (base de test). `make` fournit un dépôt neuf et vide.
 */
export function describeScheduledJobRepositoryContract(
  name: string,
  make: () => Promise<ScheduledJobRepository>,
): void {
  describe(`ScheduledJobRepository contract — ${name}`, () => {
    it("persists a job and does not run a future job too early", async () => {
      const repo = await make();
      const { job: created, created: isNew } = await repo.enqueue(job({ runAt: at(60_000), priority: 3 }));
      expect(isNew).toBe(true);
      expect(created).toMatchObject({ state: "scheduled", attemptCount: 0, priority: 3, maxAttempts: 5 });

      expect(await repo.claimDue("owner-a", 1_000)).toBeNull();
      expect((await repo.getById(created.id))?.state).toBe("scheduled");
    });

    it("claims a due job atomically and records the lease", async () => {
      const repo = await make();
      const { job: created } = await repo.enqueue(job());
      const claimed = await repo.claimDue("owner-a", 60_000);
      expect(claimed).toMatchObject({
        id: created.id,
        state: "running",
        attemptCount: 1,
        leaseOwner: "owner-a",
      });
      expect(claimed!.leaseUntil!.getTime()).toBeGreaterThan(Date.now());
      expect(await repo.claimDue("owner-b", 60_000)).toBeNull();
    });

    it("never hands the same job to two concurrent claimers", async () => {
      const repo = await make();
      await repo.enqueue(job());
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => repo.claimDue(`owner-${i}`, 60_000)),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("spreads several due jobs over concurrent claimers without duplicates", async () => {
      const repo = await make();
      const ids = new Set<string>();
      for (let i = 0; i < 3; i++) ids.add((await repo.enqueue(job())).job.id);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => repo.claimDue(`owner-${i}`, 60_000)),
      );
      const claimed = results.filter((j) => j !== null).map((j) => j!.id);
      expect(claimed).toHaveLength(3);
      expect(new Set(claimed)).toEqual(ids);
    });

    it("claims the highest priority first", async () => {
      const repo = await make();
      const low = (await repo.enqueue(job({ priority: 0 }))).job;
      const high = (await repo.enqueue(job({ priority: 10 }))).job;
      expect((await repo.claimDue("o", 60_000))?.id).toBe(high.id);
      expect((await repo.claimDue("o", 60_000))?.id).toBe(low.id);
    });

    it("reclaims an expired lease and fences the evicted owner", async () => {
      const repo = await make();
      const { job: created } = await repo.enqueue(job());
      await repo.claimDue("owner-a", 40);
      expect(await repo.claimDue("owner-b", 40)).toBeNull(); // lease still active
      await sleep(90);

      const reclaimed = await repo.claimDue("owner-b", 60_000);
      expect(reclaimed).toMatchObject({ id: created.id, attemptCount: 2, leaseOwner: "owner-b" });

      expect(await repo.renewLease(created.id, "owner-a", 1_000)).toBe(false);
      expect(await repo.complete(created.id, "owner-a")).toBe(false);
      expect((await repo.fail(created.id, "owner-a", "late", { retryable: true })).ok).toBe(false);
      expect(await repo.complete(created.id, "owner-b")).toBe(true);
      const done = await repo.getById(created.id);
      expect(done).toMatchObject({ state: "succeeded" });
      expect(done!.completedAt).toBeInstanceOf(Date);
      expect(await repo.claimDue("owner-c", 1_000)).toBeNull();
    });

    it("renews a lease for its owner only", async () => {
      const repo = await make();
      const { job: created } = await repo.enqueue(job());
      await repo.claimDue("owner-a", 60);
      expect(await repo.renewLease(created.id, "owner-a", 60_000)).toBe(true);
      await sleep(100);
      expect(await repo.claimDue("owner-b", 1_000)).toBeNull(); // renewed
      expect(await repo.renewLease(created.id, "owner-b", 1_000)).toBe(false);
    });

    it("kills a job that keeps crashing after max attempts (no infinite retry)", async () => {
      const repo = await make();
      const { job: created } = await repo.enqueue(job({ maxAttempts: 2 }));
      await repo.claimDue("a", 30);
      await sleep(70);
      await repo.claimDue("b", 30);
      await sleep(70);
      expect(await repo.claimDue("c", 1_000)).toBeNull();
      expect(await repo.getById(created.id)).toMatchObject({ state: "dead", attemptCount: 2 });
      expect((await repo.getById(created.id))?.lastError).toContain("SCHEDULER_MAX_ATTEMPTS_EXCEEDED");
    });

    it("rejects a duplicate logical job by idempotency key, and a conflicting reuse of the key", async () => {
      const repo = await make();
      const first = await repo.enqueue(job({ idempotencyKey: "k1", payloadHash: "h1" }));
      const replay = await repo.enqueue(job({ idempotencyKey: "k1", payloadHash: "h1" }));
      expect(replay.created).toBe(false);
      expect(replay.job.id).toBe(first.job.id);
      await expect(repo.enqueue(job({ idempotencyKey: "k1", payloadHash: "other" }))).rejects.toThrow(
        "SCHEDULER_IDEMPOTENCY_CONFLICT",
      );
    });

    it("creates exactly one job when the same key is enqueued concurrently", async () => {
      const repo = await make();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => repo.enqueue(job({ idempotencyKey: "same", payloadHash: "h" }))),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    });

    it("retries with a durable backoff, then dies when attempts are exhausted", async () => {
      const repo = await make();
      const { job: slow } = await repo.enqueue(job({ backoffBaseMs: 60_000, maxAttempts: 3 }));
      await repo.claimDue("a", 60_000);
      const failed = await repo.fail(slow.id, "a", "boom", { retryable: true });
      expect(failed).toEqual({ ok: true, state: "scheduled" });
      const after = await repo.getById(slow.id);
      expect(after).toMatchObject({ state: "scheduled", lastError: "boom", attemptCount: 1 });
      expect(after!.leaseOwner).toBeUndefined();
      const delay = after!.nextRunAt.getTime() - Date.now();
      expect(delay).toBeGreaterThan(55_000);
      expect(delay).toBeLessThan(65_000);
      expect(await repo.claimDue("b", 1_000)).toBeNull(); // not before the backoff

      const { job: quick } = await repo.enqueue(job({ backoffBaseMs: 0, maxAttempts: 3 }));
      for (let attempt = 1; attempt <= 3; attempt++) {
        const claimed = await repo.claimDue("q", 60_000);
        expect(claimed).toMatchObject({ id: quick.id, attemptCount: attempt });
        const result = await repo.fail(quick.id, "q", `e${attempt}`, { retryable: true });
        expect(result.state).toBe(attempt < 3 ? "scheduled" : "dead");
      }
      expect(await repo.claimDue("q", 1_000)).toBeNull();
    });

    it("kills a job immediately on a non retryable failure", async () => {
      const repo = await make();
      const { job: created } = await repo.enqueue(job());
      await repo.claimDue("a", 60_000);
      expect(await repo.fail(created.id, "a", "bad payload", { retryable: false })).toEqual({
        ok: true,
        state: "dead",
      });
      expect(await repo.claimDue("b", 1_000)).toBeNull();
    });

    it("never runs a job whose deadline has passed", async () => {
      const repo = await make();
      const { job: created } = await repo.enqueue(job({ deadlineAt: at(-500) }));
      expect(await repo.claimDue("a", 60_000)).toBeNull();
      expect((await repo.getById(created.id))?.state).toBe("expired");
    });
  });
}
