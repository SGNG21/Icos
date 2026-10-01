import type { Sensitivity } from "./contracts";

/**
 * Client / project reference resolution — pure rules (decision 0062).
 *
 * Turns a human reference (« LDS », « le Mécène », « reviens à LDS », « ça », « continue »)
 * into the client/project scope the Cognitive Runtime must use for THIS turn. It grants no
 * authority: it only decides which scope a turn is read and written under, and it never
 * guesses — two plausible matches is an `ambiguous` result that asks a question.
 *
 * Precedence (strict: a tier that matched is never diluted by a weaker one):
 *   1 explicit canonical identifier   (`lds-renov`)
 *   2 exact canonical name            (« LDS Rénov' »)
 *   3 exact alias                     (« lds », « le mécène »)
 *   4 current conversation context    (« ça », « ce client », « ce projet »)
 *   5 recent durable context          (« continue ce qu'on faisait »)
 *   6 safe ambiguity                  (ask, never pick)
 */
export const RESOLUTION_POLICY_VERSION = "client-resolution-v1";

/** One directory row: that a client/project exists, its name and its aliases. No facts. */
export interface DirectoryEntry {
  readonly kind: "client" | "project";
  /** Canonical identifier. For a project, `clientId` says whose it is. */
  readonly key: string;
  readonly name: string;
  readonly aliases: readonly string[];
  /** For a project: its owning client. For a client: its own key. */
  readonly clientId: string | null;
  readonly sensitivity: Sensitivity;
}

export const RESOLUTION_SOURCES = [
  "canonical_id",
  "canonical_name",
  "alias",
  "current_context",
  "previous_context",
  "recent_context",
  "none",
] as const;
export type ResolutionSource = (typeof RESOLUTION_SOURCES)[number];

export interface ResolvedScope {
  readonly clientId: string | null;
  readonly projectId: string | null;
}

export type AmbiguityReason =
  | "multiple_matches"
  | "no_current_context"
  | "no_previous_context"
  | "unknown_reference"
  | "project_without_client";

export type ContextResolution =
  | {
      readonly kind: "resolved";
      readonly clientId: string | null;
      readonly projectId: string | null;
      readonly source: ResolutionSource;
      /** The directory key that matched, when a reference (not a pointer) resolved it. */
      readonly entityKey: string | null;
      readonly matched: string | null;
    }
  /** Nothing in the turn refers to a client or a project: keep the conversation's scope. */
  | {
      readonly kind: "unchanged";
      readonly clientId: string | null;
      readonly projectId: string | null;
    }
  /** Fail safe: ask. Never launch, never write guessed memory, never pick a side. */
  | {
      readonly kind: "ambiguous";
      readonly question: string;
      readonly candidates: readonly string[];
      readonly reason: AmbiguityReason;
    };

export interface ResolutionInput {
  readonly text: string;
  readonly directory: readonly DirectoryEntry[];
  /** The conversation's current pointer. */
  readonly current: ResolvedScope;
  /** The scope the conversation was on before its last switch. */
  readonly previous: ResolvedScope;
  /**
   * Most recent durable scope for this user outside this conversation. Tier 5 only.
   */
  readonly recent?: ResolvedScope;
  /** Highest sensitivity the actor may resolve against. `restricted` is never resolvable. */
  readonly maxSensitivity: Sensitivity;
}

// ── normalisation ────────────────────────────────────────────────────────────
/**
 * Fold to comparable form: lowercase, no diacritics, punctuation becomes a separator.
 * « Éditions du Mécène » → "editions du mecene" ; « LDS Rénov' » → "lds renov".
 */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True when `needle` occurs in `haystack` on whole-word boundaries (both folded). */
function containsPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/** The identifier as written, on boundaries that are not part of an identifier. */
function containsIdentifier(haystack: string, key: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(key, from);
    if (at < 0) return false;
    const before = haystack[at - 1];
    const after = haystack[at + key.length];
    const boundary = (c: string | undefined) => c === undefined || !/[a-z0-9_-]/.test(c);
    if (boundary(before) && boundary(after)) return true;
    from = at + 1;
  }
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, restricted: 2 };

// ── referential intent ───────────────────────────────────────────────────────
const RETURN_RE = /\b(reviens|revenons|revenir|retournons)\b/;
const CONTINUE_RE =
  /\b(continue|continuons|continuer|reprends|reprenons|reprendre|poursuis|poursuivons)\b/;
