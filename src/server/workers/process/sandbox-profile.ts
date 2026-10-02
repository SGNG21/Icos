/**
 * CONFINEMENT RÉEL DU SYSTÈME DE FICHIERS ET DU RÉSEAU (verrou C8). Pur : ce module ne fait
 * que RENDRE un profil Seatbelt ; c'est `run-process.ts` qui l'applique.
 *
 * ── POURQUOI UN PROFIL OS ET PAS UN `cwd` ───────────────────────────────────────────────
 * `cwd` n'est pas un bac à sable : un processus lancé dans un worktree peut lire
 * `~/.ssh`, `~/.aws`, `~/.claude`, un autre worktree, ou la base live. L'isolation
 * d'environnement livrée précédemment a fermé les secrets qui passent par des VARIABLES ;
 * elle ne pouvait rien contre ceux qui sont sur le DISQUE. Ceci ferme cela.
 *
 * ── LE MÉCANISME CHOISI, ET SON PRIX ────────────────────────────────────────────────────
 * `sandbox-exec` (Seatbelt), vérifié fonctionnel sur cet hôte (macOS 26.5.1) : un worker
 * écrit bien son worktree, et se voit refuser `~/.codex` avec « Operation not permitted ».
 * C'est une interdiction du NOYAU, pas une convention.
 *
 * Son prix, dit franchement : Apple le marque DÉPRÉCIÉ depuis des années. Il fonctionne, il
 * n'a pas de remplaçant en ligne de commande, et un conteneur serait plus fort mais
 * imposerait Docker à chaque exécution de worker. Le choix est donc : la meilleure barrière
 * réellement disponible ici, avec un port conteneur explicitement prévu
 * ({@link SandboxMechanism}) plutôt qu'une promesse.
 *
 * ── CE QUE LE RÉSEAU PEUT ET NE PEUT PAS ────────────────────────────────────────────────
 * Mesuré : `deny` bloque la sortie (curl rend 000), `allow` la laisse passer (200). Le
 * TOUT-OU-RIEN est donc applicable par l'OS. Le filtrage PAR ENDPOINT ne l'est pas :
 * Seatbelt ne connaît pas les noms d'hôtes. Une politique « NVIDIA seulement » est donc
 * DÉCLARÉE et non appliquée, et ce module refuse de prétendre le contraire — voir
 * `networkEnforced`.
 */

/** Ce qui applique réellement la politique. `none` est un aveu, pas un mode. */
export type SandboxMechanism = "seatbelt" | "none";

export interface SandboxPolicy {
  /** Lecture ET écriture. Le worktree du worker, son HOME éphémère. */
  readonly readWritePaths: readonly string[];
  /** Lecture seule. Fichiers de contexte explicitement accordés. */
  readonly readOnlyPaths: readonly string[];
  /** `false` = aucune sortie réseau. Appliqué par l'OS, pas déclaré. */
  readonly allowNetwork: boolean;
  /**
   * Les endpoints dont la tâche a besoin. DÉCLARATIF : Seatbelt ne filtre pas par nom
   * d'hôte, donc ceci documente l'intention et alimente l'audit. Ne jamais le présenter
   * comme une isolation réseau.
   */
  readonly allowedEndpoints?: readonly string[];
}

/**
 * Chemins SYSTÈME en lecture seule, sans lesquels aucun binaire ne démarre : l'éditeur de
 * liens, les bibliothèques partagées, les certificats. Aucun n'est un répertoire
 * utilisateur, et aucun ne contient de secret du propriétaire.
 */
const SYSTEM_READ_PATHS: readonly string[] = Object.freeze([
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/opt/homebrew",
  "/private/var/select",
  "/private/etc",
  "/etc",
]);

/** Échappe une chaîne pour une S-expression Seatbelt. Jamais d'interpolation brute. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `/tmp` est un lien symbolique vers `/private/tmp` sur macOS, et Seatbelt raisonne sur le
 * chemin RÉSOLU. Autoriser l'un sans l'autre produit un refus incompréhensible, donc on
 * déclare les deux formes quand elles existent.
 */
function pathForms(path: string): string[] {
  const forms = new Set([path]);
  if (path.startsWith("/tmp/")) forms.add(`/private${path}`);
  if (path.startsWith("/var/")) forms.add(`/private${path}`);
  if (path.startsWith("/private/tmp/")) forms.add(path.slice("/private".length));
  if (path.startsWith("/private/var/")) forms.add(path.slice("/private".length));
  return [...forms];
}

/**
 * Le profil Seatbelt de CETTE exécution. `(deny default)` d'abord : tout ce qui n'est pas
 * nommé est interdit. Une liste noire serait fausse dès le prochain répertoire sensible.
 */
export function seatbeltProfile(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    /* La base BSD : sans elle, même `curl` meurt sur SIGABRT avant toute politique. */
    '(import "/System/Library/Sandbox/Profiles/bsd.sb")',
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow sysctl-read)",
    "(allow signal (target self))",
  ];

  const read = [...SYSTEM_READ_PATHS, ...policy.readOnlyPaths.flatMap(pathForms)];
  lines.push(`(allow file-read* ${read.map((p) => `(subpath ${quote(p)})`).join(" ")})`);

  const write = policy.readWritePaths.flatMap(pathForms);
  if (write.length > 0) {
    const subpaths = write.map((p) => `(subpath ${quote(p)})`).join(" ");
    lines.push(`(allow file-read* file-write* ${subpaths})`);
  }

  /* Un enfant qui ne peut pas écrire /dev/null se bloque sur sa propre sortie. */
  lines.push('(allow file-write-data (literal "/dev/null"))');

  if (policy.allowNetwork) {
    lines.push("(allow network-outbound)", "(allow system-socket)");
  }
  /* Pas de branche `else` : `(deny default)` a déjà tout refusé. Le silence EST le refus. */

  return lines.join("\n") + "\n";
}

/**
 * Le réseau est-il RÉELLEMENT appliqué par l'OS pour cette politique ?
 *
 * `true` seulement quand la politique est « aucun réseau » : c'est la seule forme que
 * Seatbelt sait tenir. Dès qu'un endpoint est nécessaire, le processus a le réseau ENTIER,
 * et le dire autrement serait une isolation imaginaire.
 */
export const networkEnforced = (policy: SandboxPolicy): boolean => !policy.allowNetwork;
