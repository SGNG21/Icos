import { UNKNOWN, type Maybe, type WorkClass } from "@/core/supervisor/contracts";

/**
 * CHIEF INTAKE CLASSIFICATION. Pure: no clock, no env, no database, no model call.
 *
 * Turns ONE natural-language objective ("Améliore ICOS pendant 2 heures. Budget maximum
 * 10 EUR. Pas de déploiement sans mon accord.") into the bounds ICOS is allowed to work
 * within. It decides NOTHING about who does the work — that is `./delegation`.
 *
 * It adds NO work-class vocabulary: `WorkClass` and the `UNKNOWN` sentinel are the
 * supervisor's (decision 0065). This module is the TEXT reader; `supervisor/priority.ts`
 * `classifyObjective` is the METADATA reader over an already-admitted goal. Two inputs,
 * one vocabulary, no second authority — hence the distinct name `classifyRawObjective`.
 *
 * Fail closed throughout: a sentence that does not clearly classify is UNKNOWN (never
 * guessed into SELF_IMPROVEMENT, which is self-modifying work), an absent bound is the
 * UNKNOWN sentinel (never unlimited, never 0), and silence about deployment means
 * approval is still required.
 */

export type Currency = "EUR" | "USD";

export interface MoneyBound {
  readonly amount: number;
  readonly currency: Currency;
}

