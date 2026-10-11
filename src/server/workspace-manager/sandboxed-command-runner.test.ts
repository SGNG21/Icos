import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  NonInteractiveProcessResult,
  NonInteractiveProcessSpec,
} from "@/server/workers/process/run-process";
import { sandboxBackend } from "@/server/workers/process/sandbox-backend";

import { Git } from "./git";
import { IntegrationGate, type GateCommands, type GateOptions } from "./integration-gate";
import { WorkspaceManager } from "./manager";
import { InMemoryWorkspaceRegistry } from "./registry";
import { defaultToolchainReadOnlyPaths, SandboxedCommandRunner } from "./sandboxed-command-runner";
import { FakeProvisioner, makeRepoFixture, type RepoFixture } from "./test-fixtures";

/**
 * P0 — the integration gate executes WORKER-AUTHORED code (tests, configs, scripts). These
 * tests prove it does so under the same confinement as the worker: no inherited secret, no
 * disk outside the worktree, no network except for the database step.
 */

const ok = (over: Partial<NonInteractiveProcessResult> = {}): NonInteractiveProcessResult => ({
  stdout: "out",
  stderr: "",
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1,
  truncated: false,
  confinement: "bubblewrap",
  networkEnforced: true,
  ...over,
});

function recordingRunner(result: NonInteractiveProcessResult = ok()) {
  const specs: NonInteractiveProcessSpec[] = [];
  let disposed = 0;
  const runner = new SandboxedCommandRunner({
    run: async (spec) => {
      specs.push(spec);
      return result;
    },
    readOnlyPaths: ["/opt/store"],
    createHome: async () => ({
      path: "/tmp/icos-gate-home-x",
      dispose: async () => void disposed++,
    }),
  });
  return { runner, specs, disposed: () => disposed };
}

describe("SandboxedCommandRunner — le contrat, sans lancer de processus", () => {
  it("confinement EXIGÉ, worktree + HOME jetable en écriture, store en lecture seule", async () => {
    const { runner, specs } = recordingRunner();
    await runner.run(["pnpm", "test"], { cwd: "/w/7a", env: { A: "1" }, network: false });
    expect(specs[0]).toMatchObject({
      command: "pnpm",
      args: ["test"],
      cwd: "/w/7a",
      confinement: "required",
      sandbox: {
        readWritePaths: ["/w/7a", "/tmp/icos-gate-home-x"],
        readOnlyPaths: ["/opt/store"],
        allowNetwork: false,
      },
    });
  });

  it("n'hérite RIEN : passthrough vide, seules les variables nommées par la gate", async () => {
    const { runner, specs } = recordingRunner();
    await runner.run(["pnpm", "test"], { cwd: "/w", env: { ONLY: "this" }, network: false });
    expect(specs[0]!.envPassthrough).toEqual([]);
    expect(specs[0]!.env).toEqual({
      ONLY: "this",
      HOME: "/tmp/icos-gate-home-x",
      TMPDIR: "/tmp/icos-gate-home-x",
    });
  });

  it("le réseau n'est accordé que si l'étape le demande", async () => {
    const { runner, specs } = recordingRunner();
    await runner.run(["x"], { cwd: "/w", env: {}, network: true });
    expect(specs[0]!.sandbox!.allowNetwork).toBe(true);
  });

  it("une exécution NON confinée n'est jamais un verdict, même à code 0", async () => {
    const { runner } = recordingRunner(ok({ confinement: "none", exitCode: 0 }));
    const r = await runner.run(["x"], { cwd: "/w", env: {}, network: false });
    expect(r.code).toBe(1);
  });

  it("bac à sable indisponible (refus du runner) : ÉCHEC, et la raison est dite", async () => {
    const { runner } = recordingRunner(
      ok({ confinement: "none", exitCode: null, stdout: "", stderr: "SANDBOX_UNAVAILABLE: x" }),
    );
    const r = await runner.run(["x"], { cwd: "/w", env: {}, network: false });
    expect(r).toEqual({ code: 1, output: "SANDBOX_UNAVAILABLE: x" });
  });

  it("expiration ou mort par signal : ÉCHEC", async () => {
    const timedOut = recordingRunner(ok({ timedOut: true, exitCode: null }));
    expect((await timedOut.runner.run(["x"], { cwd: "/w", env: {}, network: false })).code).toBe(1);
    const killed = recordingRunner(ok({ exitCode: null, signal: "SIGKILL" }));
    expect((await killed.runner.run(["x"], { cwd: "/w", env: {}, network: false })).code).toBe(1);
  });

  it("le HOME jetable est détruit, même quand le runner lève", async () => {
    let disposed = 0;
    const runner = new SandboxedCommandRunner({
      run: async () => {
        throw new Error("boom");
      },
      readOnlyPaths: [],
      createHome: async () => ({ path: "/tmp/h", dispose: async () => void disposed++ }),
    });
    await expect(runner.run(["x"], { cwd: "/w", env: {}, network: false })).rejects.toThrow();
    expect(disposed).toBe(1);
  });
});