/**
 * STRONG deictic: these words can only designate a business object, so with no active scope the
 * only safe answer is a question.
 */
const DEICTIC_RE = /\b(ce client|cette cliente|ce projet|ce dossier|ce compte|cette mission)\b/;
/**
 * WEAK deictic (bare pronoun): « occupe-toi de ça » means the active scope, but « ça va ? » and
 * « j'ai fait ça hier » are ordinary French. It therefore reads the current pointer when there is
 * one and is NOT a reference otherwise — asking « de quel client parlez-vous ? » on every
 * sentence containing « ça » would make unscoped conversations unusable. Nothing is guessed:
 * with no pointer the turn simply stays unscoped, so no client knowledge enters the prompt.
 */
const WEAK_DEICTIC_RE = /\b(ca|cela|dessus)\b/;
/**
 * A *qualified* descriptive reference — « le client de Cannes », « le projet du Mécène ».
 * If the qualifier matched no directory entry we must ask; a plural or unqualified mention
 * (« nos clients », « côté projet ») is not a reference and must not trigger a question.
 */
const DESCRIPTIVE_RE =
  /\b(?:le|la|du|de la|notre|chez|pour) (?:client|cliente|projet|dossier|compte) (?:de |du |d |des |a |chez )?([a-z0-9]{3,})/;

export type ReferentialIntent =
  "named" | "return" | "continue" | "deictic" | "weak_deictic" | "descriptive" | "none";

export function intentOf(foldedText: string): ReferentialIntent {
  if (RETURN_RE.test(foldedText)) return "return";
  if (DEICTIC_RE.test(foldedText)) return "deictic";
  if (CONTINUE_RE.test(foldedText)) return "continue";
  if (DESCRIPTIVE_RE.test(foldedText)) return "descriptive";
  if (WEAK_DEICTIC_RE.test(foldedText)) return "weak_deictic";
  return "none";
}

// ── matching ─────────────────────────────────────────────────────────────────
interface Match {
  readonly entry: DirectoryEntry;
  /** Folded text that matched; its length is the specificity of the match. */
  readonly matched: string;
}

/** Best (longest) match per entity, strongest first, ties broken by key. */
function bestPerEntity(matches: readonly Match[]): Match[] {
  const best = new Map<string, Match>();
  for (const m of matches) {
    const kept = best.get(m.entry.key);
    if (!kept || m.matched.length > kept.matched.length) best.set(m.entry.key, m);
  }
  return [...best.values()].sort(
    (a, b) => b.matched.length - a.matched.length || (a.entry.key < b.entry.key ? -1 : 1),
  );
}

function scopeOf(entry: DirectoryEntry): ResolvedScope | null {
  if (entry.kind === "client") return { clientId: entry.key, projectId: null };
  // `project_id is not null and client_id is null` is forbidden by the durable model:
  // a project with no owning client is not a usable scope. Fail closed.
  if (!entry.clientId) return null;
  return { clientId: entry.clientId, projectId: entry.key };
}

const ask = (
  candidates: readonly DirectoryEntry[],
  reason: AmbiguityReason,
  question: string,
): ContextResolution => ({
  kind: "ambiguous",
  question,
  candidates: [...new Set(candidates.map((c) => c.name))].sort(),
  reason,
});

function unknownReference(visible: readonly DirectoryEntry[]): ContextResolution {
  const clients = visible.filter((e) => e.kind === "client");
  return ask(
    clients,
    "unknown_reference",
    clients.length
      ? `Je ne reconnais pas ce périmètre. Clients connus : ${clients
          .map((c) => c.name)
          .sort()
          .join(", ")}. Lequel ?`
      : "Je ne reconnais pas ce périmètre et aucun client n'est enregistré.",
  );
}

