import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * THE CLAUDE CODE ADAPTER (`bin/icos-claude-worker.mjs`), run as the real executable against
 * a FAKE `claude` that records what it was given and calls the base URL it was pointed at.
 * The unix socket is served by a plain HTTP server standing in for the metered proxy.
 */

const ADAPTER = resolve(__dirname, "../../../bin/icos-claude-worker.mjs");

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const home = process.env.HOME;
const mode = fs.existsSync(home + "/mode") ? fs.readFileSync(home + "/mode", "utf8") : "ok";
fs.writeFileSync(home + "/record.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
if (mode === "hang") { setInterval(() => {}, 1000); return; }
const base = process.env.ANTHROPIC_BASE_URL;
fetch(base + "/v1/messages?beta=true", { method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY }, body: JSON.stringify({ model: "m", max_tokens: 10, messages: [] }) })
  .then((r) => r.text().then((t) => [r.status, t]))
  .then(([status, text]) => {
    if (mode === "error") {
      process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true, result: "budget" }));
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done via " + status + " " + text, total_cost_usd: 0.0123, usage: { input_tokens: 11, output_tokens: 22 }, num_turns: 2 }));
  });
`;

interface Recorded {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

describe("icos-claude-worker adapter", () => {
  let dir: string;
  let socketServer: Server;
  const hits: { url: string; headers: Record<string, unknown> }[] = [];

  beforeEach(async () => {
    hits.length = 0;
    dir = await mkdtemp(join(tmpdir(), "icos-claude-adapter-"));
    await writeFile(join(dir, "claude"), FAKE_CLAUDE);
    await chmod(join(dir, "claude"), 0o755);
    socketServer = createServer((req, res) => {
      hits.push({ url: req.url ?? "", headers: req.headers });
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"via":"socket"}');
      });
    });
    await new Promise<void>((r) => socketServer.listen(join(dir, "gw.sock"), r));
  });

  afterEach(async () => {
    await new Promise<void>((r) => socketServer.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (args: string[], env: Record<string, string> = {}) => {
    if (env.FAKE_MODE) await writeFile(join(dir, "mode"), env.FAKE_MODE);
    return runAdapter(args, env);
  };
  const runAdapter = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
      execFile(
        ADAPTER,
        args,
        {
          cwd: dir,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: dir,
            ICOS_EGRESS_SOCKET: join(dir, "gw.sock"),
            ICOS_WORKER_STATUS_FILE: join(dir, "status.json"),
            ...env,
          } as unknown as NodeJS.ProcessEnv,
          timeout: 30_000,
          encoding: "utf8",
        },
        (error: Error | null, stdout: string, stderr: string) =>
          done({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  const base = () => [
    "--claude-bin",
    join(dir, "claude"),
    "--prompt",
    "create file hello.txt containing OK",
    "--model",
    "nvidia/some-model",
    "--max-budget-usd",
    "0.20",
  ];

  it("runs claude headless through the loopback forwarder to the socket, and reports the contract", async () => {
    const result = await run([
      ...base(),
      "--allow-bash",
      "pnpm test*",
      "--allow-bash",
      "node --test *",
    ]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('done via 200 {"via":"socket"}');

    /* The request crossed TCP loopback -> unix socket, and only there. */
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe("/v1/messages?beta=true");

    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(status).toEqual({
      completed: true,
      failed: false,
      model: "nvidia/some-model",
      usage: { input_tokens: 11, output_tokens: 22 },
      costUsd: 0.0123,
      turns: 2,
      subtype: "success",
    });

    const recorded = JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as Recorded;
    const { argv, env } = recorded;
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(argv[0]).toBe("-p");
    expect(argv[1]).toBe("create file hello.txt containing OK");
    expect(flag("--output-format")).toBe("json");
    expect(flag("--model")).toBe("nvidia/some-model");
    expect(flag("--max-budget-usd")).toBe("0.20");
    expect(flag("--permission-mode")).toBe("acceptEdits");
    expect(flag("--tools")).toBe("Read,Edit,Write,Glob,Grep,Bash");
    expect(flag("--allowedTools")).toBe(
      "Read,Edit,Write,Glob,Grep,Bash(pnpm test*),Bash(node --test *)",
    );
    expect(flag("--disallowedTools")).toContain("Bash(git:*)");
    expect(argv).toEqual(
      expect.arrayContaining([
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
      ]),
    );
    expect(flag("--setting-sources")).toBe("user");
    expect(argv).toEqual(expect.arrayContaining(["--no-session-persistence"]));
    /* NEVER a global bypass. */
    expect(argv.join(" ")).not.toMatch(/dangerously|bypassPermissions/);

    const settings = JSON.parse(flag("--settings")!) as { env: Record<string, string> };
    expect(settings.env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(settings.env.ANTHROPIC_API_KEY).toBe("icos-metered");
    expect(settings.env.DISABLE_AUTOUPDATER).toBe("1");
    expect(settings.env.DISABLE_TELEMETRY).toBe("1");
    expect(settings.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.ANTHROPIC_BASE_URL).toBe(settings.env.ANTHROPIC_BASE_URL);
    expect(env.HOME).toBe(dir);
    /* The adapter's own environment does not leak through: only what it constructs. */
    expect(env.ICOS_EGRESS_SOCKET).toBeUndefined();
    expect(env.ICOS_WORKER_STATUS_FILE).toBeUndefined();
  });

  it("PACKAGE_MANAGER_SETTINGS_PASS: pnpm_config_*/npm_config_* reach claude's shell, nothing else does", async () => {
    /*
     * W10 (N1 run 10, attempts 1–3): the worktree's node_modules were installed with a named
     * store, a trusted lockfile and a frozen store; the writer's `pnpm exec eslint …` ran in a
     * shell without those settings, pnpm judged the install out of date and aborted a
     * reinstall for want of a TTY. The settings ICOS constructed must reach the shell — and
     * only they do: the adapter's surface stays constructed, never inherited.
     */
    const result = await run([...base(), "--allow-bash", "pnpm exec eslint src/*"], {
      pnpm_config_store_dir: "/srv/store/v11",
      pnpm_config_verify_deps_before_run: "false",
      npm_config_verify_deps_before_run: "false",
      ICOS_NOT_FOR_THE_WRITER: "canary",
      PNPM_HOME: "/not/forwarded",
    });
    expect(result.code).toBe(0);
    const { env } = JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as Recorded;
    expect(env.pnpm_config_store_dir).toBe("/srv/store/v11");
    expect(env.pnpm_config_verify_deps_before_run).toBe("false");
    expect(env.npm_config_verify_deps_before_run).toBe("false");
    expect(env.ICOS_NOT_FOR_THE_WRITER).toBeUndefined();
    expect(env.PNPM_HOME).toBeUndefined();
  });

  it("without --allow-bash, claude gets no Bash tool at all", async () => {
    await run(base());
    const { argv } = JSON.parse(await readFile(join(dir, "record.json"), "utf8")) as Recorded;
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Glob,Grep");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("Read,Edit,Write,Glob,Grep");
  });

  it("an is_error result is a FAILED status, nothing on stdout", async () => {
    const result = await run(base(), { FAKE_MODE: "error" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("error_max_budget_usd");
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({ completed: false, failed: true });
  });

  it("enforces its timeout and kills the process group", async () => {
    const started = Date.now();
    const result = await run([...base(), "--timeout-ms", "500"], { FAKE_MODE: "hang" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("timed out");
    const status = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(status).toMatchObject({ completed: false, failed: true, error: "TIMEOUT" });
  });

  it("refuses to run without the egress socket, without a model, or with a smuggled rule", async () => {
    expect((await run(base(), { ICOS_EGRESS_SOCKET: "" })).stderr).toContain("ICOS_EGRESS_SOCKET");
    const noModel = base().filter((a, i, all) => a !== "--model" && all[i - 1] !== "--model");
    expect((await run(noModel)).stderr).toContain("--model is required");
    expect((await run([...base(), "--allow-bash", "x),Bash(rm"])).stderr).toContain(
      "invalid --allow-bash",
    );
  });
});
