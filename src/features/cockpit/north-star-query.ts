import type { NorthStarPriority } from "@/core/north-star/tree";

/** Raw Next.js searchParams: a repeated key (`?q=a&q=b`) arrives as string[]. */
export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface NorthStarQuery {
  q: string;
  priority: NorthStarPriority | undefined;
  program: string | undefined;
}

/** Only a single string value is honoured; arrays and anything else are ignored. */
export function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isPriority(value: string | undefined): value is NorthStarPriority {
  return value === "P0" || value === "P1" || value === "P2";
}

/**
 * Normalises the North Star page query. Never throws: malformed, repeated or
 * unknown values degrade to "no filter" so the page always renders.
 */
export function parseNorthStarQuery(
  params: RawSearchParams,
  programIds: ReadonlySet<string>,
): NorthStarQuery {
  const q = one(params.q)?.trim() ?? "";
  const rawPriority = one(params.priority);
  const priority = isPriority(rawPriority) ? rawPriority : undefined;
  const rawProgram = one(params.program);
  const program = rawProgram && programIds.has(rawProgram) ? rawProgram : undefined;
  return { q, priority, program };
}

/** Builds the page href for a priority link while preserving q and program. */
export function northStarHref(query: NorthStarQuery, priority?: NorthStarPriority): string {
  const sp = new URLSearchParams();
  if (query.q) sp.set("q", query.q);
  if (priority) sp.set("priority", priority);
  if (query.program) sp.set("program", query.program);
  const qs = sp.toString();
  return `/cockpit/north-star${qs ? `?${qs}` : ""}`;
}