/** Resolve the scope for one turn. Pure: no clock, no I/O, deterministic. */
export function resolveReference(input: ResolutionInput): ContextResolution {
  const text = fold(input.text);
  // The canonical identifier is matched as WRITTEN (`lds-renov`), not folded, so tier 1 means
  // "the human gave the id" and not "the id happens to look like the name".
  const rawText = input.text.toLowerCase();
  const visible = input.directory.filter(
    (e) =>
      // `restricted` is never resolvable, whatever the actor's ceiling: it must not reach a prompt.
      e.sensitivity !== "restricted" &&
      SENSITIVITY_RANK[e.sensitivity] <= SENSITIVITY_RANK[input.maxSensitivity],
  );

  const tiers: readonly (readonly [ResolutionSource, Match[]])[] = [
    [
      "canonical_id",
      visible
        .filter((e) => containsIdentifier(rawText, e.key.toLowerCase()))
        .map((e) => ({ entry: e, matched: e.key })),
    ],
    [
      "canonical_name",
      visible
        .filter((e) => containsPhrase(text, fold(e.name)))
        .map((e) => ({ entry: e, matched: fold(e.name) })),
    ],
    [
      "alias",
      visible.flatMap((e) =>
        e.aliases
          .map(fold)
          .filter((a) => containsPhrase(text, a))
          .map((a) => ({ entry: e, matched: a })),
      ),
    ],
  ];

  for (const [source, raw] of tiers) {
    if (!raw.length) continue;
    const matches = bestPerEntity(raw);
    // Two entities whose best match is equally specific are equally plausible: ask.
    if (matches.length > 1 && matches[1].matched.length >= matches[0].matched.length) {
      return ask(
        matches.map((m) => m.entry),
        "multiple_matches",
        `Deux périmètres correspondent : ${matches
          .map((m) => m.entry.name)
          .sort()
          .join(" ou ")} ? Précisez lequel.`,
      );
    }
    const winner = matches[0];
    let scope = scopeOf(winner.entry);
    // Naming the client we are already on CONFIRMS the scope; it must not silently drop the
    // project we are inside (« où en est LDS ? » while on LDS/projet P stays on P).
    if (
      scope &&
      winner.entry.kind === "client" &&
      scope.clientId === input.current.clientId &&
      input.current.projectId !== null
    ) {
      scope = input.current;
    }
    if (!scope) {
      return ask(
        visible.filter((e) => e.kind === "client"),
        "project_without_client",
        `Le projet « ${winner.entry.name} » n'est rattaché à aucun client : impossible de résoudre le périmètre.`,
      );
    }
    return {
      kind: "resolved",
      ...scope,
      source,
      entityKey: winner.entry.key,
      matched: winner.matched,
    };
  }

  // No name matched. The referential intent decides which durable pointer to read.
  const intent = intentOf(text);
  const clients = visible.filter((e) => e.kind === "client");
  /**
   * A pointer is only ADOPTED if its client is still resolvable by this actor: a client that
   * became `sensitive` or `restricted` must not be re-entered through « reviens » or
   * « continue » by someone who can no longer resolve it by name.
   */
  const adoptable = (scope: ResolvedScope) =>
    scope.clientId !== null && clients.some((c) => c.key === scope.clientId);

  if (intent === "return") {
    if (adoptable(input.previous)) {
      return {
        kind: "resolved",
        ...input.previous,
        source: "previous_context",
        entityKey: null,
        matched: null,
      };
    }
    return ask(
      clients,
      "no_previous_context",
      "Revenir à quel client ? Aucun périmètre précédent n'est enregistré.",
    );
  }

  if (intent === "deictic" || intent === "continue" || intent === "weak_deictic") {
    if (input.current.clientId !== null) {
      return {
        kind: "resolved",
        ...input.current,
        source: "current_context",
        entityKey: null,
        matched: null,
      };
    }
    if (intent === "continue" && input.recent && adoptable(input.recent)) {
      return {
        kind: "resolved",
        ...input.recent,
        source: "recent_context",
        entityKey: null,
        matched: null,
      };
    }
    // A bare pronoun with no active scope is not a reference: stay unscoped rather than
    // interrogate the user about every « ça ».
    if (intent === "weak_deictic") {
      return { kind: "unchanged", clientId: null, projectId: null };
    }
    return ask(
      clients,
      "no_current_context",
      "De quel client ou projet parlez-vous ? Aucun périmètre n'est actif.",
    );
  }

  // « le client de Cannes » — a qualified reference whose qualifier matched nothing.
  if (intent === "descriptive") return unknownReference(visible);

  return {
    kind: "unchanged",
    clientId: input.current.clientId,
    projectId: input.current.projectId,
  };
}

/** True when the resolution asks the runtime to move the conversation's pointer. */
export function isScopeChange(resolution: ContextResolution, current: ResolvedScope): boolean {
  return (
    resolution.kind === "resolved" &&
    (resolution.clientId !== current.clientId || resolution.projectId !== current.projectId)
  );
}
