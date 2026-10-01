import type {
  CognitiveScope,
  ContextExclusion,
  ContextItem,
  ContextItemKind,
  Epistemic,
  MemoryRecord,
  OriginTrust,
  Sensitivity,
} from "./contracts";

/**
 * Deterministic context selection (decision 0056). Pure: same candidates + same scope +
 * same policy + same `now` ⇒ same selection, in the same order.
 *
 * Never "dump all memory": an item enters the prompt only if it passes policy AND is
 * relevant (keyword/entity overlap with the turn, or anchored to the conversation scope).
 */
export const CONTEXT_POLICY_VERSION = "cognitive-context-v1";

export type ContextStage =
  | "runtime"
  | "current"
  | "goals"
  | "entities"
  | "episodic"
  | "semantic"
  | "decisions"
  | "procedures";

/**
 * The two "now" stages outrank remembered material, for the same reason and at
 * different strengths.
 *
 * `runtime` (0.9) is what the SYSTEM is right now — which capabilities are
 * connected, what policy requires (decision 0062). A recalled sentence in which
 * ICOS once described itself is episodic history at 0.2 and can never outweigh
 * it, so stale self-description cannot be mistaken for current truth.
 *
 * `current` (0.6) is what the resolved client's WORK is right now, read live from
 * CORE3 (decision 0063). It sits just above `goals` so a live mission reading
 * leads the prompt, and below `runtime` because a claim about one mission must
 * never displace what the runtime itself can and cannot do. Subject-level
 * supersession is handled separately by `applyTemporalPrecedence`.
 */
const STAGE_WEIGHT: Record<ContextStage, number> = {
  runtime: 0.9,
  current: 0.6,
  goals: 0.5,
  entities: 0.4,
  decisions: 0.35,
  semantic: 0.3,
  procedures: 0.25,
  episodic: 0.2,
};

export interface ContextCandidate {
  readonly stage: ContextStage;
  readonly kind: ContextItemKind;
  readonly ref: string;
  readonly text: string;
  /** Tied to the conversation scope itself (its client/project entity, the last turns). */
  readonly anchored: boolean;
  readonly entityIds: readonly string[];
  readonly occurredAt: string;
  readonly confidence: number;
  readonly epistemic: Epistemic | null;
  readonly trust: OriginTrust;
  /**
   * What this item makes a claim ABOUT (e.g. `mission:m_42`). Two items sharing a subject
   * are two statements about the same thing, settled by `applyTemporalPrecedence`.
   */
  readonly subject?: string;
  /** True for a reading of CURRENT state (live runtime/CORE3), not a remembered claim. */
  readonly live?: boolean;
}

export interface SelectionPolicy {
  readonly tokenBudget: number;
  readonly maxSensitivity: Sensitivity;
}

const STOPWORDS = new Set(
  (
    "les des une pour que qui dans par sur avec pas est sont aux ces ses son sa leur leurs " +
    "mais ou donc car nous vous ils elles cette cela etre avoir fait faire plus moins tout " +
    "the and for that this with are was were from have has not but you your our can will"
  ).split(" "),
);

