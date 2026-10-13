/**
 * AN OMNIROUTE META-ROUTE IS NOT A MODEL (decision 0078 §3).
 *
 * OmniRoute exposes `auto/*` combos (`auto/best-free`, `auto/coding:free`, ...) next to real
 * model ids. The model a combo serves is chosen by the gateway at call time, not by ICOS, and
 * it can be a paid model: measured on 2026-10-14, `auto/best-free` served `claude-opus-5`.
 * Anywhere ICOS names ONE model — fleet candidates, the system allowlist, a goal's allowlist,
 * the reviewer and the planner — a combo would attribute history, independence and price to
 * whatever the gateway picked that day.
 *
 * THE RULE, exactly: an id is a meta-route iff it starts with the lowercase prefix `auto/`.
 * Case-sensitive and untrimmed, as OmniRoute compares ids; callers that trim (env lists) trim
 * before asking. Consequently `auto` (no slash), `autonomous/x`, `x/auto/y` and `AUTO/x` are
 * NOT meta-routes by this predicate.
 *
 * PURE: the one definition of "not one model", shared by every boundary that refuses it.
 */
export const META_ROUTE_PREFIX = "auto/";

export function isMetaRoute(modelId: string): boolean {
  return modelId.startsWith(META_ROUTE_PREFIX);
}
