import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Structural proofs for the transversal security fixes. Scans SHIPPED source, not tests, so a
 * new call site cannot reintroduce a defect that was fixed only where the review found it.
 */
const ROOT = join(process.cwd(), "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files(ROOT).map((path) => ({
  path: relative(ROOT, path).replaceAll("\\", "/"),
  text: readFileSync(path, "utf8"),
}));
const offenders = (predicate: (s: { path: string; text: string }) => boolean) =>
  sources
    .filter(predicate)
    .map((s) => s.path)
    .sort();

describe("NO_IMPLICIT_GLOBAL_SCOPE (structural)", () => {
  it("no route or page falls back to a global scope when access is unavailable", () => {
    /*
     * Any shape that MANUFACTURES a global scope outside the access service, not just the
     * original `operationalAccess ? ... : { kind: "global" as const }` ternary: the `as const`,
     * the cast and the `??` spellings all typecheck, so none of them may pass.
     */
    const manufactured =
      /\{\s*kind:\s*"global"\s*\}(\s*(as|satisfies)\s+\w+)?|\{\s*kind:\s*"global"\s+as\s+const\s*\}/;
    /*
     * Two legitimate sites, excluded by path: the ACCESS SERVICE (the only authority allowed to
     * grant a global scope) and the `AgentScope` TYPE, where `{ kind: "global" }` is a union
     * member rather than a produced value.
     */
    const declarations = new Set([
      "server/administration/operational-access-service.ts",
      "server/repositories/ports.ts",
    ]);
    expect(offenders((s) => manufactured.test(s.text) && !declarations.has(s.path))).toEqual([]);
  });

  it("only the access service itself may produce a global scope", () => {
    expect(offenders((s) => /return\s*\{\s*kind:\s*"global"\s*\}/.test(s.text))).toEqual([
      "server/administration/operational-access-service.ts",
    ]);
  });

  it("exactly one resolver consults the access service — no second authority", () => {
    /*
     * Only `mission-scope.ts` may read the service to PRODUCE a scope. `app/page.tsx` is
     * tolerated, not required: it hands `MobileHome` a `null` placeholder (never a scope, never
     * global) and that prop is currently unread. Routing it through the resolver — or deleting
     * the dead prop — must NOT break this test, so it is excluded rather than pinned.
     */
    const resolvers = offenders(
      (s) => /container\.operationalAccess/.test(s.text) && s.path !== "app/page.tsx",
    );
    expect(resolvers).toEqual(["server/administration/mission-scope.ts"]);
  });

  it("every scope consumer anywhere resolves through that one resolver", () => {
    /*
     * Not an allowlist of the routes this lane touched: ANY file that consumes a scope must
     * obtain it from the canonical resolver, so a new fail-open under app/api/missions,
     * app/api/control, control-room or features/ is caught too. The repositories and the
     * access service itself are excluded: they IMPLEMENT scope, they do not resolve it.
     */
    const consumers = offenders(
      (s) =>
        /listForScope\(|getByIdForScope\(|canCreateTaskInScope\(|isMissionInScope\(/.test(s.text) &&
        !/^(server\/(services|repositories|administration|mission|control)|core)\//.test(s.path),
    );
    expect(consumers.length).toBeGreaterThan(0);
    for (const path of consumers) {
      const text = sources.find((s) => s.path === path)!.text;
      expect(text, `${path} must resolve scope through mission-scope`).toContain(
        "@/server/administration/mission-scope",
      );
    }
  });
});

describe("AUTHENTICATED_ACTOR_AUDIT (structural)", () => {
  it("no audit actor is built from a request body", () => {
    /*
     * Receivers that carry a PARSED REQUEST BODY, not every identifier: `input` and `actor` are
     * server-constructed use-case arguments (every such route in this repo fills them from
     * `access.session.user.id`), so matching those only produced false positives.
     */
    expect(
      offenders((s) =>
        /actor:\s*\{[^}]*id:\s*[\w.]*\b(command|body|payload|parsed|request|req)\b[\w.]*\./.test(
          s.text,
        ),
      ),
    ).toEqual([]);
  });

  it("no shipped code reads a decider label off a request command", () => {
    expect(offenders((s) => /(command|body|parsed\.data)\.decidedByLabel/.test(s.text))).toEqual(
      [],
    );
  });

  it("the request contract has no decider field at all", () => {
    const contract = sources.find((s) => s.path === "core/contracts/action-decision.ts")!.text;
    expect(/decidedByLabel\s*:\s*z\./.test(contract)).toBe(false);
    expect(contract).toContain(".strict()");
  });
});

describe("RECOVERY_EXPLICIT_ONLY (structural)", () => {
  it("launch recovery is invoked only by the explicit sweeper", () => {
    expect(offenders((s) => /\.recoverLaunches\(/.test(s.text))).toEqual([
      "server/cognitive/launch-recovery-sweeper.ts",
    ]);
  });

  it("no CLI or script reaches around the sweeper either", () => {
    /*
     * `scripts/` is outside the `src/` scan above, and the recovery lever lives there
     * (`pnpm cognitive:recover-launches`). It must go THROUGH the sweeper, so a future script
     * cannot quietly become a second recovery engine by calling `recoverLaunches` itself.
     */
    const scriptsDir = join(process.cwd(), "scripts");
    const scripts = files(scriptsDir).map((path) => ({
      path: relative(scriptsDir, path),
      text: readFileSync(path, "utf8"),
    }));
    expect(scripts.filter((s) => /\.recoverLaunches\(/.test(s.text)).map((s) => s.path)).toEqual(
      [],
    );
    const lever = scripts.find((s) => s.path === "recover-cognitive-launches.ts");
    expect(lever?.text).toContain("cognitiveLaunchRecoverySweeper");
  });

  it("the explicit sweeper is wired into the production recovery tick", () => {
    const tick = sources.find((s) => s.path === "server/system/production-services.ts")!;
    expect(tick.text).toContain("cognitiveLaunchRecoverySweeper");
    expect(tick.text).toContain('["cognitive-launch-recovery"');
  });
});

describe("SAFE_WORKER_METADATA (structural)", () => {
  it("no read model reads raw worker metadata for a displayed field", () => {
    // Any receiver, not just `w`: `declared(<anything>.metadata, ...)` is the defect shape.
    expect(offenders((s) => /declared\(\s*[A-Za-z_$][\w$]*\.metadata\b/.test(s.text))).toEqual([]);
  });
});