describe("defaultToolchainReadOnlyPaths — jamais le HOME, jamais un ancêtre", () => {
  it("refuse un chemin relatif, absent, le HOME lui-même, ou la racine", () => {
    const home = homedir();
    const got = defaultToolchainReadOnlyPaths(
      { PNPM_STORE_DIR: "relative/store", XDG_DATA_HOME: "/nonexistent-xdg" } as NodeJS.ProcessEnv,
      home,
    );
    for (const p of got) {
      expect(path.isAbsolute(p)).toBe(true);
      expect(home === p || home.startsWith(`${p}/`)).toBe(false);
    }
    expect(
      defaultToolchainReadOnlyPaths({ PNPM_STORE_DIR: home } as NodeJS.ProcessEnv, home),
    ).not.toContain(home);
    expect(
      defaultToolchainReadOnlyPaths(
        { PNPM_STORE_DIR: path.dirname(home) } as NodeJS.ProcessEnv,
        home,
      ),
    ).not.toContain(path.dirname(home));
    expect(
      defaultToolchainReadOnlyPaths({ PNPM_STORE_DIR: "/" } as NodeJS.ProcessEnv, "/nohome"),
    ).toEqual([]);
  });
});

describe("IntegrationGate — l'environnement est construit, jamais hérité", () => {
  let fx: RepoFixture;
  const calls: { command: string; env: Readonly<Record<string, string>>; network: boolean }[] = [];
  const CANARY = "icos-p0-canary-value-should-never-leak";

  beforeEach(() => {
    fx = makeRepoFixture();
    calls.length = 0;
    process.env.ICOS_P0_CANARY_SECRET = CANARY;
    process.env.OMNIROUTE_API_KEY_P0_CANARY = CANARY;
  });
  afterEach(() => {
    delete process.env.ICOS_P0_CANARY_SECRET;
    delete process.env.OMNIROUTE_API_KEY_P0_CANARY;
    fx.cleanup();
  });

  it("aucune variable du serveur n'atteint une étape ; le réseau seulement pour PostgreSQL", async () => {
    const db = new FakeProvisioner();
    const git = new Git(fx.master);
    const manager = new WorkspaceManager({
      git,
      registry: new InMemoryWorkspaceRegistry(),
      provisioner: db,
      worktreeRoot: fx.root,
      masterRepo: fx.master,
    });
    const gate = new IntegrationGate({
      git,
      manager,
      database: db,
      runner: {
        run: async (command, ctx) => {
          calls.push({ command: command.join(" "), env: ctx.env, network: ctx.network });
          return { code: 0, output: "" };
        },
      },
    });
    const id = await prepare(fx, manager, "p0", { "src/p0/x.ts": "export const x = 1;\n" });
    const report = await gate.integrate(id, APPROVED);
    expect(report.decision).toBe("ACCEPT");

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(Object.values(call.env)).not.toContain(CANARY);
      expect(Object.keys(call.env).sort()).toEqual([
        "CI",
        "ICOS_TEST_DATABASE_URL",
        "npm_config_verify_deps_before_run",
        "pnpm_config_verify_deps_before_run",
      ]);
      expect(call.network).toBe(/test:db:setup|test:integration/.test(call.command));
    }
  });
});

const LEASE = { owner: "gate-owner", fencingToken: 1 };
const APPROVED: GateOptions = {
  review: { verdict: "APPROVED", reviewer: "reviewer-1" },
  lease: LEASE,
};

async function prepare(
  fx: RepoFixture,
  manager: WorkspaceManager,
  slug: string,
  files: Record<string, string>,
): Promise<string> {
  const { workspaceId } = await manager.request({
    slug,
    workerId: `worker-${slug}`,
    manual: true,
    fileScope: { owns: [`src/${slug}/**`], shared: [], forbidden: [] },
  });
  await manager.create(workspaceId);
  await manager.acquireLease(workspaceId, LEASE.owner, 60_000);
  await manager.transition(workspaceId, "working", LEASE.owner, LEASE.fencingToken);
  const dir = path.join(fx.root, slug);
  for (const [file, content] of Object.entries(files)) fx.write(dir, file, content);
  fx.commit(dir, `work ${slug}`);
  await manager.transition(workspaceId, "validating", LEASE.owner, LEASE.fencingToken);
  await manager.transition(workspaceId, "ready_for_integration", LEASE.owner, LEASE.fencingToken);
  return workspaceId;
}

