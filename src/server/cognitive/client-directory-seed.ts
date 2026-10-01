import type { MemoryCandidate, WritebackOutcome } from "@/core/cognitive/contracts";

import type { EntityInput, PostgresCognitiveMemoryStore } from "./memory-store";

/**
 * MINIMUM TRUSTWORTHY CLIENT DIRECTORY (decision 0062).
 *
 * This file contains only what the repository actually establishes, with the path that
 * establishes it. Nothing here is inferred, rounded, or filled in to look complete.
 *
 * TRUSTED in this repository (used below):
 *  - the two clients exist and are the holding's clients — `src/app/business/clients/page.tsx`
 *    lists exactly them, each with its own route; decision 0056 names « LDS Renov » as the
 *    motivating case; `docs/architecture/business-domain-model.md` §Examples names both.
 *  - their canonical names and canonical identifiers (the route slugs, used consistently as
 *    ids across pages and docs).
 *
 * NOT TRUSTED, therefore NOT seeded (reported as missing instead of invented):
 *  - legal names, SIREN/RCS numbers, addresses, cities, domains, contacts: they appear ONLY
 *    inside blocks explicitly labelled « Example » in `docs/architecture/client-context-model.md`
 *    and are visibly placeholders (« 123 Rue de la République », « RCS Paris 123 456 789 »).
 *  - module enablement, autonomy levels, missions, automations, their statuses: the client
 *    pages hardcode them as UI fixtures (`src/app/business/clients/<slug>/page.tsx`) with no durable
 *    source. A fixture is not live state and must never be seeded as a fact.
 *  - « le client de Cannes » (an alias the product brief mentions): nothing in the repository
 *    ties either client to Cannes. It is NOT seeded; such a reference resolves to a
 *    clarification question, which is the correct answer.
 *
 * The seed is therefore deliberately thin: enough for « Où en est LDS ? » to resolve the right
 * entity and to answer honestly that there is no operational fact yet.
 */

/** The repository file that establishes which clients exist. */
export const SEED_SOURCE = "src/app/business/clients/page.tsx";

export interface SeedClient {
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  /**
   * Durable facts to record for this client. Each one must be true of the repository, not of
   * the business, and each carries `evidence` naming the file that establishes it.
   */
  readonly facts: readonly { subjectKey: string; content: string; evidence: string }[];
}

/**
 * Aliases are *declared* reference forms, not business facts: they say how a human may name this
 * client. Each one is either (a) a spelling of the canonical name (case, accents, apostrophes,
 * the definite article) or (b) a descriptive form listed here WITH its rationale. Nothing is
 * derived from guessed business knowledge.
 *
 * Deliberately NOT aliases: the bare common nouns « mécène » and « éditeur » without an article.
 * « Un mécène a financé le chantier » is ordinary French and must not move the context to a
 * client; only the determined forms (« le Mécène », « l'éditeur ») are treated as references.
 */
export const SEED_CLIENTS: readonly SeedClient[] = [
  {
    key: "lds-renov",
    name: "LDS Rénov'",
    aliases: ["lds", "lds renov", "lds rénov", "lds renov'", "lds rénov'"],
    facts: [
      {
        // Claims ONLY what the repository establishes: this client is listed in the ICOS client
        // directory and has this workspace route. NOT its operational status — the « Actif »
        // badge on the directory page is a hardcoded literal in the render, identical for every
        // row, so it says nothing about any individual client.
        subjectKey: "client.lds-renov.perimetre",
        content:
          "LDS Rénov' figure au répertoire clients ICOS ; son espace client est /business/clients/lds-renov.",
        evidence:
          "src/app/business/clients/page.tsx (répertoire) + src/app/business/clients/lds-renov/page.tsx (route)",
      },
    ],
  },
  {
    key: "editions-du-mecene",
    name: "Éditions du Mécène",
    aliases: [
      // Spellings of the canonical name.
      "le mecene",
      "le mécène",
      "du mecene",
      "du mécène",
      "editions du mecene",
      "éditions du mécène",
      "editions mecene",
      // Descriptive form, rationale: « Éditions » designates a publishing house, so « l'éditeur »
      // with the definite article can only mean this client among the two in the directory.
      // Reviewed and accepted as a DECLARED alias, not as a derived business fact.
      "l'éditeur",
      "l'editeur",
    ],
    facts: [
      {
        subjectKey: "client.editions-du-mecene.perimetre",
        content:
          "Les Éditions du Mécène figurent au répertoire clients ICOS ; leur espace client est /business/clients/editions-du-mecene.",
        evidence:
          "src/app/business/clients/page.tsx (répertoire) + src/app/business/clients/editions-du-mecene/page.tsx (route)",
      },
    ],
  },
];

