import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runNonInteractive,
  type NonInteractiveProcessResult,
  type NonInteractiveRunner,
} from "@/server/workers/process/run-process";

/**
 * THE DETECTION LINK of self-development (decision 0076).
 *
 * ICOS could execute an improvement and could PROPOSE one when told what to look at, but
 * nothing ever looked. This is the eye: a bounded, read-only, deterministic quality probe of
 * the canonical repository. It produces MEASURED findings — counts, files, rules, lines —
 * and nothing else. A model never writes a finding; it is only ever handed one.
 *
 * WHY ESLINT. It is the repository's own lint gate (`pnpm lint` = `eslint .`), so a finding
 * here is something the repository already declares to be a defect, and a fix is verified by
 * the same gate the integration gate runs. No new quality model is invented.
 *
 * CONFINED (verrou C8 discipline). ESLint loads the repository's config, which is code. It
 * runs through `runNonInteractive` — the runner workers and the integration gate use — under
 * a sandbox: the repository READ-ONLY, network OFF (enforced by the OS), an environment built
 * here rather than inherited, a disposable HOME, a timeout that kills. A probe that could not
 * be confined is refused, never run unconfined.
 */

export const QUALITY_PROBE_ERROR_PREFIX = "QUALITY_PROBE_";

export function qualityProbeError(code: string): Error {
  return new Error(`${QUALITY_PROBE_ERROR_PREFIX}${code}`);
}

/** One rule in one file, aggregated. The unit a proposal is about. */
export interface QualityFinding {
  /** Stable identity of the defect, independent of line numbers: `eslint:<rule>:<file>`. */
  key: string;
  tool: "eslint";
  /** Repository-relative, forward slashes. */
  file: string;
  rule: string;
  severity: "warning" | "error";
  count: number;
  /** First few 1-based lines, ascending. Evidence, not identity. */
  lines: number[];
  /** The tool's own message for the first occurrence, bounded. */
  message: string;
}

export interface QualityProbeReport {
  tool: "eslint";
  paths: string[];
  filesScanned: number;
  totalWarnings: number;
  totalErrors: number;
  /** Distinct (file, rule) pairs before the top-N cut. */
  distinctFindings: number;
  /** Top N by count desc, then file, then rule. Deterministic. */
  findings: QualityFinding[];
  confinement: NonInteractiveProcessResult["confinement"];
  networkEnforced: boolean;
  durationMs: number;
}

export interface QualityProbe {
  probe(signal?: AbortSignal): Promise<QualityProbeReport>;
}

const MAX_LINES_PER_FINDING = 5;
const MAX_MESSAGE_LENGTH = 200;
/** A rule id is an identifier, never prose: anything else is dropped rather than echoed. */
const RULE_ID = /^[A-Za-z0-9@/_.-]{1,100}$/;
/** ESLint reports an unused `eslint-disable` directive with no rule id. */
const NO_RULE = "eslint-directive";

interface EslintMessage {
  ruleId?: unknown;
  severity?: unknown;
  line?: unknown;
  message?: unknown;
  fatal?: unknown;
}

interface EslintFileResult {
  filePath?: unknown;
  messages?: unknown;
}

/**
 * Pure: ESLint `--format json` output -> aggregated findings. Every field is validated, so a
 * malformed or hostile report yields fewer findings, never an invented one.
 */
export function parseEslintReport(
  stdout: string,
  repoPath: string,
  topN: number,
): Omit<QualityProbeReport, "tool" | "paths" | "confinement" | "networkEnforced" | "durationMs"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw qualityProbeError("INVALID_OUTPUT");
  }
  if (!Array.isArray(parsed)) throw qualityProbeError("INVALID_OUTPUT");

  const root = path.resolve(repoPath);
  const byKey = new Map<string, QualityFinding>();
  let totalWarnings = 0;
  let totalErrors = 0;

  for (const entry of parsed as EslintFileResult[]) {
    if (typeof entry?.filePath !== "string" || !Array.isArray(entry.messages)) continue;
    const absolute = path.resolve(root, entry.filePath);
    /* A file outside the repository is not a finding about this repository. */
    if (!absolute.startsWith(root + path.sep)) continue;
    const file = path.relative(root, absolute).split(path.sep).join("/");

    for (const message of entry.messages as EslintMessage[]) {
      const severity = message?.severity === 2 ? "error" : message?.severity === 1 ? "warning" : null;
      if (!severity) continue;
      if (severity === "error") totalErrors += 1;
      else totalWarnings += 1;

      const rule =
        message.ruleId === null || message.ruleId === undefined
          ? message.fatal === true
            ? "parse-error"
            : NO_RULE
          : typeof message.ruleId === "string" && RULE_ID.test(message.ruleId)
            ? message.ruleId
            : null;
      if (!rule) continue;

      const key = `eslint:${rule}:${file}`;
      const line =
        typeof message.line === "number" && Number.isSafeInteger(message.line) && message.line > 0
          ? message.line
          : undefined;
      const existing = byKey.get(key);
      if (existing) {
        existing.count += 1;
        if (severity === "error") existing.severity = "error";
        if (line !== undefined) existing.lines.push(line);
        continue;
      }
      byKey.set(key, {
        key,
        tool: "eslint",
        file,
        rule,
        severity,
        count: 1,
        lines: line === undefined ? [] : [line],
        message:
          typeof message.message === "string"
            ? message.message.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH)
            : "",
      });
    }
  }

  const all = [...byKey.values()].map((f) => ({
    ...f,
    lines: [...new Set(f.lines)].sort((a, b) => a - b).slice(0, MAX_LINES_PER_FINDING),
  }));
  all.sort(
    (a, b) =>
      b.count - a.count || a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule),
  );

  return {
    filesScanned: (parsed as unknown[]).length,
    totalWarnings,
    totalErrors,
    distinctFindings: all.length,
    findings: all.slice(0, Math.max(0, topN)),
  };
}

