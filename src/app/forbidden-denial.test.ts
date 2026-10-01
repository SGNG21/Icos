import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import nextConfig from "../../next.config";

/**
 * FORBIDDEN_RETURNS_CONTROLLED_DENIAL.
 *
 * `forbidden()` + `src/app/forbidden.tsx` is the repo-wide denial for an AUTHENTICATED caller
 * without permission. Next gates `forbidden()` behind `experimental.authInterrupts`: without
 * the flag the call threw E488 ("`forbidden()` is experimental...") instead of interrupting,
 * so every such denial became a 500 and `forbidden.tsx` was unreachable. Next turns the flag
 * into `process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS` at build time
 * (next/dist/build/define-env.js), which is what the two runtime cases below exercise.
 */
describe("FORBIDDEN_RETURNS_CONTROLLED_DENIAL", () => {
  it("the config enables the interrupt that forbidden() requires", () => {
    expect(nextConfig.experimental?.authInterrupts).toBe(true);
  });

  /*
   * THE LINK between the two halves below, which would otherwise be asserted only in a comment:
   * a Next upgrade that renamed either side would leave every other case here green while every
   * denial silently returned to 500. This fails loudly instead.
   */
  it("Next still derives the runtime flag from that config key", () => {
    const defineEnv = readFileSync(
      require.resolve("next/dist/build/define-env.js", { paths: [process.cwd()] }),
      "utf8",
    );
    expect(defineEnv).toContain("process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS");
    expect(defineEnv).toContain("config.experimental.authInterrupts");
  });

  it("the 403 boundary that renders the denial exists", () => {
    expect(existsSync(new URL("./forbidden.tsx", import.meta.url))).toBe(true);
  });

  it("forbidden() interrupts with a 403 digest once the flag is on", () => {
    const script = `
      process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS = "1";
      const { forbidden } = require("next/navigation");
      try { forbidden(); } catch (e) { console.log(JSON.stringify({ digest: e.digest, code: e.__NEXT_ERROR_CODE })); }
    `;
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const { digest, code } = JSON.parse(out) as { digest?: string; code?: string };
    expect(digest).toBe("NEXT_HTTP_ERROR_FALLBACK;403");
    expect(code).not.toBe("E488");
  });

  it("without the flag it would be the E488 500 this fix removes", () => {
    const script = `
      delete process.env.__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS;
      const { forbidden } = require("next/navigation");
      try { forbidden(); } catch (e) { console.log(JSON.stringify({ digest: e.digest ?? null, code: e.__NEXT_ERROR_CODE })); }
    `;
    const out = execFileSync(process.execPath, ["-e", script], { encoding: "utf8" });
    const { digest, code } = JSON.parse(out) as { digest: string | null; code?: string };
    expect(code).toBe("E488");
    expect(digest).toBeNull();
  });

  /** NO_AUTH_WEAKENING: the flag changes the DENIAL's shape, never who is denied. */
  it("every forbidden() call still sits behind a permission or role guard", () => {
    const callers = execFileSync("git", ["grep", "-l", "forbidden()", "--", "src/app"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.endsWith(".tsx"));

    expect(callers.length).toBeGreaterThan(0);
    for (const file of callers) {
      const source = readFileSync(file, "utf8");
      expect(
        /requirePermission|requireRole|resolveCockpitAccess|humanAdministration/.test(source),
        file,
      ).toBe(true);
    }
  });
});
