import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isSafeHomeRelativePath, type HomeSeedFile } from "./ephemeral-home";

/**
 * COURTIER D'IDENTIFIANTS — ce qu'une tâche REÇOIT, et rien de plus (verrou C8).
 *
 * ── LE DÉFAUT QU'IL FERME ───────────────────────────────────────────────────────────────
 * « Le worker a besoin d'une clé, donc on lui passe l'environnement » est la pensée qui
 * donnait `DATABASE_URL` à un agent CLI. Un identifiant n'est pas une variable d'ambiance :
 * c'est une CAPACITÉ, accordée à une tâche précise, pour un fournisseur précis, le temps
 * d'une exécution.
 *
 * ── LA RÈGLE ────────────────────────────────────────────────────────────────────────────
 * Une tâche déclare les capacités dont elle a besoin (`nvidia`, `openrouter`, `openai`…).
 * Le courtier résout CHACUNE, et rien d'autre. Une capacité non demandée n'est pas
 * accordée ; une capacité demandée mais introuvable est un REFUS explicite, jamais un
 * silence qui ferait partir le worker sans identifiant pour échouer plus loin.
 *
 * ── CE QUI EST TRACÉ, ET CE QUI NE L'EST JAMAIS ─────────────────────────────────────────
 * L'audit porte le TYPE, l'IDENTIFIANT de la capacité, l'instant d'octroi et l'instant de
 * révocation. JAMAIS la valeur. {@link CredentialGrantRecord} ne contient aucun champ
 * capable de la porter — ce n'est pas une discipline de journalisation, c'est le type.
 *
 * ── RÉVOCATION ──────────────────────────────────────────────────────────────────────────
 * Une capacité livrée dans le HOME jetable disparaît avec lui. `revokedAt` est donc un fait
 * observé (le HOME a été détruit), pas une intention.
 */

/** Une capacité nommée, résolue au moment de l'exécution. Jamais une valeur en clair ici. */
export interface CredentialCapability {
  /** Identifiant stable, pour l'audit : `nvidia`, `openrouter`, `openai`. */
  readonly id: string;
  /** Comment le worker la recevra. */
  readonly kind: "env" | "file";
  /** Pour `env` : le NOM de la variable. Pour `file` : le chemin relatif au HOME jetable. */
  readonly target: string;
}

/** Résout la VALEUR d'une capacité. Séparé pour que rien d'autre ne la touche. */
export type CredentialResolver = (capability: CredentialCapability) => string | undefined;

/**
 * À QUELLE EXÉCUTION cette capacité est accordée.
 *
 * Un identifiant était courtisé par COMMANDE : deux tâches servies par le même exécuteur
 * recevaient le même secret, et rien ne disait laquelle l'avait reçu. Une capacité est
 * accordée à une tâche précise pour la durée d'une exécution — c'est déjà ce que dit la
 * règle en tête de ce fichier ; voici ce qui la rend vérifiable.
 */
export interface CredentialBinding {
  readonly taskId: string;
  readonly workflowId: string;
  /** L'exécuteur qu'ICOS a routé pour cette tâche. Tracé, jamais déduit ici. */
  readonly executor: string;
}

/** Ce que l'audit garde. Aucun champ ne peut porter la valeur : c'est le point. */
export interface CredentialGrantRecord {
  readonly capabilityId: string;
  /** La tâche et le workflow qui ont reçu la capacité, et par quel exécuteur. */
  readonly boundTo?: CredentialBinding;
  readonly kind: CredentialCapability["kind"];
  /** Nom de variable ou chemin relatif. Un NOM, jamais un contenu. */
  readonly target: string;
  readonly grantedAt: string;
  /** Rempli quand le HOME jetable a réellement été détruit. */
  revokedAt?: string;
}

export type BrokerOutcome =
  | {
      readonly ok: true;
      /** Variables à superposer sur l'environnement de l'enfant. */
      readonly env: Record<string, string>;
      /** Fichiers à déposer dans le HOME jetable. */
      readonly files: readonly HomeSeedFile[];
      readonly grants: readonly CredentialGrantRecord[];
    }
  | {
      readonly ok: false;
      /** Capacités demandées et introuvables, ou dont la cible est illégale. */
      readonly missing: readonly string[];
      readonly reason: "CREDENTIAL_UNAVAILABLE" | "CREDENTIAL_TARGET_REJECTED";
    };

/**
 * Accorde EXACTEMENT les capacités demandées. Fermé par défaut à chaque étage : une
 * capacité absente refuse, une cible de fichier qui sortirait du HOME refuse, et aucune
 * valeur ne traverse autrement que vers l'enfant.
 */
export function brokerCredentials(
  requested: readonly CredentialCapability[],
  resolve: CredentialResolver,
  now: () => string = () => new Date().toISOString(),
  /**
   * Liée à une exécution. Optionnelle pour les appelants d'avant ce verrou, qui courtisent
   * hors d'une tâche ; présente, elle est VÉRIFIÉE : une capacité dont l'identifiant porte
   * une autre tâche est refusée, donc le grant de la tâche A ne peut pas servir à B.
   */
  binding?: CredentialBinding,
): BrokerOutcome {
  const env: Record<string, string> = {};
  const files: HomeSeedFile[] = [];
  const grants: CredentialGrantRecord[] = [];
  const missing: string[] = [];
  const rejected: string[] = [];

  for (const capability of requested) {
    if (binding && !capability.id.startsWith(`${binding.taskId}:`)) {
      /*
       * L'identifiant porte la tâche à laquelle la capacité a été préparée. Une capacité
       * préparée pour une autre tâche n'est pas « manquante » : elle est REFUSÉE.
       */
      rejected.push(capability.id);
      continue;
    }
    if (capability.kind === "file" && !isSafeHomeRelativePath(capability.target)) {
      /* Un chemin absolu ou remontant écrirait HORS du HOME jetable : refus net. */
      rejected.push(capability.id);
      continue;
    }
    const value = resolve(capability);
    if (value === undefined || value.length === 0) {
      missing.push(capability.id);
      continue;
    }
    if (capability.kind === "env") env[capability.target] = value;
    else files.push({ relativePath: capability.target, contents: value, mode: 0o600 });
    grants.push({
      capabilityId: capability.id,
      ...(binding ? { boundTo: binding } : {}),
      kind: capability.kind,
      target: capability.target,
      grantedAt: now(),
    });
  }

  if (rejected.length > 0) {
    return { ok: false, missing: rejected, reason: "CREDENTIAL_TARGET_REJECTED" };
  }
  if (missing.length > 0) return { ok: false, missing, reason: "CREDENTIAL_UNAVAILABLE" };
  return { ok: true, env, files, grants };
}

/** Dépose les fichiers accordés dans le HOME jetable, en 0600. */
export async function seedHome(homePath: string, files: readonly HomeSeedFile[]): Promise<void> {
  for (const file of files) {
    if (!isSafeHomeRelativePath(file.relativePath)) {
      /* Double contrôle : ce module ne fait jamais confiance à un appelant sur un chemin. */
      throw new Error(`CREDENTIAL_TARGET_REJECTED:${file.relativePath}`);
    }
    const absolute = join(homePath, file.relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.contents, { mode: file.mode ?? 0o600 });
  }
}

/** Marque les octrois comme révoqués. Appelé APRÈS la destruction du HOME jetable. */
export function revokeGrants(
  grants: readonly CredentialGrantRecord[],
  at: string,
): CredentialGrantRecord[] {
  return grants.map((grant) => ({ ...grant, revokedAt: at }));
}
