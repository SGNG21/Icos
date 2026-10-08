import type { ConfinementMechanism } from "@/core/workers/execution-record";

/**
 * CONFINEMENT RÉEL DU SYSTÈME DE FICHIERS ET DU RÉSEAU (verrou C8). Pur : ce module porte
 * la POLITIQUE ({@link SandboxPolicy}, source canonique) et la rend en profil Seatbelt pour
 * macOS ; `bubblewrap-args.ts` la rend en argv `bwrap` pour Linux, `sandbox-backend.ts`
 * choisit le backend réellement disponible, et `run-process.ts` l'applique.
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

/**
 * Ce qui applique réellement la politique. `none` est un aveu, pas un mode.
 *
 * Le type vit dans `core` parce que l'enregistrement durable d'une exécution le porte ; il
 * n'y a qu'UNE liste, et le runner la reprend telle quelle.
 */
export type SandboxMechanism = ConfinementMechanism;
/** Un mécanisme qui confine RÉELLEMENT. `none` n'en fait pas partie, par construction. */
export type ConfiningMechanism = Exclude<SandboxMechanism, "none">;

/**
 * LA politique de confinement — source canonique pour TOUS les backends. Seatbelt la rend
 * en S-expression (ci-dessous), Bubblewrap en argv (`bubblewrap-args.ts`). Aucun backend
 * n'a sa propre notion de ce qui est autorisé : il traduit celle-ci, ou il refuse.
 */
export interface SandboxPolicy {
  /** Lecture ET écriture. Le worktree du worker, son HOME éphémère. */
  readonly readWritePaths: readonly string[];
  /** Lecture seule. Fichiers de contexte explicitement accordés. */
  readonly readOnlyPaths: readonly string[];
  /** `false` = aucune sortie réseau. Appliqué par l'OS, pas déclaré. */
  readonly allowNetwork: boolean;
  /**
   * Les endpoints dont la tâche a besoin. DÉCLARATIF : ni Seatbelt ni Bubblewrap ne filtrent par nom
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

  /*
   * LE PLUS ÉTROIT GAGNE (ADR 0072, phase 0) — même sémantique que Bubblewrap.
   *
   * Un chemin accordé en LECTURE SEULE à l'intérieur d'un chemin accordé en écriture (le
   * pointeur `.git` d'un worktree) resterait sinon modifiable : les `allow` s'additionnent.
   * Seatbelt applique la DERNIÈRE règle qui correspond, donc ce refus, placé après
   * l'autorisation, l'emporte. Il ne retire que l'écriture : la lecture reste accordée.
   */
  const shadowed = policy.readOnlyPaths.filter((ro) =>
    policy.readWritePaths.some(
      (rw) => ro === rw || ro.startsWith(rw.endsWith("/") ? rw : `${rw}/`),
    ),
  );
  if (shadowed.length > 0) {
    const subpaths = shadowed
      .flatMap(pathForms)
      .map((p) => `(subpath ${quote(p)})`)
      .join(" ");
    lines.push(`(deny file-write* ${subpaths})`);
  }

  /* Un enfant qui ne peut pas écrire /dev/null se bloque sur sa propre sortie. */
  lines.push('(allow file-write-data (literal "/dev/null"))');

  if (policy.allowNetwork) {
    lines.push("(allow network-outbound)", "(allow system-socket)");
    /*
     * TLS a besoin de PLUS que d'une socket. La vérification d'un certificat sur macOS
     * passe par `trustd` via XPC, et la résolution DNS par `mDNSResponder` : sous
     * `(deny default)` ces services mach sont refusés, et le worker échoue sur
     * « invalid peer certificate: UnknownIssuer » — mesuré, pas supposé (Codex y est
     * tombé). Les ouvrir n'élargit rien sur le disque : ce sont des services système, pas
     * des chemins.
     */
    for (const service of [
      "com.apple.trustd",
      "com.apple.trustd.agent",
      "com.apple.SecurityServer",
      "com.apple.SystemConfiguration.configd",
      "com.apple.SystemConfiguration.DNSConfiguration",
      "com.apple.dnssd.service",
      "com.apple.mDNSResponder",
      "com.apple.nehelper",
      "com.apple.nesessionmanager",
      "com.apple.networkd",
      "com.apple.usymptomsd",
    ]) {
      lines.push(`(allow mach-lookup (global-name ${quote(service)}))`);
    }
  }
  /* Pas de branche `else` : `(deny default)` a déjà tout refusé. Le silence EST le refus. */

  return lines.join("\n") + "\n";
}

/**
 * Le réseau est-il RÉELLEMENT appliqué par l'OS pour cette politique ?
 *
 * `true` seulement quand la politique est « aucun réseau » : c'est la seule forme que
 * Seatbelt (`deny network*`) et Bubblewrap (espace de noms réseau vide) savent tenir.
 * Ni l'un ni l'autre ne connaît les noms d'hôtes. Dès qu'un endpoint est nécessaire, le processus a le réseau ENTIER,
 * et le dire autrement serait une isolation imaginaire.
 */
export const networkEnforced = (policy: SandboxPolicy): boolean => !policy.allowNetwork;