/** A probed path is repository-relative data, never an option and never an escape. */
export function validateProbePaths(paths: readonly string[]): string[] {
  const clean = paths.map((p) => p.trim()).filter((p) => p.length > 0);
  if (clean.length === 0) throw qualityProbeError("NO_PATHS");
  for (const p of clean) {
    const segments = p.replaceAll("\\", "/").split("/");
    if (p.startsWith("-") || path.isAbsolute(p) || segments.includes("..") || p.includes("\0")) {
      throw qualityProbeError("INVALID_PATH");
    }
  }
  return clean;
}

const SYSTEM_PREFIXES = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/"];

export interface EslintQualityProbeOptions {
  repoPath: string;
  paths: readonly string[];
  timeoutMs: number;
  topN?: number;
  /**
   * The directory whose `node_modules/eslint` is run. Default: the repository itself — the
   * repository's own pinned ESLint. Mounted read-only, like the repository.
   */
  toolRoot?: string;
  runner?: NonInteractiveRunner;
  /** ESLint output for a whole repository is ~1.5 MB; a truncated JSON is refused. */
  maxOutputBytes?: number;
}

export class EslintQualityProbe implements QualityProbe {
  private readonly paths: string[];

  constructor(private readonly options: EslintQualityProbeOptions) {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
      throw qualityProbeError("INVALID_TIMEOUT");
    }
    this.paths = validateProbePaths(options.paths);
  }

  async probe(signal?: AbortSignal): Promise<QualityProbeReport> {
    const repoPath = path.resolve(this.options.repoPath);
    const toolRoot = path.resolve(this.options.toolRoot ?? repoPath);
    const entry = path.join(toolRoot, "node_modules", "eslint", "bin", "eslint.js");
    if (!existsSync(entry)) throw qualityProbeError("ESLINT_NOT_INSTALLED");

    /* The node binary outside the system paths (nvm, volta) must be visible to the sandbox. */
    const nodeReal = realpathSync(process.execPath);
    const nodeRoot = SYSTEM_PREFIXES.some((p) => nodeReal.startsWith(p))
      ? []
      : [path.dirname(path.dirname(nodeReal))];

    const home = mkdtempSync(path.join(tmpdir(), "icos-quality-probe-"));
    try {
      const result = await (this.options.runner ?? runNonInteractive)({
        command: process.execPath,
        args: [entry, "--format", "json", "--no-warn-ignored", "--", ...this.paths],
        cwd: repoPath,
        timeoutMs: this.options.timeoutMs,
        maxOutputBytes: this.options.maxOutputBytes ?? 32 * 1024 * 1024,
        /* Built, not inherited: platform variables only, then these. No secret can reach it. */
        envPassthrough: [],
        env: { HOME: home, TMPDIR: home, NODE_ENV: "production", CI: "1" },
        sandbox: {
          readWritePaths: [home],
          readOnlyPaths: [...new Set([repoPath, toolRoot, ...nodeRoot])],
          allowNetwork: false,
        },
        confinement: "required",
        ...(signal ? { abortSignal: signal } : {}),
      });

      if (result.confinement === "none") throw qualityProbeError("SANDBOX_UNAVAILABLE");
      if (result.aborted) throw qualityProbeError("ABORTED");
      if (result.timedOut) throw qualityProbeError("TIMEOUT");
      if (result.truncated) throw qualityProbeError("OUTPUT_TRUNCATED");
      /* ESLint: 0 = clean, 1 = lint errors found, 2 = it could not run (config, crash). */
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw qualityProbeError(`EXIT_${result.exitCode ?? "NONE"}`);
      }

      return {
        tool: "eslint",
        paths: this.paths,
        ...parseEslintReport(result.stdout, repoPath, this.options.topN ?? 10),
        confinement: result.confinement,
        networkEnforced: result.networkEnforced,
        durationMs: result.durationMs,
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
}
