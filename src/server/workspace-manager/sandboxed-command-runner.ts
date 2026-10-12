import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { createEphemeralHome, type EphemeralHome } from "@/server/workers/process/ephemeral-home";
import { runNonInteractive, type NonInteractiveRunner } from "@/server/workers/process/run-process";

import type { CommandRunner, GateCommandContext } from "./integration-gate";

/**
 * THE INTEGRATION GATE RUNS WORKER-AUTHORED CODE. It must run it like a worker.
 *
 * ── WHAT WAS BROKEN (P0) ───────────────────────────────────────────────────────────────
 * `pnpm run typecheck|lint|test|build` and `test:integration` execute what the worker
 * wrote: its test files, its configs, its package scripts, any module those import. The
 * gate launched them with `execFile` and `{ ...process.env }` minus three database
 * variables — so worker code ran OUTSIDE any sandbox with the server's model keys, auth
 * secret and every other credential in its environment, and could read `~/.ssh` or the
 * live checkout from disk. The worker itself had been confined (verrou C8, ADR 0073); the
 * gate re-opened everything one step later, on the same code.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────────
 * One runner, the same as the workers': `runNonInteractive`.
 *   - environment: the platform allowlist and what the gate names, nothing inherited —
 *     `envPassthrough: []`, so even the deployment's worker passthrough does not apply;
 *   - disk: the worktree (read-write), a disposable HOME (read-write) and the package
 *     store (read-only, public packages only). Not the real HOME, not another worktree,
 *     not the canonical checkout;
 *   - network: denied by the OS for every step. The PostgreSQL step reaches its disposable
 *     database through a UNIX socket ICOS bind-mounts in (H1, `disposable-gate-database.ts`);
 *   - confinement REQUIRED: no backend means the step FAILS. A gate that says PASS on code
 *     it could not contain would authorise integration on a lie.
 */

export interface SandboxedCommandRunnerOptions {
  /** Injectable for tests; production uses the canonical runner. */
  readonly run?: NonInteractiveRunner;
  /** Read-only grants (toolchain caches). Default: the pnpm store, if present. */
  readonly readOnlyPaths?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly createHome?: () => Promise<EphemeralHome>;
}

export const GATE_COMMAND_TIMEOUT_MS = 20 * 60_000;
const GATE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Where pnpm keeps its content-addressed store. It holds PUBLIC packages only, and an
 * offline install inside the sandbox cannot work without reading it. Never the HOME itself,
 * never an ancestor of it: a grant that broad would be no sandbox at all.
 */
export function defaultToolchainReadOnlyPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string[] {
  const candidates = [
    env.PNPM_STORE_DIR,
    env.XDG_DATA_HOME ? path.join(env.XDG_DATA_HOME, "pnpm", "store") : undefined,
    path.join(home, ".local", "share", "pnpm", "store"),
  ];
  const out = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    const covers = (outer: string, inner: string) =>
      inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
    if (real === "/" || covers(real, home)) continue;
    out.add(real);
  }
  return [...out];
}

/**
 * THE SETTINGS THAT MAKE `pnpm install --frozen-lockfile --offline` TRUE INSIDE THE SANDBOX.
 *
 * Measured on pnpm 11.10 (VPS, 2026-10-12): without them the install hangs for minutes and
 * fails, in three ways, each one a request the sandbox rightly refuses.
 *  - `store_dir`: pnpm derives its store from HOME, and HOME is ephemeral here — so it looked
 *    in an empty store and reported every package missing. The real store is named.
 *  - `trust_lockfile`: pnpm 11 defaults `minimumReleaseAge` to 1440 min and re-verifies every
 *    lockfile entry against the registry (metadata + attestations) even offline: 826 requests,
 *    each retried for a minute. The lockfile is the one the base commit carries, already
 *    verified where it was produced; the sandbox is not where supply-chain policy is decided.
 *  - `frozen_store`: the store is bound READ-ONLY (it is a shared cache, never the worktree's
 *    to write), and pnpm's index is SQLite, opened read-write by default — `unable to open
 *    database file`. `frozenStore` opens it through an immutable URI instead.
 * The result: 649 packages linked offline from the read-only store in ~60 s, no network.
 *
 * pnpm 11 reads settings from `pnpm_config_*` — not `npm_config_*` — so these are the keys.
 */
export function offlineInstallEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): Record<string, string> {
  return { CI: "1", ...pnpmOfflineSettings(env, home) };
}

/**
 * THE SAME SETTINGS FOR EVERY `pnpm` THE WRITER RUNS (`pnpm exec eslint …`, `pnpm vitest …`).
 * N1 run 10, attempt 1 (2026-10-12 13:40): the worktree had its node_modules, the writer ran
 * exactly the permitted forms, and pnpm 11 — seeing a shell without these settings — judged the
 * install out of date, tried to remove node_modules and aborted for want of a TTY
 * (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`). The settings the install was made with are
 * the settings its consumers must see; `verify_deps_before_run=false` is the explicit one.
 */
export function pnpmOfflineSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): Record<string, string> {
  const [store] = defaultToolchainReadOnlyPaths(env, home);
  return {
    npm_config_verify_deps_before_run: "false",
    pnpm_config_verify_deps_before_run: "false",
    pnpm_config_trust_lockfile: "true",
    pnpm_config_frozen_store: "true",
    ...(store ? { pnpm_config_store_dir: store } : {}),
  };
}

export class SandboxedCommandRunner implements CommandRunner {
  private readonly runProcess: NonInteractiveRunner;
  private readonly readOnlyPaths: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly createHome: () => Promise<EphemeralHome>;

  constructor(options: SandboxedCommandRunnerOptions = {}) {
    this.runProcess = options.run ?? runNonInteractive;
    this.readOnlyPaths = options.readOnlyPaths ?? defaultToolchainReadOnlyPaths();
    this.timeoutMs = options.timeoutMs ?? GATE_COMMAND_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? GATE_MAX_OUTPUT_BYTES;
    this.createHome = options.createHome ?? (() => createEphemeralHome("icos-gate-home-"));
  }

  async run(command: string[], ctx: GateCommandContext): Promise<{ code: number; output: string }> {
    const [bin, ...args] = command;
    if (!bin) return { code: 1, output: "GATE_COMMAND_EMPTY" };
    const home = await this.createHome();
    try {
      const result = await this.runProcess({
        command: bin,
        args,
        cwd: ctx.cwd,
        /* The gate's named variables, then a HOME and TMPDIR that die with the step. */
        env: { ...ctx.env, HOME: home.path, TMPDIR: home.path },
        envPassthrough: [],
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        sandbox: {
          /* + the database socket directory, for the PostgreSQL step only (H1). */
          readWritePaths: [ctx.cwd, home.path, ...(ctx.readWritePaths ?? [])],
          readOnlyPaths: [...this.readOnlyPaths],
          allowNetwork: ctx.network,
        },
        confinement: "required",
      });
      const output = `${result.stdout}\n${result.stderr}`.trim();
      /* Belt and braces: an unconfined run is never a verdict, whatever its exit code. */
      if (result.confinement === "none") {
        return { code: 1, output: output || "SANDBOX_UNAVAILABLE" };
      }
      if (result.timedOut) return { code: 1, output: `GATE_COMMAND_TIMEOUT\n${output}` };
      return { code: result.exitCode ?? 1, output };
    } finally {
      await home.dispose();
    }
  }
}