/** Work a plan may never schedule by itself; it goes to the owner instead. */
export const ESCALATION_KINDS = [
  "DEPLOYMENT",
  "CREDENTIALS",
  "PERMISSIONS",
  "POLICY_DISABLING",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export interface ClassifiedObjective {
  readonly raw: string;
  readonly workClass: Maybe<WorkClass>;
  /** Minutes. UNKNOWN when the objective states no duration. */
  readonly durationMinutes: Maybe<number>;
  /** UNKNOWN when the objective states no budget. UNKNOWN is NOT "unlimited". */
  readonly budget: Maybe<MoneyBound>;
  /** True unless the objective explicitly and affirmatively permits deploying. */
  readonly deploymentRequiresApproval: boolean;
  readonly escalations: readonly EscalationKind[];
  /** Provenance, enough to re-derive every field above by hand. */
  readonly evidence: readonly string[];
}

export interface ClassificationContext {
  /** Client names ICOS already knows. A proper noun is NOT a client just because it looks like one. */
  readonly knownClients?: readonly string[];
}

/** Accent- and case-insensitive comparison surface. Everything below matches on this. */
const normalize = (raw: string): string =>
  raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const IMPROVE = String.raw`(?:amelior\w*|optimis\w*|optimiz\w*|renforc\w*|improv\w*|harden\w*)`;
const SELF_LABEL = /\b(?:self[- ]improvement|self[- ]development|auto[- ]amelioration)\b/;
const IMPROVE_THEN_ICOS = new RegExp(String.raw`\b${IMPROVE}\b[^.;!?]{0,40}\bicos\b`);
const ICOS_THEN_IMPROVE = new RegExp(String.raw`\bicos\b[^.;!?]{0,40}\b${IMPROVE}\b`);

const CLIENT_WORD = /\bclients?\b/;

/* An anchor word is required: a bare "2 heures" in a sentence is not a time budget. */
const DURATION =
  /\b(?:pendant|durant|en|for|during|within)\s+(\d+(?:[.,]\d+)?)\s*(h|heures?|hrs?|hours?|min|mins|minutes?|jours?|days?)\b/;
const DURATION_UNIT_MINUTES: readonly { readonly match: RegExp; readonly minutes: number }[] = [
  { match: /^(?:h|heures?|hrs?|hours?)$/, minutes: 60 },
  { match: /^(?:min|mins|minutes?)$/, minutes: 1 },
  { match: /^(?:jours?|days?)$/, minutes: 1440 },
];

/*
 * The amount must hang off the word "budget": "la facture est de 10 EUR" is an observation
 * about the world, not a cap Geoffrey granted. Inventing a cap is as wrong as ignoring one.
 */
const BUDGET =
  /\bbudget\b[^.;!?]{0,40}?(?:(?<sym>€|\$)\s*(?<symAmount>\d+(?:[.,]\d+)?)|(?<amount>\d+(?:[.,]\d+)?)\s*(?<cur>€|eur(?:os?)?|\$|usd|dollars?))/;

const CURRENCIES: readonly { readonly match: RegExp; readonly currency: Currency }[] = [
  { match: /^(?:€|eur(?:os?)?)$/, currency: "EUR" },
  { match: /^(?:\$|usd|dollars?)$/, currency: "USD" },
];

/* Affirmative permission only. Any prohibition in the same objective overrides it. */
const DEPLOY_PERMITTED =
  /\b(?:deploiement (?:autorise|approuve|permis)|autorise(?:r)? le deploiement|tu peux deployer|je t'autorise a deployer|deployment (?:is )?(?:authorized|authorised|approved|allowed)|you (?:may|can) deploy)\b/;
const DEPLOY_FORBIDDEN =
  /\b(?:pas de deploiement|aucun deploiement|ne deploie(?:r|z)? pas|sans mon accord|no deploy\w*|do not deploy|don't deploy|without my approval)\b/;

const ESCALATION_PATTERNS: readonly { readonly kind: EscalationKind; readonly match: RegExp }[] = [
  { kind: "DEPLOYMENT", match: /\b(?:deploi\w*|deploy\w*|mise en production|prod|production)\b/ },
  {
    kind: "CREDENTIALS",
    match:
      /\b(?:credential\w*|identifiant\w*|secret\w*|api[- ]?key|cle api|token\w*|mot de passe|password)\b/,
  },
  {
    kind: "PERMISSIONS",
    match:
      /\b(?:permission\w*|privileg\w*|droits? d'acces|acces admin|admin access|grant\w*|role admin)\b/,
  },
  {
    kind: "POLICY_DISABLING",
    match:
      /\b(?:desactiv\w*|disabl\w*|bypass\w*|contourn\w*|skip the tests?|ignore the polic\w*|sans revue|without review)\b/,
  },
];

export function classifyRawObjective(
  raw: string,
  context: ClassificationContext = {},
): ClassifiedObjective {
  const text = normalize(raw);
  const evidence: string[] = [];

  /* --- work class -------------------------------------------------------- */
  const selfSignal =
    SELF_LABEL.test(text) || IMPROVE_THEN_ICOS.test(text) || ICOS_THEN_IMPROVE.test(text);
  const matchedClient = (context.knownClients ?? []).find((name) => {
    const needle = normalize(name);
    return needle !== "" && text.includes(needle);
  });
  const clientSignal = matchedClient !== undefined || CLIENT_WORD.test(text);

  let workClass: Maybe<WorkClass> = UNKNOWN;
  if (selfSignal && clientSignal) {
    evidence.push("work class UNKNOWN: AMBIGUOUS — self-improvement and client signals both read");
  } else if (selfSignal) {
    workClass = "SELF_IMPROVEMENT";
    evidence.push("work class SELF_IMPROVEMENT: improvement of ICOS stated");
  } else if (clientSignal) {
    workClass = "CLIENT";
    evidence.push(
      matchedClient !== undefined
        ? `work class CLIENT: known client "${matchedClient}" named`
        : "work class CLIENT: the word client is used",
    );
  } else {
    evidence.push("work class UNKNOWN: no signal read — not guessed");
  }

  /* --- duration ---------------------------------------------------------- */
  let durationMinutes: Maybe<number> = UNKNOWN;
  const duration = DURATION.exec(text);
  const unit = duration ? DURATION_UNIT_MINUTES.find((u) => u.match.test(duration[2])) : undefined;
  if (duration && unit) {
    durationMinutes = Number(duration[1].replace(",", ".")) * unit.minutes;
    evidence.push(`duration: "${duration[0]}" -> ${durationMinutes} min`);
  } else {
    evidence.push("duration not specified");
  }

  /* --- budget ------------------------------------------------------------ */
  let budget: Maybe<MoneyBound> = UNKNOWN;
  const money = BUDGET.exec(text)?.groups;
  const currencyToken = money?.sym ?? money?.cur;
  const currency = currencyToken
    ? CURRENCIES.find((c) => c.match.test(currencyToken))?.currency
    : undefined;
  if (money && currency) {
    budget = {
      amount: Number((money.symAmount ?? money.amount ?? "").replace(",", ".")),
      currency,
    };
    evidence.push(`budget: ${budget.amount} ${budget.currency}`);
  } else {
    evidence.push("budget not specified — UNKNOWN, which is neither unlimited nor zero");
  }

  /* --- prohibitions and escalations -------------------------------------- */
  const deploymentRequiresApproval = !(DEPLOY_PERMITTED.test(text) && !DEPLOY_FORBIDDEN.test(text));
  evidence.push(
    deploymentRequiresApproval
      ? "deployment requires approval (default, or stated)"
      : "deployment explicitly permitted by the objective",
  );

  const escalations = ESCALATION_PATTERNS.filter((p) => p.match.test(text)).map((p) => p.kind);
  if (escalations.length > 0) evidence.push(`escalations: ${escalations.join(", ")}`);

  return {
    raw,
    workClass,
    durationMinutes,
    budget,
    deploymentRequiresApproval,
    escalations,
    evidence,
  };
}
