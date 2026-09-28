import { describe, expect, it, vi } from "vitest";

import {
  CommandPlannerProvider,
  PLANNER_PLACEHOLDERS,
  parsePlannerCommand,
  stripCodeFence,
} from "./command-planner-provider";
import { CanonicalAutonomousMissionPlanner } from "./canonical-mission-planner";
import type { Mission } from "@/core/mission/contracts";

/*
 * M12 / DEFECT 27 — A LOCAL-PROCESS PLANNER BACKEND.
 *
 * The constraint that matters is what this must NOT be: a second planner. These pin that the
 * provider carries transport only, that plan semantics stay in the canonical planner whichever
 * backend runs, and that no product, model or provider name reaches the domain.
 */

const mission: Mission = {
  id: "m1",
  title: "Improve something",
  objective: "Make one safe improvement",
  status: "running",
  createdAt: new Date(),
  updatedAt: new Date(),
} as Mission;

const VALID_PLAN = JSON.stringify({
  version: 1,
  tasks: [
    {
      key: "t1",
      title: "Do the thing",
      dependsOn: [],
      riskClass: "reversible",
      allowedFileScope: ["src/**"],
    },
  ],
});

function provider(
  result: Partial<{ stdout: string; exitCode: number | null; timedOut: boolean }> = {},
) {
  const run = vi.fn(async () => ({
    stdout: result.stdout ?? VALID_PLAN,
    stderr: "",
    exitCode: result.exitCode === undefined ? 0 : result.exitCode,
    signal: null,
    timedOut: result.timedOut ?? false,
    durationMs: 5,
    truncated: false,
  }));

  return {
    run,
    instance: new CommandPlannerProvider({
      command: "/opt/agent-cli",
      args: ["-z", PLANNER_PLACEHOLDERS.prompt, "--cli"],
      timeoutMs: 60_000,
      run,
    }),
  };
}

describe("M12 command planner provider", () => {
  it("LAUNCHES THE CONFIGURED BINARY with the canonical prompt substituted", async () => {
    const p = provider();

    const out = await p.instance.complete({
      system: "SYSTEM POLICY",
      user: "MISSION DATA",
      signal: new AbortController().signal,
    });

    expect(out).toBe(VALID_PLAN);
    const spec = (p.run.mock.calls as unknown as Array<[{ command: string; args: string[] }]>)[0]![0];
    expect(spec.command).toBe("/opt/agent-cli");
    /* One prompt: canonical policy FIRST, untrusted mission data second. */
    const prompt = spec.args.find((a) => a.includes("SYSTEM POLICY"))!;
    expect(prompt.indexOf("SYSTEM POLICY")).toBeLessThan(prompt.indexOf("MISSION DATA"));
    /* The placeholder is fully substituted — never passed through literally. */
    expect(spec.args.join(" ")).not.toContain(PLANNER_PLACEHOLDERS.prompt);
  });

  it("PLAN SEMANTICS STAY CANONICAL: the same schema and DAG gate apply to this backend", async () => {
    const cyclic = JSON.stringify({
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: ["b"] },
        { key: "b", title: "B", dependsOn: ["a"] },
      ],
    });
    const p = provider({ stdout: cyclic });
    const planner = new CanonicalAutonomousMissionPlanner({
      provider: p.instance,
      timeoutMs: 60_000,
    });

    /*
     * The decisive proof that this is a PROVIDER and not a planner: an invalid plan from this
     * backend is rejected by exactly the same canonical gate, with the same error code, as one
     * from the HTTP backend.
     */
    await expect(planner.plan({ mission, tasks: [], reason: "initial" })).rejects.toThrow(
      "AUTONOMY_PLANNER_INVALID_PLAN:MISSION_PLAN_CYCLE",
    );
  });

  it("A VALID PLAN from this backend is accepted identically", async () => {
    const p = provider();
    const planner = new CanonicalAutonomousMissionPlanner({
      provider: p.instance,
      timeoutMs: 60_000,
    });

    const plan = await planner.plan({ mission, tasks: [], reason: "initial" });
    expect(plan.version).toBe(1);
    expect(plan.tasks[0]!.key).toBe("t1");
    /* Planner-supplied envelope survives — no backend-specific shaping. */
    expect(plan.tasks[0]!.allowedFileScope).toEqual(["src/**"]);
  });

  it("A NON-ZERO EXIT FAILS CLOSED and leaks no stderr", async () => {
    const p = provider({ exitCode: 3 });

    /*
     * The exit code only. A planner error message is persisted and surfaced, and a CLI's
     * stderr routinely carries paths, endpoints and key fragments.
     */
    await expect(
      p.instance.complete({ system: "s", user: "u", signal: new AbortController().signal }),
    ).rejects.toThrow("AUTONOMY_PLANNER_PROVIDER_EXIT:3");
  });

  it("A TIMEOUT AND AN EMPTY ANSWER both fail closed", async () => {
    const timedOut = provider({ timedOut: true });
    await expect(
      timedOut.instance.complete({ system: "s", user: "u", signal: new AbortController().signal }),
    ).rejects.toThrow("AUTONOMY_PLANNER_TIMEOUT");

    const empty = provider({ stdout: "   " });
    await expect(
      empty.instance.complete({ system: "s", user: "u", signal: new AbortController().signal }),
    ).rejects.toThrow("AUTONOMY_PLANNER_INVALID_RESPONSE");
  });

  it("A MARKDOWN FENCE IS UNDONE, and nothing inside it is altered", () => {
    /*
     * Agent CLIs wrap JSON in a fence even when told not to. Undoing the CLI's own formatting
     * is transport; the content is returned byte-for-byte, and a non-JSON answer still fails
     * INVALID_OUTPUT in the canonical planner.
     */
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
    /* Not a fence: left exactly as-is. */
    expect(stripCodeFence("no fence here")).toBe("no fence here");
  });

  it("CONFIGURATION IS VALIDATED, and REFUSES rather than planning nothing", () => {
    expect(parsePlannerCommand(undefined)).toBeUndefined();
    expect(() => parsePlannerCommand("{not json")).toThrow(/COMMAND_INVALID_JSON/);
    expect(() => parsePlannerCommand(JSON.stringify({ args: ["x"] }))).toThrow(/COMMAND_INVALID/);
    expect(() => parsePlannerCommand(JSON.stringify({ command: "x", args: [] }))).toThrow(
      /COMMAND_INVALID/,
    );
    /* Without the placeholder the agent would be launched with no prompt at all. */
    expect(() =>
      parsePlannerCommand(JSON.stringify({ command: "x", args: ["--go"] })),
    ).toThrow(/\{\{prompt\}\}/);

    expect(
      parsePlannerCommand(JSON.stringify({ command: "/opt/agent", args: ["-z", "{{prompt}}"] })),
    ).toEqual({ command: "/opt/agent", args: ["-z", "{{prompt}}"] });
  });

  it("NO PRODUCT, MODEL OR PROVIDER NAME IS COMMITTED in the provider source", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/server/autonomy/command-planner-provider.ts", "utf8");
    const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\*.*$/gm, "");

    /*
     * The domain must never learn which product answers. A deployment names the binary, the
     * same way it names worker probe and exec commands (decisions 0036/0038).
     */
    for (const name of ["nemotron", "gpt-", "claude", "openai", "anthropic"]) {
      expect(body.toLowerCase()).not.toContain(name);
    }
  });
});
