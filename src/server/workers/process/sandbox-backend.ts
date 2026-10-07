import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";

import { bubblewrapArgs, type HostView } from "./bubblewrap-args";
import type { ConfiningMechanism } from "./sandbox-profile";

/**
 * QUEL MÉCANISME PEUT RÉELLEMENT CONFINER ICI ? (verrou C8)
 *
 * La réponse est une PREUVE, pas une configuration :
 *   - macOS : `sandbox-exec` (Seatbelt) à son chemin système fixe ;
 *   - Linux : `bwrap` à son chemin système fixe, ET une sonde qui lance réellement un
 *     processus sous les MÊMES options que celles d'une exécution gouvernée.
 *
 * ── POURQUOI UNE SONDE SUR LINUX ────────────────────────────────────────────────────────
 * La présence du binaire ne prouve rien. Sur Ubuntu 24.04, AppArmor restreint les espaces
 * de noms utilisateur non privilégiés (`kernel.apparmor_restrict_unprivileged_userns=1`) :
 * sans profil qui l'autorise, `bwrap` est installé et échoue à chaque lancement
 * (« setting up uid map: Permission denied »). Mesuré sur l'hôte, pas supposé. Le
 * déclarer disponible ferait échouer chaque worker d'une erreur obscure au lieu de le
 * refuser pour la bonne raison.
 *
 * ── POURQUOI DES CHEMINS FIXES ──────────────────────────────────────────────────────────
 * Résoudre `bwrap` par le `PATH` laisserait quiconque contrôle le `PATH` fournir un faux
 * bac à sable qui exécute la commande sans rien confiner — et l'audit dirait
 * « bubblewrap ». Le binaire de confinement vient de l'OS, à l'endroit où l'OS l'installe.
 *
 * ── FERMÉ PAR DÉFAUT ────────────────────────────────────────────────────────────────────
 * Toute autre plateforme, toute sonde qui échoue, toute exception : AUCUN backend. Le
 * runner refuse alors une exécution dont le confinement est exigé. Il n'existe pas de
 * repli sur `unshare` seul ni sur `cwd` : ce ne sont pas des barrières démontrées.
 */

/** `sandbox-exec` : présent sur macOS, absent ailleurs. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** `bwrap` tel que l'installe le paquet `bubblewrap` des distributions. */
export const BWRAP = "/usr/bin/bwrap";

export interface SandboxBackend {
  readonly mechanism: ConfiningMechanism;
  /** Le binaire qui applique la politique, à son chemin absolu fixe. */
  readonly executable: string;
}

/** Le verdict de détection : un backend, ou la RAISON précise de son absence. */
export type SandboxBackendDetection =
  | { readonly backend: SandboxBackend; readonly reason?: undefined }
  | { readonly backend: null; readonly reason: string };

/** La vue réelle de l'hôte, pour le rendu Bubblewrap. Toute erreur = « n'existe pas ». */
export const nodeHostView: HostView = {
  describe(path) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return { kind: "symlink", target: readlinkSync(path) };
      return stat.isDirectory() ? { kind: "directory" } : { kind: "file" };
    } catch {
      return null;
    }
  },
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
};

export interface DetectionEnvironment {
  readonly platform: NodeJS.Platform;
  readonly exists: (path: string) => boolean;
  /**
   * Lance `true` sous `bwrap` avec les options d'une exécution réelle. `true` = le bac à
   * sable s'est monté ET la commande y a tourné.
   */
  readonly probeBubblewrap: () => { ok: true } | { ok: false; detail: string };
}

/** La sonde réelle. Politique minimale, sans réseau : la forme la plus stricte. */
function probeBubblewrap(): { ok: true } | { ok: false; detail: string } {
  try {
    const result = spawnSync(
      BWRAP,
      [
        ...bubblewrapArgs(
          { readWritePaths: [], readOnlyPaths: [], allowNetwork: false },
          nodeHostView,
        ),
        "--",
        "/usr/bin/true",
      ],
      /* Même conversion qu'au runner : le dépôt exige `NODE_ENV` sur l'env de CE processus. */
      { env: {} as NodeJS.ProcessEnv, stdio: ["ignore", "ignore", "pipe"], timeout: 10_000 },
    );
    if (result.status === 0) return { ok: true };
    const stderr = result.stderr?.toString("utf8").trim();
    return {
      ok: false,
      detail: stderr || result.error?.message || `exit ${String(result.status)}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** La décision, pure étant donné son environnement : testable sur n'importe quel OS. */
export function detectSandboxBackend(
  env: DetectionEnvironment = {
    platform: process.platform,
    exists: (path) => {
      try {
        return existsSync(path);
      } catch {
        return false;
      }
    },
    probeBubblewrap,
  },
): SandboxBackendDetection {
  if (env.platform === "darwin") {
    return env.exists(SANDBOX_EXEC)
      ? { backend: { mechanism: "seatbelt", executable: SANDBOX_EXEC } }
      : { backend: null, reason: `${SANDBOX_EXEC} absent` };
  }
  if (env.platform === "linux") {
    if (!env.exists(BWRAP)) {
      return { backend: null, reason: `${BWRAP} absent (installer le paquet bubblewrap)` };
    }
    const probe = env.probeBubblewrap();
    if (!probe.ok) {
      return {
        backend: null,
        reason: `${BWRAP} présent mais inutilisable ici : ${probe.detail}`,
      };
    }
    return { backend: { mechanism: "bubblewrap", executable: BWRAP } };
  }
  return { backend: null, reason: `aucun backend de confinement pour ${env.platform}` };
}

let cached: SandboxBackendDetection | undefined;

/**
 * La détection de CE processus, faite une fois : la remesurer coûterait un processus par
 * exécution pour la même réponse. Corriger l'hôte (installer `bubblewrap`, charger son
 * profil AppArmor) demande donc de REDÉMARRER le worker ; jusque-là il continue de refuser,
 * ce qui est le sens sûr de l'erreur.
 */
export function sandboxBackend(): SandboxBackendDetection {
  cached ??= detectSandboxBackend();
  return cached;
}
