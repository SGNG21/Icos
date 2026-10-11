import { createHash } from "node:crypto";

import type {
  CognitiveMemoryType,
  MemoryCandidate,
  WritebackOutcome,
} from "@/core/cognitive/contracts";
import { normalizeContent } from "@/core/cognitive/writeback-rules";

import type { EntityInput, PostgresCognitiveMemoryStore } from "./memory-store";

/**
 * MINIMUM TRUSTWORTHY CLIENT DIRECTORY (decision 0063).
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
 *
 * OWNER-STATED (decision 0063, amendment A): facts the OWNER gave in writing are a second,
 * separate source. They are not repository facts and are never presented as such: each one is
 * recorded with `sourceId: owner-statement:<date>` and its content says who stated it and when.
 * They are SYSTEM_OBSERVED (ICOS transcribed them; `USER_ASSERTED` is reserved by the writeback
 * rules for an authenticated human writing through the API), so anything the owner later
 * asserts through the API outranks and supersedes them.
 *  - owner statement 2026-10-11: LDS Rénov' is a renovation company in Cannes and its website
 *    is lds-renov.fr. This is what makes « le client rénovation Cannes », « le client de
 *    Cannes » and « lds-renov.fr » resolvable — previously a clarification, by design, because
 *    nothing established them.
 *
 * The seed is therefore deliberately thin: enough to resolve the right entity and to answer
 * honestly about what is and is not known.
 */

/** Provenance of everything the owner stated on 2026-10-11 (P0 autonomy unblock). */
export const OWNER_STATEMENT_2026_10_11 = "owner-statement:2026-10-11";

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
  readonly facts: readonly SeedFact[];
}

