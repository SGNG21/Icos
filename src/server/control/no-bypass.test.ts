import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Structural proof that nothing can change control state except the command
 * bus (decision 0044). Scans shipped source, not tests.
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
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));
const offenders = (predicate: (s: { path: string; text: string }) => boolean) =>
  sources
    .filter(predicate)
    .map((s) => s.path)
    .sort();

describe("control state has exactly one writer", () => {
  it("only the control store and the schema touch the control tables", () => {
    const tables =
      /\b(controlCommands|controlStateVersions|runtimeControlFlags|missionControlHolds|controlReauthProofs)\b|\b(control_commands|control_state_versions|runtime_control_flags|mission_control_holds|control_reauth_proofs)\b/;
    expect(offenders((s) => tables.test(s.text))).toEqual([
      "server/control/postgres-control-store.ts",
      "server/database/schema.ts",
    ]);
  });

  it("only the command bus applies holds and flags", () => {
    const writes = /\.(setHold|clearHold|setFlags|setVersion|consumeProof)\(/;
    expect(
      offenders(
        (s) =>
          writes.test(s.text) &&
          !s.path.startsWith("server/control/postgres-control-store") &&
          !s.path.startsWith("server/control/in-memory-control-store"),
      ),
    ).toEqual(["server/control/command-bus.ts"]);
  });

  it("only the commands route executes commands", () => {
    expect(offenders((s) => /\.bus\.execute\(/.test(s.text))).toEqual([
      "app/api/control/commands/route.ts",
    ]);
  });

  it("no client component can reach server-side control code", () => {
    const client = sources.filter((s) => /^["']use client["']/m.test(s.text));
    // Type-only imports are erased at compile time; a VALUE import would ship server code.
    const valueImport = /^import\s+(?!type\b)[^;]*from\s+["']@\/server\//m;
    expect(
      client
        .filter((s) => /@\/server\/control/.test(s.text) || valueImport.test(s.text))
        .map((s) => s.path),
    ).toEqual([]);
  });

  it("the control API only exposes the documented routes", () => {
    expect(
      sources
        .filter((s) => s.path.startsWith("app/api/control/"))
        .map((s) => s.path)
        .sort(),
    ).toEqual([
      "app/api/control/commands/[id]/route.ts",
      "app/api/control/commands/route.ts",
      "app/api/control/reauth/route.ts",
      "app/api/control/state/route.ts",
    ]);
    // Only POST mutates, and only through the bus / re-auth service.
    const state = sources.find((s) => s.path === "app/api/control/state/route.ts")!;
    expect(state.text).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
  });
});
