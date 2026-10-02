import { readFile } from "node:fs/promises";

import type { WorkerUsageReading } from "@/core/budget/worker-budget";

/**
 * LIRE LA CONSOMMATION RÉELLE D'UN WORKER EXTERNE (comptabilité des workers).
 *
 * Un sous-processus ne traverse aucune couture d'ICOS, donc rien ne le mesure
 * automatiquement. Mais les exécuteurs la RAPPORTENT, et c'est vérifié sur de vraies
 * exécutions plutôt que supposé :
 *
 *   hermes  `--usage-file <chemin>` écrit un JSON avec `input_tokens`, `output_tokens`,
 *           `total_tokens`, `model`, `provider`. C'est la source la plus fiable des deux.
 *   codex   imprime `tokens used N` à la fin de `codex exec`. Un seul total, donc on ne
 *           peut PAS prétendre connaître la répartition entrée/sortie.
 *
 * ── LA RÈGLE QUI COMPTE ─────────────────────────────────────────────────────────────────
 * Quand le chiffre n'est pas là, on rend UNMEASURED avec sa raison. Jamais zéro, jamais une
 * estimation : un worker coûteux qui passerait pour gratuit est exactement ce que la règle
 * « une absence n'est jamais un zéro » interdit. Le budget de SUBSTITUTION (invocations,
 * horloge) est ce qui borne alors, et il est nommé comme tel.
 */

/** Entier de tokens plausible. Une valeur absurde est une absence, pas une mesure. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Hermes : le fichier d'usage. Le plus riche des deux — entrée, sortie, total, modèle.
 *
 * `total_tokens` est préféré au calcul `input + output` quand il est présent : il inclut le
 * raisonnement et le cache, que la somme des deux autres ignore. Charger ces tokens-là à
 * zéro est précisément le défaut qu'une revue précédente avait classé HIGH.
 */
export async function readHermesUsage(usageFilePath: string): Promise<WorkerUsageReading> {
  let raw: string;
  try {
    raw = await readFile(usageFilePath, "utf8");
  } catch {
    return { kind: "UNMEASURED", reason: "HERMES_USAGE_FILE_ABSENT" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "UNMEASURED", reason: "HERMES_USAGE_FILE_UNREADABLE" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "UNMEASURED", reason: "HERMES_USAGE_FILE_UNREADABLE" };
  }
  const row = parsed as Record<string, unknown>;
  const promptTokens = count(row.input_tokens);
  const completionTokens = count(row.output_tokens);
  const reported = count(row.total_tokens);
  if (promptTokens === null || completionTokens === null) {
    return { kind: "UNMEASURED", reason: "HERMES_USAGE_INCOMPLETE" };
  }
  /* Le total du fournisseur fait foi s'il est au moins la somme : il porte le raisonnement. */
  const totalTokens =
    reported !== null && reported >= promptTokens + completionTokens
      ? reported
      : promptTokens + completionTokens;
  const model = typeof row.model === "string" ? row.model : undefined;
  return {
    kind: "MEASURED",
    usage: { promptTokens, completionTokens, totalTokens },
    source: "hermes:usage-file",
    ...(model ? { model } : {}),
  };
}

/**
 * Codex : `tokens used N` en fin de sortie. Le séparateur de milliers est une espace
 * insécable fine selon la locale, donc on l'accepte explicitement au lieu d'espérer.
 *
 * UN SEUL TOTAL EST CONNU. On ne répartit donc PAS entre entrée et sortie : les deux sont
 * rapportés à 0 et le total porte la vérité. Inventer une répartition serait une mesure
 * fabriquée, et `promptTokens`/`completionTokens` ne sont utilisés nulle part comme base de
 * prix — seul `totalTokens` l'est.
 */
const CODEX_TOKENS = /tokens used[:\s]+([\d   ,. ]+)/i;

export function readCodexUsage(output: string): WorkerUsageReading {
  const match = CODEX_TOKENS.exec(output);
  if (!match?.[1]) return { kind: "UNMEASURED", reason: "CODEX_TOKENS_ABSENT" };
  const digits = match[1].replace(/[^\d]/g, "");
  const totalTokens = count(Number(digits));
  if (totalTokens === null || digits.length === 0) {
    return { kind: "UNMEASURED", reason: "CODEX_TOKENS_UNREADABLE" };
  }
  return {
    kind: "MEASURED",
    /* Répartition inconnue : on le dit par des zéros explicites, pas par une invention. */
    usage: { promptTokens: 0, completionTokens: 0, totalTokens },
    source: "codex:stdout",
  };
}

/** Les lecteurs connus, par exécuteur. Un exécuteur inconnu rend UNMEASURED, pas zéro. */
export async function readWorkerUsage(input: {
  readonly executor: string;
  readonly output: string;
  readonly usageFilePath?: string;
}): Promise<WorkerUsageReading> {
  if (input.executor === "hermes" && input.usageFilePath) {
    return readHermesUsage(input.usageFilePath);
  }
  if (input.executor === "codex") return readCodexUsage(input.output);
  return { kind: "UNMEASURED", reason: `NO_USAGE_READER_FOR:${input.executor}` };
}