export function tokenize(s: string): Set<string> {
  return new Set(
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

const DAY_MS = 86_400_000;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

export function scoreCandidate(
  c: ContextCandidate,
  query: ReadonlySet<string>,
  focusEntityIds: ReadonlySet<string>,
  now: Date,
): { score: number; relevant: boolean; reason: string } {
  const itemTokens = tokenize(c.text);
  let hits = 0;
  for (const t of query) if (itemTokens.has(t)) hits++;
  const overlap = query.size ? Math.min(1, hits / Math.min(query.size, 5)) : 0;
  const entityHit = c.entityIds.some((e) => focusEntityIds.has(e));
  const ageDays = Math.max(0, (now.getTime() - new Date(c.occurredAt).getTime()) / DAY_MS);
  const recency = Math.pow(0.5, ageDays / 30);
  const authority = c.epistemic === "USER_ASSERTED" || c.epistemic === "TOOL_CONFIRMED" ? 0.05 : 0;
  const score = round4(
    STAGE_WEIGHT[c.stage] +
      0.5 * overlap +
      (c.anchored ? 0.3 : 0) +
      (entityHit ? 0.2 : 0) +
      0.1 * c.confidence +
      0.1 * recency +
      authority,
  );
  const reasons = [
    c.live && "current_state",
    c.anchored && "scope",
    hits > 0 && `keywords:${hits}`,
    entityHit && "entity",
  ].filter(Boolean);
  return { score, relevant: reasons.length > 0, reason: reasons.join("+") || "none" };
}

/**
 * TEMPORAL PRECEDENCE: current state outranks remembered state (decision 0063).
 *
 * When a live reading and a durable memory speak about the SAME subject, the memory is
 * dropped from the prompt with reason `stale` — a completed mission can never be presented
 * as running because an older turn said so. The memory row is untouched and still
 * readable as history; it simply does not enter this turn's context.
 *
 * Two live readings of one subject, or two memories with no live reading, are left alone.
 */
export function applyTemporalPrecedence(candidates: readonly ContextCandidate[]): {
  kept: ContextCandidate[];
  stale: ContextExclusion[];
} {
  const liveSubjects = new Set(
    candidates.filter((c) => c.live && c.subject).map((c) => c.subject as string),
  );
  if (!liveSubjects.size) return { kept: [...candidates], stale: [] };
  const kept: ContextCandidate[] = [];
  const stale: ContextExclusion[] = [];
  for (const c of candidates) {
    if (!c.live && c.subject && liveSubjects.has(c.subject))
      stale.push({ ref: c.ref, reason: "stale" });
    else kept.push(c);
  }
  return { kept, stale };
}

/** Rank, gate on relevance, trim to budget. Ties broken by ref: fully deterministic. */
export function selectContext(
  candidates: readonly ContextCandidate[],
  turnText: string,
  focusEntityIds: ReadonlySet<string>,
  policy: SelectionPolicy,
  now: Date,
): { items: ContextItem[]; excluded: ContextExclusion[]; tokensUsed: number } {
  const query = tokenize(turnText);
  const precedence = applyTemporalPrecedence(candidates);
  const excluded: ContextExclusion[] = [...precedence.stale];
  const seen = new Set<string>();
  const scored = [];
  for (const c of precedence.kept) {
    if (seen.has(c.ref)) continue;
    seen.add(c.ref);
    const s = scoreCandidate(c, query, focusEntityIds, now);
    if (!s.relevant) excluded.push({ ref: c.ref, reason: "irrelevant" });
    else scored.push({ c, ...s });
  }
  scored.sort((a, b) => b.score - a.score || (a.c.ref < b.c.ref ? -1 : a.c.ref > b.c.ref ? 1 : 0));

  const items: ContextItem[] = [];
  let used = 0;
  for (const { c, score, reason } of scored) {
    const tokens = estimateTokens(c.text);
    if (used + tokens > policy.tokenBudget) {
      excluded.push({ ref: c.ref, reason: "budget" });
      continue;
    }
    used += tokens;
    items.push({
      ref: c.ref,
      kind: c.kind,
      stage: c.stage,
      text: c.text,
      score,
      tokens,
      epistemic: c.epistemic,
      trust: c.trust,
      reason,
    });
  }
  excluded.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return { items, excluded, tokensUsed: used };
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = { normal: 0, sensitive: 1, restricted: 2 };

/**
 * Memory isolation policy — TS mirror of the SQL scope predicate (defence in depth):
 * the store already filters by tenant/client/project/owner; this re-checks every row
 * that reaches the assembler and records WHY a row was excluded.
 */
export function memoryExclusion(
  r: Pick<
    MemoryRecord,
    | "tenantId"
    | "clientId"
    | "projectId"
    | "ownerUserId"
    | "status"
    | "sensitivity"
    | "expiresAt"
    | "validUntil"
  >,
  scope: CognitiveScope,
  maxSensitivity: Sensitivity,
  now: Date,
): ContextExclusion["reason"] | null {
  if (r.tenantId !== scope.tenantId) return "tenant_scope";
  if (r.clientId !== null && r.clientId !== scope.clientId) return "client_scope";
  if (r.projectId !== null && r.projectId !== scope.projectId) return "project_scope";
  if (r.ownerUserId !== null && r.ownerUserId !== scope.userId) return "user_scope";
  if (r.status !== "active") return "inactive";
  const t = now.getTime();
  if (
    (r.expiresAt && new Date(r.expiresAt).getTime() <= t) ||
    (r.validUntil && new Date(r.validUntil).getTime() <= t)
  ) {
    return "expired";
  }
  if (SENSITIVITY_RANK[r.sensitivity] > SENSITIVITY_RANK[maxSensitivity]) return "sensitivity";
  return null;
}

/** Roles → highest sensitivity allowed into a model prompt. `restricted` never is. */
export function maxSensitivityFor(roles: readonly string[]): Sensitivity {
  return roles.some((r) => r === "owner" || r === "admin" || r === "operator")
    ? "sensitive"
    : "normal";
}