/* ── RÉEL : le code du worker, exécuté PAR LA GATE, tente de s'évader ─────────────────── */

const backend = sandboxBackend().backend;

/**
 * Worker-authored probe. Run by the gate as every verification step, it tries what a
 * hostile test file would try and writes what it saw into the worktree (the one place it
 * may write), so the test can read the verdict.
 */
const PROBE = `
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
const [step, canary, hostSecret, canonical, outside, port, realHome] = process.argv.slice(2);
const attempt = (fn) => { try { fn(); return true; } catch { return false; } };
const network = await new Promise((resolve) => {
  const s = connect({ host: "127.0.0.1", port: Number(port) }, () => { s.destroy(); resolve(true); });
  s.on("error", () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 2000);
});
const report = {
  step,
  envLeak: Object.values(process.env).includes(canary),
  envKeys: Object.keys(process.env).sort(),
  readHostSecret: attempt(() => readFileSync(hostSecret, "utf8")),
  readCanonical: attempt(() => readFileSync(canonical, "utf8")),
  /* Inside the sandbox /tmp is a private tmpfs: a write may "succeed" and never reach the
     host. Whether it LANDED is checked from the host side, below. */
  writeAttempted: attempt(() => writeFileSync(outside, "pwned")),
  realHomeVisible: existsSync(realHome),
  sshVisible: existsSync(realHome + "/.ssh"),
  network,
};
mkdirSync(".probe", { recursive: true });
writeFileSync(".probe/" + step + ".json", JSON.stringify(report));
`;

describe.skipIf(!backend)(
  "IntegrationGate + SandboxedCommandRunner — évasion RÉELLE par la gate",
  () => {
    let fx: RepoFixture;
    let server: Server;
    let port: number;
    const CANARY = "icos-p0-real-canary-should-never-leak";

    beforeAll(async () => {
      fx = makeRepoFixture();
      process.env.ICOS_P0_CANARY_SECRET = CANARY;
      process.env.BETTER_AUTH_SECRET_P0_CANARY = CANARY;
      server = createServer((_req, res) => res.end("host"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(async () => {
      delete process.env.ICOS_P0_CANARY_SECRET;
      delete process.env.BETTER_AUTH_SECRET_P0_CANARY;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fx.cleanup();
    });

    it("aucune étape ne voit un secret, le disque hors worktree, ni le réseau (sauf PostgreSQL)", async () => {
      const hostSecretDir = path.join(fx.tmp, "host-secrets");
      mkdirSync(hostSecretDir);
      const hostSecret = path.join(hostSecretDir, "token.txt");
      writeFileSync(hostSecret, CANARY);
      const outside = path.join(fx.tmp, "written-by-worker.txt");
      const canonical = path.join(fx.master, "src", "a.ts");

      const db = new FakeProvisioner();
      const git = new Git(fx.master);
      const manager = new WorkspaceManager({
        git,
        registry: new InMemoryWorkspaceRegistry(),
        provisioner: db,
        worktreeRoot: fx.root,
        masterRepo: fx.master,
      });
      const probe = (step: string) => [
        "node",
        "src/p0/probe.mjs",
        step,
        CANARY,
        hostSecret,
        canonical,
        outside,
        String(port),
        homedir(),
      ];
      const commands: GateCommands = {
        install: probe("install"),
        typecheck: probe("typecheck"),
        lint: probe("lint"),
        unit: probe("unit"),
        postgres: [probe("postgres")],
        build: probe("build"),
      };
      const gate = new IntegrationGate({
        git,
        manager,
        database: db,
        runner: new SandboxedCommandRunner({ readOnlyPaths: [] }),
        commands,
      });
      const id = await prepare(fx, manager, "p0", { "src/p0/probe.mjs": PROBE });
      const report = await gate.integrate(id, APPROVED);
      expect(report.decision).toBe("ACCEPT");

      const worktree = path.join(fx.root, "p0");
      const steps = ["install", "typecheck", "lint", "unit", "postgres", "build"];
      for (const step of steps) {
        const seen = JSON.parse(
          readFileSync(path.join(worktree, ".probe", `${step}.json`), "utf8"),
        );
        expect(seen, step).toMatchObject({
          envLeak: false,
          readHostSecret: false,
          readCanonical: false,
          realHomeVisible: false,
          sshVisible: false,
          /* The ONLY step granted a socket is the one that must reach its test database. */
          network: step === "postgres",
        });
        expect(
          seen.envKeys.filter(
            (k: string) =>
              k !== "ICOS_TEST_DATABASE_URL" && /CANARY|SECRET|API_KEY|TOKEN|DATABASE_URL$/.test(k),
          ),
          step,
        ).toEqual([]);
      }
      expect(existsSync(outside)).toBe(false);
    }, 120_000);
  },
);
