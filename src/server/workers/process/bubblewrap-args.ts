import type { SandboxPolicy } from "./sandbox-profile";

/**
 * LA POLITIQUE RENDUE EN ARGV `bwrap` (verrou C8, backend Linux). Pur : ce module ne lit
 * pas le disque, il reçoit une {@link HostView} ; c'est `sandbox-backend.ts` qui fournit la
 * vraie et `run-process.ts` qui lance.
 *
 * ── LE MODÈLE : UNE RACINE VIDE, PUIS CE QUI EST NOMMÉ ──────────────────────────────────
 * Bubblewrap part d'une racine `tmpfs` VIDE. Rien de l'hôte n'existe dans le bac à sable
 * tant qu'il n'y est pas monté — c'est l'équivalent exact du `(deny default)` de Seatbelt,
 * et c'est pourquoi on ne monte JAMAIS `/` : le vrai HOME, `~/.ssh`, `~/.codex`, les autres
 * worktrees n'y sont pas refusés, ils n'y EXISTENT pas.
 *
 * Ce qui est monté, et seulement cela :
 *   - les chemins SYSTÈME en lecture seule (binaires, bibliothèques, `/etc`), comme le
 *     profil Seatbelt les accorde ;
 *   - un `/proc` propre à l'espace de PID, un `/dev` minimal, un `/tmp` VIDE et privé
 *     (tmpfs : il n'expose rien de l'hôte, il donne seulement aux outils un brouillon) ;
 *   - les `readOnlyPaths` en `--ro-bind`, les `readWritePaths` en `--bind`.
 *
 * ── L'ORDRE DES MONTAGES EST UNE DÉCISION DE SÉCURITÉ ───────────────────────────────────
 * Un montage plus tardif RECOUVRE un montage antérieur au même endroit ou au-dessus. On
 * trie donc par profondeur croissante : un chemin imbriqué gagne sur son parent, ce qui
 * fait qu'un worktree accordé en écriture SOUS une racine accordée en lecture reste
 * modifiable, et qu'un fichier accordé en lecture seule SOUS un répertoire modifiable reste
 * en lecture seule. Au MÊME chemin, la lecture seule est appliquée en dernier : quand une
 * politique se contredit, le plus restrictif l'emporte.
 *
 * ── RÉSEAU ──────────────────────────────────────────────────────────────────────────────
 * `allowNetwork: false` : espace de noms réseau NEUF, sans autre interface qu'une boucle
 * locale isolée — même `127.0.0.1` de l'hôte est injoignable. `true` : réseau de l'hôte,
 * ENTIER. Bubblewrap ne filtre pas par nom d'hôte ; `allowedEndpoints` reste déclaratif.
 *
 * ── CE QUE CE MODULE NE FAIT PAS ────────────────────────────────────────────────────────
 * Pas de `--new-session` : le runner lance déjà l'enfant via `setsid` (`detached: true`),
 * donc il n'a pas de terminal de contrôle et TIOCSTI n'a rien à viser ; et garder le
 * worker dans le GROUPE de processus de `bwrap` est ce qui permet au runner de tuer
 * l'arbre entier d'un signal. Pas de filtre seccomp : la barrière est celle des espaces
 * de noms et des montages, et ce module ne prétend pas à davantage.
 */

/** Ce qu'un chemin est sur l'hôte. `null` = n'existe pas. */
export type HostEntry =
  | { readonly kind: "directory" }
  | { readonly kind: "file" }
  | { readonly kind: "symlink"; readonly target: string };

/** La vue de l'hôte dont le rendu a besoin. Injectée, pour que le rendu reste pur. */
export interface HostView {
  /** `lstat` : ne suit pas le lien. */
  describe(path: string): HostEntry | null;
  /** Chemin réel (liens résolus), `null` si le chemin n'existe pas. */
  realpath(path: string): string | null;
}

/**
 * Chemins SYSTÈME en lecture seule. Comme pour Seatbelt : aucun répertoire utilisateur,
 * aucun secret du propriétaire. Un lien (`/bin -> usr/bin` sur un `/usr` fusionné) est
 * recréé comme LIEN, pas monté : il ne donne alors accès qu'à ce que sa cible donne déjà.
 */
export const LINUX_SYSTEM_READ_PATHS: readonly string[] = Object.freeze([
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
]);

/**
 * Le résolveur DNS. Sur un hôte systemd, `/etc/resolv.conf` est un lien vers
 * `/run/systemd/resolve/…`, hors des chemins système : sans ce fichier, un réseau accordé
 * ne résoudrait aucun nom. Monté seulement quand le réseau l'est, et seulement ce fichier.
 */
const RESOLV_CONF = "/etc/resolv.conf";

