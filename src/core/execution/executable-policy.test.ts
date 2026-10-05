import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify(["/opt/bin/hermes", "codex"]);
});

import { decideExecutable } from "./executable-policy";

/**
 * EXECUTABLE AUTHORITY IS NOT CREDENTIAL AUTHORITY.
 *
 * The activity used to refuse any command missing from `EXECUTOR_ACCESS`, so a table of
 * "which secrets may this agent read" was also deciding "which binaries may ICOS run".
 * Two concerns in one table gets both wrong: widening it so a governed writer could run
 * would have handed that writer somebody else's credentials, and the two hardcoded names
 * were the reason no writer could run at all.
 */
describe("the governed executable policy", () => {
  it("UNKNOWN_EXECUTABLE_DENIED: default deny, whatever the declaration says", () => {
    /* Appearing in ICOS_WORKER_EXEC_COMMANDS is a HOW, not a may. */
    expect(decideExecutable("/usr/bin/curl", [])).toMatchObject({
      allowed: false,
      reason: "EXECUTABLE_NOT_ALLOWED",
    });
    expect(decideExecutable("", [])).toMatchObject({ allowed: false });
  });

  it("allows an explicitly authorised executable, by path or by name", () => {
    expect(decideExecutable("/opt/bin/hermes", ["--prompt", "x"]).allowed).toBe(true);
    /* Allowed by bare name, so the declaration's path form is not load-bearing. */
    expect(decideExecutable("/usr/local/bin/codex", ["exec"]).allowed).toBe(true);
  });

  it("does not confuse a lookalike basename with an allowed path", () => {
    expect(decideExecutable("/tmp/evil/hermes-wrapper", []).allowed).toBe(false);
  });

  it("refuses an inline shell even if the shell itself were allowed", () => {
    /*
     * `bash -c '…'` collapses a structured argv into a string no policy can inspect, so
     * allowing the interpreter would allow everything it can spawn.
     */
    for (const shell of ["/bin/sh", "/bin/bash", "/usr/bin/zsh"]) {
      expect(decideExecutable(shell, ["-c", "rm -rf /"])).toMatchObject({
        allowed: false,
      });
    }
  });

  describe("CALLER_CANNOT_EXTEND_EXECUTABLE_ALLOWLIST", () => {
    it("a later environment write cannot widen it", () => {
      process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify(["/usr/bin/curl", "anything"]);

      /* Read once at load: nothing re-reads the variable, so nothing can widen it. */
      expect(decideExecutable("/usr/bin/curl", []).allowed).toBe(false);
      expect(decideExecutable("/opt/bin/hermes", []).allowed).toBe(true);
    });

    it("deleting the variable cannot empty it either — the decision is already made", () => {
      delete process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST;

      expect(decideExecutable("/opt/bin/hermes", []).allowed).toBe(true);
    });
  });

  it("EXECUTABLE_POLICY_SEPARATE_FROM_SECRET_POLICY: it decides nothing about secrets", () => {
    /*
     * The allowed set here and the credential table share no entry by construction: this
     * module imports nothing and exports only a verdict about the program.
     */
    const decision = decideExecutable("/opt/bin/hermes", []);
    expect(Object.keys(decision).sort()).toEqual(["allowed", "reason"]);
  });
});

describe("an unreadable or absent policy denies everything", () => {
  it("refuses when no allowlist was configured", async () => {
    vi.resetModules();
    delete process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST;
    const fresh = await import("./executable-policy");

    expect(fresh.decideExecutable("/opt/bin/hermes", [])).toMatchObject({
      allowed: false,
      reason: "EXECUTABLE_POLICY_EMPTY",
    });
  });

  it("refuses when the allowlist is malformed, rather than guessing", async () => {
    vi.resetModules();
    process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = "not json at all";
    const fresh = await import("./executable-policy");

    expect(fresh.decideExecutable("/opt/bin/hermes", []).allowed).toBe(false);
  });
});
