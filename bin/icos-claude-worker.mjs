#!/usr/bin/env node
/**
 * icos-claude-worker — the trusted adapter that runs Claude Code as a governed ICOS worker.
 *
 * Runs INSIDE the worker sandbox, whose network is unshared: the only way out is the UNIX
 * socket ICOS bound into it (`ICOS_EGRESS_SOCKET`), served host-side by the metered egress
 * proxy (`src/server/workers/metered-egress-proxy.ts`). This adapter:
 *
 *   1. opens a loopback TCP listener on 127.0.0.1:<ephemeral> that pipes to that socket,
 *      because Claude Code speaks HTTP to a base URL, not to a socket path;
 *   2. runs `claude` with an argv ARRAY (no shell), non-interactive, JSON output, the model
 *      ICOS routed, a per-run USD cap, a closed tool set, and a settings object that points
 *      it at the loopback port with a DUMMY credential (the real gateway key, if any, is
 *      added by the proxy outside the sandbox);
 *   3. enforces its own timeout and kills Claude's whole process group;
 *   4. writes the ICOS status contract (`ICOS_WORKER_STATUS_FILE`) and prints the result
 *      text on stdout.
 *
 * It never runs git (ADR 0073): the trusted authority materializes the commit.
 *
 * Zero dependencies, plain Node: it must run from a read-only bind with no node_modules.
 *
 * Usage:
 *   icos-claude-worker.mjs --prompt <text> --model <id> [--max-budget-usd 0.50]
 *     [--timeout-ms 840000] [--allow-bash "<pattern>"]... [--claude-bin /usr/bin/claude]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import process from "node:process";

/** The only tools Claude Code is given. Bash appears only with ICOS-supplied patterns. */
const FILE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
/** Belt and braces: what must never run even if a pattern were too broad. */
const ALWAYS_DENIED = [
  "WebFetch",
  "WebSearch",
  "Bash(git:*)",
  "Bash(git *)",
  "Bash(curl:*)",
  "Bash(wget:*)",
];
/** A dummy credential: Claude Code wants one, the gateway needs none, the proxy drops it. */
const DUMMY_KEY = "icos-metered";

export function parseArgs(argv) {
  const out = {
    allowBash: [],
    claudeBin: "/usr/bin/claude",
    maxBudgetUsd: "0.50",
    timeoutMs: 840_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`missing value for ${flag}`);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--prompt":
        out.prompt = need();
        break;
      case "--model":
        out.model = need();
        break;
      case "--max-budget-usd":
        out.maxBudgetUsd = need();
        break;
      case "--timeout-ms":
        out.timeoutMs = Number(need());
        break;
      case "--allow-bash":
        out.allowBash.push(need());
        break;
      case "--claude-bin":
        out.claudeBin = need();
        break;
      case "--max-output-tokens":
        out.maxOutputTokens = need();
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!out.prompt) throw new Error("--prompt is required");
  if (!out.model) throw new Error("--model is required (ICOS routes the model; no CLI default)");
  if (!/^\d+(\.\d+)?$/.test(out.maxBudgetUsd) || Number(out.maxBudgetUsd) <= 0) {
    throw new Error("--max-budget-usd must be a positive number");
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0)
    throw new Error("--timeout-ms must be positive");
  for (const pattern of out.allowBash) {
    /* A pattern is a Claude Code permission rule body; it may not smuggle a second rule. */
    if (!pattern || /[(),]/.test(pattern)) throw new Error("invalid --allow-bash pattern");
  }
  return out;
}

/** The exact argv given to claude. Exported for the unit test; no shell ever sees it. */
export function claudeArgv(options, port) {
  const model = options.model;
  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_API_KEY: DUMMY_KEY,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ...(options.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: options.maxOutputTokens } : {}),
  };
  const tools = options.allowBash.length > 0 ? [...FILE_TOOLS, "Bash"] : FILE_TOOLS;
  const allowed = [...FILE_TOOLS, ...options.allowBash.map((p) => `Bash(${p})`)];
  return {
    env,
    argv: [
      "-p",
      options.prompt,
      "--output-format",
      "json",
      "--model",
      model,
      "--max-budget-usd",
      options.maxBudgetUsd,
      "--permission-mode",
      "acceptEdits",
      "--permission-prompts",
      "none",
      "--tools",
      tools.join(","),
      "--allowedTools",
      allowed.join(","),
      "--disallowedTools",
      ALWAYS_DENIED.join(","),
      "--settings",
      JSON.stringify({ env }),
      /*
       * NOT --bare: in 2.1.x it narrows the tool set to Read/Edit (no Write/Glob/Grep), which
       * breaks the governed tool list above. Its isolation is obtained explicitly instead:
       * only USER settings are read (HOME is the ephemeral home, so: none) — a worktree's
       * `.claude/settings*.json` cannot add hooks or widen permissions — and no skill or
       * slash command from the worktree is loaded.
       */
      "--setting-sources",
      "user",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--strict-mcp-config",
    ],
  };
}

