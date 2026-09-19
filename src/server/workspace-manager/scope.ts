import type { FileScope } from "./types";
import { WorkspaceError } from "./types";

/** Interdits pour tout workspace, ajoutés à ceux déclarés. */
export const BASELINE_FORBIDDEN = [
  ".env.local",
  "**/.env.local",
  ".env.*.local",
  "secrets/**",
  "**/*.pem",
];

export type ScopeStatus = "PASS" | "SHARED_CHANGED" | "OUT_OF_SCOPE" | "FORBIDDEN";

export interface ScopeReport {
  status: ScopeStatus;
  owned: string[];
  shared: string[];
  forbidden: string[];
  outOfScope: string[];
}

function globToRegExp(pattern: string): RegExp {
  const glob = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(file));
}

export function normalizeScope(scope: FileScope): FileScope {
  if (scope.owns.length === 0) {
    throw new WorkspaceError("SCOPE_INVALID", "owns ne peut pas être vide");
  }
  const forbidden = [...new Set([...scope.forbidden, ...BASELINE_FORBIDDEN])];
  const clash = scope.owns.find((p) => forbidden.includes(p));
  if (clash)
    throw new WorkspaceError("SCOPE_INVALID", `"${clash}" est à la fois owns et forbidden`);
  return { owns: [...scope.owns], shared: [...scope.shared], forbidden };
}

/** Priorité : forbidden > shared > owns > hors périmètre (fail-closed). */
export function checkScope(scope: FileScope, changedFiles: readonly string[]): ScopeReport {
  const report: ScopeReport = {
    status: "PASS",
    owned: [],
    shared: [],
    forbidden: [],
    outOfScope: [],
  };
  for (const file of changedFiles) {
    if (matchesAny(file, scope.forbidden)) report.forbidden.push(file);
    else if (matchesAny(file, scope.shared)) report.shared.push(file);
    else if (matchesAny(file, scope.owns)) report.owned.push(file);
    else report.outOfScope.push(file);
  }
  if (report.forbidden.length) report.status = "FORBIDDEN";
  else if (report.outOfScope.length) report.status = "OUT_OF_SCOPE";
  else if (report.shared.length) report.status = "SHARED_CHANGED";
  return report;
}

/** Préfixe statique (segments avant le premier joker). */
function staticPrefix(pattern: string): string[] {
  const segs = pattern.replace(/\/$/, "").split("/");
  const i = segs.findIndex((s) => /[*?]/.test(s));
  return i === -1 ? segs : segs.slice(0, i);
}

/** Recouvrement conservateur : un préfixe de dossier contient l'autre. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((pa) =>
    b.some((pb) => {
      const [x, y] = [staticPrefix(pa), staticPrefix(pb)];
      const n = Math.min(x.length, y.length);
      return x.slice(0, n).every((s, i) => s === y[i]);
    }),
  );
}

/** Lève OWNERSHIP_CONFLICT si `mine.owns` recouvre `theirs.owns`. */
export function checkScopeClaims(mine: FileScope, theirs: FileScope, otherId: string): void {
  if (scopesOverlap(mine.owns, theirs.owns)) {
    throw new WorkspaceError("OWNERSHIP_CONFLICT", `owns recouvre celui du workspace ${otherId}`);
  }
}
