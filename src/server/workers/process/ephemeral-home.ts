import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * UN HOME JETABLE PAR EXÉCUTION (verrou C8).
 *
 * ── CE QUI ÉTAIT CASSÉ ──────────────────────────────────────────────────────────────────
 * L'isolation d'environnement livrée avant ferme les secrets qui passent par des VARIABLES,
 * et laisse passer `HOME`. Or `HOME` est un trousseau : `~/.ssh`, `~/.aws`, `~/.netrc`,
 * `~/.npmrc`, `~/.claude`, `~/.codex`. Un worker qui reçoit le vrai `HOME` reçoit tout
 * cela, et l'isolation d'environnement devient décorative.
 *
 * On ne peut pas simplement RETIRER `HOME` : la plupart des CLI refusent de démarrer sans.
 * On en fournit donc un VRAI, vide, jetable, et c'est lui que le bac à sable autorise en
 * écriture — le vrai reste hors du profil, donc illisible même si quelque chose le devinait.
 *
 * ── CE QU'ON N'Y COPIE PAS ──────────────────────────────────────────────────────────────
 * RIEN, par défaut. Pas de copie en masse du vrai HOME : ce serait exactement la fuite
 * qu'on ferme, avec une étape de plus. Ce qu'un exécuteur donné exige réellement est
 * déposé NOMMÉMENT par l'appelant (`seed`), et c'est alors une décision visible, pas un
 * héritage.
 *
 * CONSÉQUENCE ASSUMÉE : un CLI qui s'authentifie par un fichier de son vrai HOME
 * (`~/.codex/auth.json`) ne s'authentifiera PAS ici tant que le courtier d'identifiants ne
 * lui dépose pas l'équivalent. C'est voulu : un worker ne doit pas se connecter avec les
 * identifiants personnels du propriétaire parce qu'ils traînaient sur le disque.
 */

export interface EphemeralHome {
  /** Chemin absolu du HOME jetable. À autoriser en lecture/écriture dans le bac à sable. */
  readonly path: string;
  /** Supprime le répertoire et tout ce que le worker y a écrit. Idempotent. */
  readonly dispose: () => Promise<void>;
}

/** Fichier déposé nommément dans le HOME jetable (`.codex/auth.json`, …). */
export interface HomeSeedFile {
  /** Chemin RELATIF au HOME. Un chemin absolu ou remontant est refusé. */
  readonly relativePath: string;
  readonly contents: string;
  /** 0o600 par défaut : un identifiant n'est pas lisible par le monde. */
  readonly mode?: number;
}

/**
 * Crée un HOME vide et jetable. `dispose()` doit être appelé dans un `finally` : un HOME
 * abandonné contenant ce que le courtier y a déposé est exactement ce qu'on évitait.
 */
export async function createEphemeralHome(prefix = "icos-worker-home-"): Promise<EphemeralHome> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  let disposed = false;
  return {
    path,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * Refuse un chemin de dépôt qui sortirait du HOME.
 *
 * Trois formes d'évasion, refusées explicitement parce qu'un courtier d'identifiants est
 * précisément l'endroit où une chaîne venue d'une configuration devient un chemin :
 * l'absolu (`/Users/coco/.ssh/id_rsa`), la remontée (`../../.ssh/id_rsa`), et le vide.
 * On valide la FORME, jamais le résultat d'une concaténation — un test sur le chemin
 * concaténé raterait `a/../../b`.
 */
export function isSafeHomeRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0) return false;
  if (relativePath.startsWith("/") || /^[A-Za-z]:/.test(relativePath)) return false;
  if (relativePath.includes("\0")) return false;
  const segments = relativePath.split(/[/\\]/);
  if (segments.some((s) => s === "..")) return false;
  /* `~` en tête serait réinterprété par un shell ou une bibliothèque de chemins. */
  if (segments[0] === "~") return false;
  return true;
}
