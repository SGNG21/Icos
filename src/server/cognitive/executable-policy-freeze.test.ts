import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * REGRESSION (P0 autonomy unblock, bisected to 94826fc): `executable-policy` freezes its
 * allowlist when first IMPORTED. The self-model probes once imported it statically, so any
 * process that loaded the cognitive module before publishing its deployment froze an EMPTY
 * allowlist — every governed run was then refused, workers wrote nothing, and the gate
 * answered `diff vide`. Loading the cognitive module must never be what freezes it.
 */
describe("loading the cognitive runtime never freezes the executable allowlist", () => {
  const saved = process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST;
  afterEach(() => {
    if (saved === undefined) delete process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST;
    else process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = saved;
    vi.resetModules();
  });

  it("an allowlist published AFTER importing @/server/cognitive is the one enforced", async () => {
    vi.resetModules();
    delete process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST;
    await import("@/server/cognitive/index");
    process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify(["node"]);
    const { decideExecutable } = await import("@/core/execution/executable-policy");
    expect(decideExecutable("node", []).allowed).toBe(true);
  }, 60_000);
});
