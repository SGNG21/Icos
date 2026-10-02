import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { childEnvironment, parseEnvPassthrough } from "./child-environment";
import {
  networkEnforced,
  seatbeltProfile,
  type SandboxMechanism,
  type SandboxPolicy,
} from "./sandbox-profile";

/**
 * THE non-interactive process runner (M6.3).
 *
 * M6.1 established this discipline inside the health probe. M6.3 needs the same
 * guarantees for EXECUTION, so the implementation moved here rather than being
 * copied: two runners would drift, and the one that drifted would be the one that
 * forgot to close stdin.
 *
 * THE GUARANTEES, AND WHY EACH ONE IS LOAD-BEARING
 *   - stdin is `ignore`. A worker that tries to prompt gets EOF instead of
 *     blocking forever. A hang is worse than a failure: it holds a capacity slot
 *     and never yields a verdict, so it looks like work in progress indefinitely.
 *   - there is ALWAYS a timeout and it KILLS. SIGTERM first so a worker can flush
 *     a partial result, then SIGKILL if it ignores that.
 *   - no shell. argv only, so nothing in a worker declaration or a task contract
 *     can be interpolated into a shell command.
 *   - output is BOUNDED. A chatty worker must not be able to exhaust memory.
 *     Truncation is recorded, never silent.
 *   - it NEVER REJECTS. A spawn failure (missing executable, EACCES) comes back as
 *     a result with a null exit code, so callers have exactly one shape to
 *     interpret. A helper with two failure paths always has one that is unhandled.
 */

export interface NonInteractiveProcessSpec {
  /** Executable. Resolved by the OS, never expanded by a shell. */
  command: string;
  args?: readonly string[];
  /** Working directory. For a writer this is its ISOLATED workspace. */
  cwd?: string;
  /**
   * Variables posées NOMMÉMENT sur l'environnement de l'enfant.
   *
   * ISOLATION DES SECRETS (verrou C8). L'enfant n'hérite PLUS de `process.env`. Il reçoit
   * une liste blanche de variables de plateforme (`child-environment.ts`), ce que le
   * déploiement a explicitement ouvert via `ICOS_WORKER_ENV_PASSTHROUGH`, et ce que
   * l'appelant pose ici. Avant, il voyait tout : `DATABASE_URL`, les clés d'API, les
   * identifiants d'authentification — « a worker command is as trusted as the server »
   * était écrit en toutes lettres dans ce fichier, et ce n'est pas une propriété qu'on peut
   * accorder à un exécutable tiers.
   *
   * CE QUE CELA NE RÉSOUT PAS : un agent CLI lit aussi ses identifiants sur le DISQUE
   * (`~/.claude`, `~/.codex`). L'isolation du système de fichiers demande un bac à sable.
   */
  env?: Record<string, string>;
  /**
   * Noms SUPPLÉMENTAIRES hérités du parent, en plus de la liste blanche de plateforme.
   * Absent = `ICOS_WORKER_ENV_PASSTHROUGH` du processus. Fournir `[]` n'hérite que la
   * plateforme — c'est le mode le plus strict et il reste exprimable.
   */
  envPassthrough?: readonly string[];
  timeoutMs: number;
  /** Per-stream cap. Default 1 MiB. */
  maxOutputBytes?: number;
  /**
   * CONFINEMENT RÉEL DU DISQUE ET DU RÉSEAU (verrou C8).
   *
   * Absent = aucun bac à sable, comme avant. Présent = le processus est lancé SOUS
   * `sandbox-exec` avec un profil `(deny default)` : il ne voit que son worktree, son HOME
   * jetable et les chemins système, et n'a de réseau que si la politique l'accorde.
   *
   * `cwd` n'a jamais été une barrière ; ceci en est une, appliquée par le noyau.
   */
  sandbox?: SandboxPolicy;
  /**
   * Que faire si le mécanisme de bac à sable est indisponible (autre OS, binaire retiré).
   *
   * `required` (défaut quand `sandbox` est fourni) REFUSE de lancer : une exécution
   * annoncée confinée qui ne l'est pas est pire qu'un échec, parce que l'audit mentirait.
   * `best-effort` lance quand même et le RÉSULTAT le dit (`confinement: "none"`), ce qui
   * laisse un déploiement non-macOS fonctionner sans jamais prétendre être isolé.
   */
  confinement?: "required" | "best-effort";
}

export interface NonInteractiveProcessResult {
  stdout: string;
  stderr: string;
  /** Null when the process never ran, or died by signal. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** True when either stream hit `maxOutputBytes`. Evidence, not a verdict. */
  truncated: boolean;
  /**
   * CE QUI A RÉELLEMENT CONFINÉ ce processus. Pour l'audit, et pour que personne n'ait à
   * déduire la sécurité d'une exécution de la configuration qu'on croit avoir appliquée.
   * `"none"` veut dire : rien ne l'a confiné.
   */
  confinement: SandboxMechanism;
  /** Le réseau a-t-il été refusé PAR L'OS ? Faux dès qu'un endpoint est nécessaire. */
  networkEnforced: boolean;
}

