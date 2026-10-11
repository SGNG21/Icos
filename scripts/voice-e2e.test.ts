/**
 * THE HARNESS MUST REFUSE A BAD COMMAND LINE BEFORE IT ASKS FOR A PASSWORD.
 *
 * The defect this pins, measured on the VPS: `tsx scripts/voice-e2e.ts <base>` with its
 * three WAV fixtures missing ran the unauthenticated-upgrade probe, prompted the owner for
 * their password, opened the voice socket — and only then died inside `speak` with
 *
 *     Cannot read properties of undefined (reading 'length')
 *
 * because `const [base, ...wavs]` happily yields `undefined` for every fixture that was
 * never passed. The cost of the mistake (a whole run plus a password entry) was unrelated
 * to its size (one missing argument), and the message named no frame.
 *
 * These cases run the real script as a subprocess — the only way to test a file whose argv
 * parsing and `main()` are module-level side effects — with stdin closed and no password in
 * the environment, so nothing here can reach the network or a terminal.
 */
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/** A host that cannot resolve: if a case ever got as far as the network, it would say so. */
const BASE = "https://voice-e2e-must-not-dial.invalid";

function run(args: string[]): { status: number; output: string } {
  try {
    const stdout = execFileSync("node_modules/.bin/tsx", ["scripts/voice-e2e.ts", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: {
        ...process.env,
        /* No credential reachable from here, by construction. */
        ICOS_OWNER_PASSWORD: "",
        ICOS_OWNER_EMAIL: "harness-case@voice-e2e.invalid",
      },
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const spawned = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: spawned.status ?? -1,
      output: `${spawned.stdout ?? ""}${spawned.stderr ?? ""}`,
    };
  }
}

describe("voice-e2e argv validation — a bad command line costs one line, not one run", () => {
  it("REGRESSION: no fixtures is refused by name, not as `reading 'length'`", () => {
    const { status, output } = run([BASE]);

    expect(output).toContain("needs exactly 3 WAV fixtures, got 0");
    expect(output).toContain("--auth-only");
    /* The exact crash this test exists to forbid. */
    expect(output).not.toContain("Cannot read properties of undefined");
    /* And it must stop BEFORE the password and the socket. */
    expect(output).not.toContain("Mot de passe owner");
    expect(output).not.toContain("sign-in");
    expect(status).toBe(1);
  }, 60_000);

  it("REGRESSION: a partial fixture list is refused too, and says how many arrived", () => {
    const { status, output } = run([BASE, "q1.wav", "q2.wav"]);

    expect(output).toContain("needs exactly 3 WAV fixtures, got 2");
    expect(output).not.toContain("Cannot read properties of undefined");
    expect(status).toBe(1);
  }, 60_000);

  it("a markdown-wrapped URL is named as such, where `new URL` only said Invalid URL", () => {
    const { status, output } = run([`[${BASE}](${BASE})`, "a.wav", "b.wav", "c.wav"]);

    expect(output).toContain("bare http(s)://host");
    expect(output).not.toContain("Invalid URL");
    expect(status).toBe(1);
  }, 60_000);

  it("CONTROL: --auth-only still needs no fixture at all — the guard must not block it", () => {
    const { status, output } = run([BASE, "--auth-only"]);

    /* It passes validation and reaches the credential, where a closed stdin stops it. */
    expect(output).toContain("stdin is not a terminal");
    expect(output).not.toContain("WAV fixtures");
    expect(status).toBe(1);
  }, 60_000);

  it("CONTROL: a complete fixture list passes validation and fails on the fixture itself", () => {
    const { status, output } = run([BASE, "nope-1.wav", "nope-2.wav", "nope-3.wav"]);

    /* Past the argv guard, so the next real problem is the unreadable file — not argv. */
    expect(output).not.toContain("WAV fixtures");
    expect(output).toMatch(/ENOENT|no such file/);
    expect(status).toBe(1);
  }, 60_000);
});
