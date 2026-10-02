/**
 * CE QU'UN PROCESSUS ENFANT A LE DROIT DE VOIR (verrou C8 — isolation des secrets).
 *
 * ── CE QUI ÉTAIT CASSÉ ──────────────────────────────────────────────────────────────────
 * `runNonInteractive` passait `process.env` ENTIER à chaque worker externe, et son propre
 * commentaire l'assumait : « the child can see this process's secrets, so a worker command
 * is as trusted as the server ». Concrètement, tout agent CLI lancé par ICOS pouvait lire
 * `DATABASE_URL`, `OMNIROUTE_API_KEY`, les identifiants d'authentification et tout le reste
 * — y compris de quoi parler à la base de production. « Aussi fiable que le serveur » n'est
 * pas une propriété qu'on peut accorder à un exécutable tiers.
 *
 * ── LA RÈGLE, FERMÉE PAR DÉFAUT ─────────────────────────────────────────────────────────
 * L'enfant ne reçoit QUE :
 *   1. les variables de la LISTE BLANCHE ci-dessous, qui sont des variables de plateforme
 *      sans valeur de secret (où est HOME, quel est le PATH, quelle langue) ;
 *   2. ce que le déploiement a explicitement ajouté (`ICOS_WORKER_ENV_PASSTHROUGH`) ;
 *   3. ce que l'appelant superpose nommément (`spec.env`), qui reste son choix explicite.
 *
 * Tout le reste est RETIRÉ. Une variable inconnue est traitée comme un secret, parce que
 * c'est le seul défaut qui ne se trompe pas dans le sens coûteux : au pire un worker
 * manque d'une variable et échoue bruyamment, au mieux il ne lit pas une clé d'API.
 *
 * ── POURQUOI UNE LISTE BLANCHE ET PAS UNE LISTE NOIRE ───────────────────────────────────
 * Une liste noire doit connaître le nom de chaque secret, donc elle est fausse dès qu'une
 * variable est ajoutée — et personne ne pense à la mettre à jour en même temps. Une liste
 * blanche est fausse dans l'autre sens : elle fait échouer un worker, ce qui se voit tout
 * de suite et se corrige par configuration.
 *
 * ── CE QUE CELA NE RÉSOUT PAS ───────────────────────────────────────────────────────────
 * Un agent CLI lit aussi ses propres identifiants sur le DISQUE (`~/.claude`, `~/.codex`,
 * `~/.hermes`). Retirer `HOME` les lui enlèverait, mais l'empêcherait aussi de fonctionner
 * du tout. L'isolation du système de fichiers appartient à un bac à sable, pas à une
 * variable d'environnement, et ce fichier ne prétend pas la fournir.
 */

/**
 * Variables de PLATEFORME, jamais de secret. Un worker en a besoin pour s'exécuter :
 * trouver ses binaires, son dossier personnel, un répertoire temporaire, un encodage.
 */
export const DEFAULT_CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  /* Windows : sans eux, aucun processus ne démarre. */
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]);

/** Liste supplémentaire déclarée par le déploiement, séparée par des virgules. */
export function parseEnvPassthrough(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    ),
  ];
}

export interface ChildEnvironmentOptions {
  /** L'environnement du parent. Injectable pour que le test n'ait pas à muter le processus. */
  readonly parent?: NodeJS.ProcessEnv;
  /** Noms supplémentaires autorisés, en plus de {@link DEFAULT_CHILD_ENV_ALLOWLIST}. */
  readonly passthrough?: readonly string[];
  /** Variables posées nommément par l'appelant. Elles gagnent sur l'héritage. */
  readonly overlay?: Readonly<Record<string, string>>;
}

/**
 * L'environnement RÉEL d'un enfant. Rien n'est hérité qui ne soit explicitement autorisé.
 */
export function childEnvironment(options: ChildEnvironmentOptions = {}): Record<string, string> {
  const parent = options.parent ?? process.env;
  const allowed = new Set([...DEFAULT_CHILD_ENV_ALLOWLIST, ...(options.passthrough ?? [])]);

  const env: Record<string, string> = {};
  for (const name of allowed) {
    const value = parent[name];
    /* Une variable absente reste absente : on n'invente pas de chaîne vide. */
    if (typeof value === "string") env[name] = value;
  }
  /* La superposition de l'appelant est un choix explicite : elle passe toujours. */
  for (const [name, value] of Object.entries(options.overlay ?? {})) env[name] = value;
  return env;
}