export interface SeedFact {
  readonly subjectKey: string;
  readonly content: string;
  /**
   * WHERE the fact comes from: a repository path (`repository`) or a dated owner statement
   * (`owner`, `evidence` = the statement's provenance id). Never both, never neither.
   */
  readonly source: "repository" | "owner";
  readonly evidence: string;
  /** Memory type; defaults to `project` (the directory membership observation). */
  readonly type?: Extract<CognitiveMemoryType, "project" | "semantic">;
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
    aliases: [
      // Spellings of the canonical name.
      "lds",
      "lds renov",
      "lds rénov",
      "lds renov'",
      "lds rénov'",
      // Domain aliases — owner statement 2026-10-11: « son site internet est lds-renov.fr ».
      "lds-renov.fr",
      "www.lds-renov.fr",
      // Declared descriptors — owner statement 2026-10-11: « client rénovation à Cannes ».
      // Traits, not names: they only resolve a descriptive reference with a reference noun
      // (« le client rénovation Cannes », « le client de Cannes »), and only while no other
      // client fits as well.
      "desc:rénovation",
      "desc:cannes",
    ],
    facts: [
      {
        // Claims ONLY what the repository establishes: this client is listed in the ICOS client
        // directory and has this workspace route. NOT its operational status — the « Actif »
        // badge on the directory page is a hardcoded literal in the render, identical for every
        // row, so it says nothing about any individual client.
        subjectKey: "client.lds-renov.perimetre",
        content:
          "LDS Rénov' figure au répertoire clients ICOS ; son espace client est /business/clients/lds-renov.",
        source: "repository",
        evidence:
          "src/app/business/clients/page.tsx (répertoire) + src/app/business/clients/lds-renov/page.tsx (route)",
      },
      {
        subjectKey: "client.lds-renov.activite",
        type: "semantic",
        content:
          "LDS Rénov' est une entreprise de rénovation basée à Cannes (déclaration du propriétaire du 2026-10-11).",
        source: "owner",
        evidence: OWNER_STATEMENT_2026_10_11,
      },
      {
        subjectKey: "client.lds-renov.site-internet",
        type: "semantic",
        content:
          "Le site internet de LDS Rénov' est lds-renov.fr (déclaration du propriétaire du 2026-10-11).",
        source: "owner",
        evidence: OWNER_STATEMENT_2026_10_11,
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
        source: "repository",
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
  "LDS Rénov' / Éditions du Mécène: legal entity, registration number, street address (only placeholder values exist, in example blocks)",
  "Éditions du Mécène: city and website (LDS Rénov' city and website come from the owner statement of 2026-10-11)",
  "current objectives, constraints and priorities per client",
  "projects per client (no project is named anywhere durable)",
  "current missions, blockers, recent decisions and recent results (the client pages hardcode UI fixtures, not live state)",
  "module enablement and autonomy level per client (documented as examples only, contradicted between docs and pages for LDS: AUTONOMOUS vs AUTOMATED)",
  "operational status per client: the « Actif » badge on the client directory page is a hardcoded literal shown for every row, so no client's real status is recorded anywhere",
];

export interface SeedReport {
  readonly entities: number;
  /**
   * `kept`: the subject was already recorded in this scope with other content or status — an
   * owner edit, a retraction, a supersession — and the seed left it alone.
   */
  readonly facts: readonly { subjectKey: string; outcome: WritebackOutcome["kind"] | "kept" }[];
  readonly missing: readonly string[];
}

/**
 * Idempotent seed, safe at EVERY production boot. A client entity is scoped to ITSELF
 * (`clientId = key`) so that one client's entity never appears in another client's assembled
 * context; it stays resolvable through `clientDirectory`, which is the only scope-free read.
 *
 * NEVER UNDOES AN OWNER EDIT:
 *  - an existing entity keeps its name, sensitivity and every alias; it only gains the seed's
 *    aliases it does not hold yet (`mergeAliases`);
 *  - a fact is written only if its subject has NEVER been recorded in that scope. A subject
 *    the owner superseded, retracted or deleted is reported `kept` and not written back.
 *
 * Facts go through the governed writeback path — no raw insert — as SYSTEM_OBSERVED
 * observations, so they rank below anything the owner asserts through the API.
 */
export async function seedClientDirectory(
  memory: Pick<PostgresCognitiveMemoryStore, "upsertEntity" | "write" | "subjectRecorded">,
  tenantId: string,
  recordedBy = "system:seed",
): Promise<SeedReport> {
  const facts: { subjectKey: string; outcome: WritebackOutcome["kind"] | "kept" }[] = [];
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
    /*
     * Review L3: merging the seed's aliases on EVERY boot re-added any alias the owner had
     * deleted. Each alias SET is merged once: a content-addressed marker, written through the
     * same governed path, records that this exact set was applied. Once recorded, the entity's
     * aliases are the owner's — the seed leaves them alone. A later release with a CHANGED set
     * merges once more (limit: an alias the owner deleted returns only if that new set lists it).
     */
    const aliasSet = [...client.aliases].sort();
    const aliasMarker = `seed.client-directory.${client.key}.aliases.${createHash("sha256")
      .update(JSON.stringify(aliasSet))
      .digest("hex")
      .slice(0, 16)}`;
    const aliasesApplied =
      (await memory.subjectRecorded(tenantId, client.key, "project", aliasMarker)).length > 0;
    await memory.upsertEntity(tenantId, aliasesApplied ? { ...input, aliases: [] } : input, {
      mergeAliases: true,
    });
    if (!aliasesApplied) {
      await memory.write(
        { tenantId, userId: recordedBy, clientId: client.key, projectId: null },
        {
          type: "project",
          subjectKey: aliasMarker,
          content: `Alias de l'annuaire appliqués par l'amorçage : ${aliasSet.join(", ")}.`,
          epistemic: "SYSTEM_OBSERVED",
          statementKind: "observation",
          confidence: 1,
          originTrust: "trusted",
          provenance: {
            sourceType: "system",
            sourceId: "seed:client-directory-aliases",
            conversationId: null,
            turnId: null,
            engine: null,
          },
          entityKey: client.key,
          retention: "long_term",
          tags: ["seed", "client-directory", "alias-set"],
        },
      );
    }
    entities++;
    for (const fact of client.facts) {
      const type = fact.type ?? "project";
      const prior = await memory.subjectRecorded(tenantId, client.key, type, fact.subjectKey);
      if (prior.length) {
        const same = prior.some(
          (r) =>
            r.status === "active" && normalizeContent(r.content) === normalizeContent(fact.content),
        );
        facts.push({ subjectKey: fact.subjectKey, outcome: same ? "duplicate" : "kept" });
        continue;
      }
      const candidate: MemoryCandidate = {
        type,
        subjectKey: fact.subjectKey,
        content: fact.content,
        epistemic: "SYSTEM_OBSERVED",
        statementKind: fact.source === "owner" ? "fact" : "observation",
        confidence: fact.source === "owner" ? 1 : 0.9,
        originTrust: "trusted",
        provenance: {
          sourceType: "system",
          sourceId: fact.source === "owner" ? fact.evidence : `seed:${fact.evidence}`,
          conversationId: null,
          turnId: null,
          engine: null,
        },
        entityKey: client.key,
        retention: "long_term",
        tags:
          fact.source === "owner"
            ? ["seed", "client-directory", "owner-statement"]
            : ["seed", "client-directory"],
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

/**
 * PRODUCTION BOOT (P0 2026-10-11). The directory used to be written ONLY by a manual script,
 * so a deployment nobody ran it against had an empty directory and every client reference —
 * « ce dossier LDS Rénov » included — fell through to « De quel client parlez-vous ? ».
 *
 * Runs through the same governed store as everything else, and is safe on every boot and on
 * every replica: entity creation is insert-if-absent on the unique key, alias merge only
 * appends, and a fact is written only if its subject was never recorded (see
 * `seedClientDirectory`). A failure is LOGGED and does not abort startup: an unseeded
 * directory degrades to clarification questions, which is survivable; refusing to boot the
 * whole runtime over it is not.
 */
export async function seedClientDirectoryAtStartup(
  memory: Pick<PostgresCognitiveMemoryStore, "upsertEntity" | "write" | "subjectRecorded">,
  tenantId: string,
  /* `warn`, like COMPUTE_BOOTSTRAP: debug levels are banned from shipped source, and this
     boot summary holds counts and subject keys only — never a fact's content. */
  log: (line: string) => void = (line) => console.warn(line),
): Promise<SeedReport | null> {
  try {
    const report = await seedClientDirectory(memory, tenantId, "system:boot-seed");
    log(
      JSON.stringify({
        event: "CLIENT_DIRECTORY_SEEDED",
        tenantId,
        entities: report.entities,
        facts: report.facts,
      }),
    );
    return report;
  } catch (error) {
    log(
      JSON.stringify({
        event: "CLIENT_DIRECTORY_SEED_FAILED",
        tenantId,
        error: `${error instanceof Error ? error.name : "Error"}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      }),
    );
    return null;
  }
}