/** 127.0.0.1:<ephemeral> -> the bind-mounted unix socket. Byte pipe, nothing interpreted. */
function startForwarder(socketPath) {
  const server = createServer((client) => {
    const upstream = createConnection(socketPath);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function writeStatus(status) {
  const file = process.env.ICOS_WORKER_STATUS_FILE;
  if (file) writeFileSync(file, JSON.stringify(status));
}

/** The `pnpm_config_*` / `npm_config_*` settings of an environment, and nothing else. */
export function packageManagerSettings(source) {
  const out = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && /^(pnpm|npm)_config_[a-z0-9_]+$/.test(name)) out[name] = value;
  }
  return out;
}

/** Reads Claude Code's `--output-format json` result. Null when it is not one. */
export function parseClaudeResult(stdout) {
  const text = stdout.trim();
  const start = text.lastIndexOf("\n{");
  for (const candidate of [text, start >= 0 ? text.slice(start + 1) : null]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && parsed.type === "result") return parsed;
    } catch {
      /* try the next shape */
    }
  }
  return null;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    writeStatus({ completed: false, failed: true, error: "ADAPTER_USAGE" });
    process.stderr.write(`icos-claude-worker: ${error.message}\n`);
    process.exit(2);
  }
  const socketPath = process.env.ICOS_EGRESS_SOCKET;
  if (!socketPath) {
    writeStatus({ completed: false, failed: true, error: "EGRESS_SOCKET_MISSING" });
    process.stderr.write(
      "icos-claude-worker: ICOS_EGRESS_SOCKET missing: no metered egress, no run\n",
    );
    process.exit(2);
  }

  const forwarder = await startForwarder(socketPath);
  const port = forwarder.address().port;
  const { argv, env } = claudeArgv(options, port);

  const child = spawn(options.claudeBin, argv, {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      /*
       * THE PACKAGE-MANAGER SETTINGS ICOS CONSTRUCTED FOR THIS WORKTREE (W10). The worktree's
       * node_modules were installed offline with a named store, a trusted lockfile and a frozen
       * store; a `pnpm exec eslint …` in a shell WITHOUT those settings judges the install out
       * of date, tries to reinstall and aborts for want of a TTY (N1 run 10, attempts 1–3:
       * ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY). Only these two prefixes pass; nothing
       * else of the adapter's environment reaches the CLI — the surface stays constructed.
       */
      ...packageManagerSettings(process.env),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    /* Its own process group, so the timeout kills everything Claude started. */
    detached: true,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    if (stderr.length < 64_000) stderr += d;
  });

  let timedOut = false;
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup("SIGTERM");
    setTimeout(() => killGroup("SIGKILL"), 5_000).unref();
  }, options.timeoutMs);
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      killGroup("SIGKILL");
      process.exit(1);
    });
  }

  const [code, signal] = await new Promise((resolve) => {
    child.on("error", (error) => {
      stderr += String(error.message);
      resolve([127, null]);
    });
    child.on("close", (c, s) => resolve([c, s]));
  });
  clearTimeout(timer);
  forwarder.close();

  const result = parseClaudeResult(stdout);
  const model = options.model;
  if (timedOut) {
    writeStatus({ completed: false, failed: true, model, error: "TIMEOUT" });
    process.stderr.write(`icos-claude-worker: claude timed out after ${options.timeoutMs}ms\n`);
    process.exit(1);
  }
  const ok =
    code === 0 &&
    result !== null &&
    result.is_error === false &&
    typeof result.result === "string" &&
    result.result.trim() !== "";
  writeStatus({
    completed: ok,
    failed: !ok,
    model,
    ...(result?.usage ? { usage: result.usage } : {}),
    ...(typeof result?.total_cost_usd === "number" ? { costUsd: result.total_cost_usd } : {}),
    ...(typeof result?.num_turns === "number" ? { turns: result.num_turns } : {}),
    ...(result?.subtype ? { subtype: result.subtype } : {}),
  });
  if (ok) {
    process.stdout.write(`${result.result.trim()}\n`);
    process.exit(0);
  }
  const why = result
    ? `${result.subtype ?? "error"}: ${String(result.result ?? "").slice(0, 500)}`
    : `exit ${code ?? signal}: ${stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 500)}`;
  process.stderr.write(`icos-claude-worker: claude failed (${why})\n`);
  process.exit(1);
}

/* Imported by the unit test for its pure helpers; executed as the adapter otherwise. */
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("icos-claude-worker.mjs")
) {
  main().catch((error) => {
    writeStatus({ completed: false, failed: true, error: "ADAPTER_CRASH" });
    process.stderr.write(`icos-claude-worker: ${error?.message ?? error}\n`);
    process.exit(1);
  });
}