/**
 * Business facts the brief asks for that the repository does NOT establish. Reported, never
 * invented. Anything listed here must come from the owner or a connected system before ICOS
 * can answer about it.
 */
export const MISSING_BUSINESS_DATA: readonly string[] = [
  "LDS Rénov' / Éditions du Mécène: legal entity, registration number, address, city, domains (only placeholder values exist, in example blocks)",
  "current objectives, constraints and priorities per client",
  "projects per client (no project is named anywhere durable)",
  "current missions, blockers, recent decisions and recent results (the client pages hardcode UI fixtures, not live state)",
  "module enablement and autonomy level per client (documented as examples only, contradicted between docs and pages for LDS: AUTONOMOUS vs AUTOMATED)",
  "operational status per client: the « Actif » badge on the client directory page is a hardcoded literal shown for every row, so no client's real status is recorded anywhere",
  "the alias « le client de Cannes »: no client is tied to Cannes anywhere in the repository",
];

export interface SeedReport {
  readonly entities: number;
  readonly facts: readonly { subjectKey: string; outcome: WritebackOutcome["kind"] }[];
  readonly missing: readonly string[];
}

/**
 * Idempotent seed. A client entity is scoped to ITSELF (`clientId = key`) so that one client's
 * entity never appears in another client's assembled context; it stays resolvable through
 * `clientDirectory`, which is the only scope-free read.
 *
 * Facts are written through the governed writeback path — no raw insert — as SYSTEM_OBSERVED
 * observations of the repository, so they rank below anything the owner later asserts and a
 * replay is a `duplicate`, not a second truth.
 */
export async function seedClientDirectory(
  memory: Pick<PostgresCognitiveMemoryStore, "upsertEntity" | "write">,
  tenantId: string,
  recordedBy = "system:seed",
): Promise<SeedReport> {
  const facts: { subjectKey: string; outcome: WritebackOutcome["kind"] }[] = [];
  let entities = 0;
  for (const client of SEED_CLIENTS) {
    const input: EntityInput = {
      kind: "client",
      key: client.key,
      name: client.name,
      clientId: client.key,
      aliases: client.aliases,
      sensitivity: "normal",
    };
    await memory.upsertEntity(tenantId, input);
    entities++;
    for (const fact of client.facts) {
      const candidate: MemoryCandidate = {
        type: "project",
        subjectKey: fact.subjectKey,
        content: fact.content,
        epistemic: "SYSTEM_OBSERVED",
        statementKind: "observation",
        confidence: 0.9,
        originTrust: "trusted",
        provenance: {
          sourceType: "system",
          sourceId: `seed:${fact.evidence}`,
          conversationId: null,
          turnId: null,
          engine: null,
        },
        entityKey: client.key,
        retention: "long_term",
        tags: ["seed", "client-directory"],
      };
      const outcome = await memory.write(
        { tenantId, userId: recordedBy, clientId: client.key, projectId: null },
        candidate,
      );
      facts.push({ subjectKey: fact.subjectKey, outcome: outcome.kind });
    }
  }
  return { entities, facts, missing: MISSING_BUSINESS_DATA };
}