interface Mount {
  readonly source: string;
  readonly destination: string;
  readonly writable: boolean;
}

const depth = (path: string): number => path.split("/").filter((s) => s.length > 0).length;

/**
 * Les montages d'une liste de chemins accordés. Un chemin RELATIF n'a pas de sens pour un
 * bac à sable (relatif à quoi ?) et un chemin INEXISTANT n'a rien à monter : ni l'un ni
 * l'autre n'est accordé. C'est un refus, jamais un élargissement.
 *
 * Le chemin est monté à son emplacement RÉEL, et aussi sous le nom par lequel l'appelant
 * le connaît quand ils diffèrent : un worker à qui l'on a dit `ICOS_WORKSPACE_PATH=/x`
 * doit trouver `/x`, et la source montée reste la cible résolue — un lien ne peut pas
 * faire monter autre chose que ce qu'il désigne déjà.
 */
function grantMounts(paths: readonly string[], writable: boolean, host: HostView): Mount[] {
  const mounts: Mount[] = [];
  for (const path of paths) {
    if (!path.startsWith("/")) continue;
    const real = host.realpath(path);
    /*
     * La racine ENTIÈRE n'est jamais un octroi : ce serait monter le vrai HOME et tous les
     * worktrees d'un coup, c'est-à-dire ne pas avoir de bac à sable du tout.
     */
    if (real === null || real === "/") continue;
    mounts.push({ source: real, destination: real, writable });
    if (real !== path) mounts.push({ source: real, destination: path, writable });
  }
  return mounts;
}

/**
 * Tri : profondeur croissante, puis au même chemin écriture AVANT lecture seule (donc la
 * lecture seule, montée en dernier, gagne). Doublons exacts retirés.
 */
function orderMounts(mounts: readonly Mount[]): Mount[] {
  const unique = new Map<string, Mount>();
  for (const m of mounts) unique.set(`${m.destination}\0${m.source}\0${m.writable}`, m);
  return [...unique.values()].sort((a, b) => {
    const byDepth = depth(a.destination) - depth(b.destination);
    if (byDepth !== 0) return byDepth;
    if (a.destination !== b.destination) return a.destination < b.destination ? -1 : 1;
    return a.writable === b.writable ? 0 : a.writable ? -1 : 1;
  });
}

export interface BubblewrapInvocation {
  /** Répertoire de travail DANS le bac à sable. Doit y être monté, sinon `bwrap` échoue. */
  readonly cwd?: string;
}

/**
 * Les options `bwrap` de CETTE politique, jusqu'au `--` exclu. L'appelant ajoute
 * `--`, la commande et ses arguments : rien ici n'est interprété par un shell.
 */
export function bubblewrapArgs(
  policy: SandboxPolicy,
  host: HostView,
  invocation: BubblewrapInvocation = {},
): string[] {
  const args: string[] = [
    /*
     * TOUS les espaces de noms : utilisateur, PID, IPC, UTS, cgroup, réseau. Le réseau est
     * rendu ensuite seulement si la politique l'accorde.
     */
    "--unshare-all",
    /* Explicite : `--disable-userns` l'exige, et `--unshare-all` ne le garantit qu'en « try ». */
    "--unshare-user",
    /*
     * Aucun espace de noms utilisateur IMBRIQUÉ : sans cela, le worker pourrait s'en créer un
     * et y redevenir « root » pour remonter ses propres montages.
     */
    "--disable-userns",
    /* Aucune capacité, même dans son propre espace de noms. */
    "--cap-drop",
    "ALL",
    /* Si le runner meurt, le bac à sable meurt avec lui : pas d'orphelin confiné qui écrit. */
    "--die-with-parent",
  ];
  if (policy.allowNetwork) args.push("--share-net");

  for (const path of LINUX_SYSTEM_READ_PATHS) {
    const entry = host.describe(path);
    if (entry === null) continue;
    if (entry.kind === "symlink") args.push("--symlink", entry.target, path);
    else args.push("--ro-bind", path, path);
  }
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp");

  if (policy.allowNetwork) {
    const resolv = host.realpath(RESOLV_CONF);
    if (resolv !== null && resolv !== RESOLV_CONF && !resolv.startsWith("/etc/")) {
      args.push("--ro-bind", resolv, resolv);
    }
  }

  const mounts = orderMounts([
    ...grantMounts(policy.readWritePaths, true, host),
    ...grantMounts(policy.readOnlyPaths, false, host),
  ]);
  for (const m of mounts) {
    args.push(m.writable ? "--bind" : "--ro-bind", m.source, m.destination);
  }

  if (invocation.cwd !== undefined) args.push("--chdir", invocation.cwd);
  return args;
}
