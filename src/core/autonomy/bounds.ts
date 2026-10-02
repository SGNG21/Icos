import { z } from "zod";

/**
 * Configurable runtime bounds for ONE autonomous mission.
 *
 * These four values are already durable columns on
 * `autonomous_mission_runtime` (max_cycles / max_replans / max_runtime_ms /
 * max_stagnation_cycles). This module is NOT a second runtime authority: it is
 * the single place that turns a caller's *requested* bounds into the options
 * the canonical `AutonomousMissionRunner` is constructed with, and the single
 * place that holds the policy ceiling the runner used to hardcode twice.
 *
 * Invariant — a request may only ever NARROW. Asking for more than the ceiling
 * is clamped down to the ceiling and the clamp is reported, never granted.
 */
export interface RuntimeBounds {
  maxCycles: number;
  maxRuntimeMs: number;
  maxStagnationCycles: number;
  maxReplans: number;
}

export type RuntimeBoundsField = keyof RuntimeBounds;

/*
 * Lower bounds mirror the durable CHECK constraints in
 * src/server/database/schema.ts. A value this schema accepts is always
 * persistable; a value it rejects is refused here rather than coerced into
 * something the database would reject later.
 */
export const requestedBoundsSchema = z
  .object({
    maxCycles: z.number().int().min(1).optional(),
    maxRuntimeMs: z.number().int().min(1).optional(),
    maxStagnationCycles: z.number().int().min(1).optional(),
    maxReplans: z.number().int().min(0).optional(),
  })
  .strict();

/**
 * Every field is OPTIONAL. An absent field resolves to the ceiling value,
 * which is exactly the behaviour callers got before bounds were requestable.
 */
export type RequestedBounds = z.infer<typeof requestedBoundsSchema>;

/**
 * The policy ceiling: the values that used to be hardcoded in
 * `start-autonomous-mission.ts` and again in `autonomous-mission-runner.ts`.
 * This const is now the only copy.
 */
export const AUTONOMY_BOUNDS_CEILING: RuntimeBounds = Object.freeze({
  maxCycles: 100,
  maxRuntimeMs: 60 * 60 * 1000,
  maxStagnationCycles: 3,
  maxReplans: 5,
});

export interface ResolvedBounds {
  bounds: RuntimeBounds;

  /** Fields whose requested value exceeded the ceiling and was reduced to it. */
  clamped: RuntimeBoundsField[];
}

const BOUNDS_FIELDS: RuntimeBoundsField[] = [
  "maxCycles",
  "maxRuntimeMs",
  "maxStagnationCycles",
  "maxReplans",
];

const ceilingSchema = requestedBoundsSchema.required();

/**
 * Resolves a caller's requested bounds against a policy ceiling.
 *
 * - absent request / absent field  -> the ceiling value;
 * - requested value <= ceiling     -> granted as requested;
 * - requested value >  ceiling     -> clamped to the ceiling and listed in
 *   `clamped` so the widening attempt is never silently granted;
 * - 0 / negative / NaN / Infinity / non-integer / unknown field -> throws.
 */
export function resolveBounds(
  requested?: unknown,
  ceiling: RuntimeBounds = AUTONOMY_BOUNDS_CEILING,
): ResolvedBounds {
  const validCeiling = ceilingSchema.safeParse(ceiling);

  if (!validCeiling.success) {
    throw new Error(`AUTONOMY_BOUNDS_CEILING_INVALID:${issues(validCeiling.error)}`);
  }

  const parsed = requestedBoundsSchema.safeParse(requested ?? {});

  if (!parsed.success) {
    throw new Error(`AUTONOMY_BOUNDS_INVALID:${issues(parsed.error)}`);
  }

  const bounds: RuntimeBounds = { ...validCeiling.data };
  const clamped: RuntimeBoundsField[] = [];

  for (const field of BOUNDS_FIELDS) {
    const value = parsed.data[field];

    if (value === undefined) {
      continue;
    }

    if (value > bounds[field]) {
      clamped.push(field);

      continue;
    }

    bounds[field] = value;
  }

  return { bounds, clamped };
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
    .join("; ");
}