export type NonInteractiveRunner = (
  spec: NonInteractiveProcessSpec,
) => Promise<NonInteractiveProcessResult>;

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
/** Grace between SIGTERM and SIGKILL: a chance to flush, not a chance to linger. */
export const KILL_GRACE_MS = 2_000;

/** `sandbox-exec` : présent sur macOS, absent ailleurs. Résolu une fois par processus. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * LA DÉCISION DE CONFINEMENT, pure et donc testable sans retirer `sandbox-exec` de l'hôte.
 *
 * Elle porte la propriété qui rend l'audit fiable : un bac à sable DEMANDÉ mais
 * INDISPONIBLE refuse de lancer. Une exécution annoncée confinée qui ne l'est pas ferait
 * mentir la trace, et une trace qui ment est pire que pas de trace.
 */
export function decideConfinement(
  wantsSandbox: boolean,
  available: boolean,
  mode: "required" | "best-effort" = "required",
): { mechanism: SandboxMechanism; refuse: boolean } {
  if (!wantsSandbox) return { mechanism: "none", refuse: false };
  if (available) return { mechanism: "seatbelt", refuse: false };
  return { mechanism: "none", refuse: mode === "required" };
}

function sandboxAvailable(): boolean {
  try {
    return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
  } catch {
    return false;
  }
}

/**
 * Enveloppe argv dans `sandbox-exec -p <profil>`.
 *
 * `-p` prend le profil en ARGUMENT, pas par un fichier : un fichier temporaire serait un
 * chemin de plus à créer, à autoriser dans le profil lui-même, et à nettoyer — trois
 * occasions de laisser une porte ouverte. Et comme on n'utilise pas de shell, le profil
 * n'est jamais réinterprété.
 */
function confine(
  command: string,
  args: readonly string[],
  policy: SandboxPolicy,
): { command: string; args: string[] } {
  return {
    command: SANDBOX_EXEC,
    args: ["-p", seatbeltProfile(policy), command, ...args],
  };
}

export const runNonInteractive: NonInteractiveRunner = (spec) =>
  new Promise<NonInteractiveProcessResult>((resolve) => {
    const startedAt = Date.now();
    const limit = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let stdout = "";
    let stderr = "";

    /*
     * CONFINEMENT, décidé AVANT le spawn. Un bac à sable demandé mais indisponible ne
     * lance RIEN : une exécution annoncée confinée qui ne l'est pas ferait mentir l'audit,
     * et un audit qui ment est pire que pas d'audit.
     */
    const wantsSandbox = spec.sandbox !== undefined;
    const confinement: SandboxMechanism = wantsSandbox && sandboxAvailable() ? "seatbelt" : "none";
    if (wantsSandbox && confinement === "none" && (spec.confinement ?? "required") === "required") {
      return resolve({
        stdout: "",
        stderr: "SANDBOX_UNAVAILABLE: aucun mécanisme de confinement sur cette plateforme",
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        truncated: false,
        confinement: "none",
        networkEnforced: false,
      });
    }
    const launch =
      confinement === "seatbelt" && spec.sandbox
        ? confine(spec.command, spec.args ?? [], spec.sandbox)
        : { command: spec.command, args: [...(spec.args ?? [])] };

    /* Calculé AVANT le spawn : l'enfant n'hérite que de ce qui est explicitement autorisé. */
    const env: Record<string, string> = childEnvironment({
      passthrough:
        spec.envPassthrough ?? parseEnvPassthrough(process.env.ICOS_WORKER_ENV_PASSTHROUGH),
      ...(spec.env ? { overlay: spec.env } : {}),
    });

    const child = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      /*
       * Le dépôt AUGMENTE `NodeJS.ProcessEnv` pour exiger `NODE_ENV` : c'est une contrainte
       * sur l'environnement de CE processus, pas sur celui qu'on compose pour un enfant,
       * qui peut légitimement ne pas en avoir. D'où la conversion, à cet unique endroit.
       */
      env: env as NodeJS.ProcessEnv,
      // No stdin: nothing can block waiting for a human.
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      // Ask first, insist second: a worker may still flush a partial verdict.
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, spec.timeoutMs);

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncated,
        confinement,
        /* Faux dès qu'un endpoint est requis : Seatbelt ne filtre pas par nom d'hôte. */
        networkEnforced:
          confinement === "seatbelt" && spec.sandbox ? networkEnforced(spec.sandbox) : false,
      });
    };

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= limit) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length <= limit) return next;
      truncated = true;
      return next.slice(0, limit);
    };

    child.stdout?.on("data", (chunk: Buffer) => void (stdout = append(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => void (stderr = append(stderr, chunk)));

    child.on("error", (error: Error) => {
      // Spawn failure is a RESULT, not a rejection. One shape to interpret.
      stderr = stderr || error.message;
      finish(null, null);
    });

    child.on("close", (code, signal) => finish(code, signal ?? null));
  });
