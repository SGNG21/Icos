/**
 * AN OMNIROUTE META-ROUTE IS NOT A MODEL (decision 0078 §3).
 *
 * OmniRoute exposes automatic routes and `auto/*` combos (`auto/best-free`, `auto/coding:free`,
 * ...) next to real model ids. The model they serve is chosen by the gateway at call time, not
 * by ICOS, and it can be a paid model: measured on 2026-10-14, `auto/best-free` served
 * `claude-opus-5`. Anywhere ICOS names ONE model — fleet candidates, registered workers, the
 * system allowlist, a goal's allowlist, the reviewer, the planner, a worker command's literal
 * `--model` — a meta-route would attribute history, independence and price to whatever the
 * gateway picked that day.
 *
 * THE RULE, exactly (case-sensitive, untrimmed: OmniRoute compares ids that way; callers that
 * trim, such as env lists, trim before asking). Read in the installed gateway
 * (/usr/lib/node_modules/omniroute):
 *
 *   1. Leading request-side wrappers are peeled, repeatedly and in any order, because the
 *      gateway removes them BEFORE automatic routing and combo resolution:
 *        - `no-think/`  — open-sse/utils/noThinkingAlias.ts:35-41, applied at
 *          src/sse/handlers/chat.ts:382-391;
 *        - `claude/`    — the cc-discovery mirror, src/lib/ccDiscoveryAliasResolve.ts:105-138,
 *          applied at src/sse/handlers/chat.ts:393-404. The gateway strips it for a known
 *          provider prefix, and operator-defined provider nodes are known prefixes
 *          (ccDiscoveryAliasResolve.ts:155-162), so `claude/auto/...` is peeled too.
 *   2. `claude/combo/<name>` IS a combo by construction (ccDiscoveryAliasStrip.ts:68-72):
 *      a meta-route whatever the name.
 *   3. What remains is a meta-route iff it is exactly `auto` or starts with `auto/`
 *      (src/sse/handlers/autoRouting.ts:93; combo fuzzy match chat.ts:646-656).
 *
 * NOT meta-routes by this rule: `autonomous/x`, `automatic-model`, `x/auto/y`, `AUTO/x`,
 * ` auto/x` (untrimmed). Provider-side automatic models (`openrouter/auto` and the like) and
 * gateway-configured redirections (model-combo mappings, task-aware routing) are NOT detected:
 * the first is a provider model, the second is gateway state no pure predicate can read.
 *
 * PURE: the one definition of "not one model", shared by every boundary that refuses it.
 */
export const META_ROUTE_PREFIX = "auto/";

const AUTO_ROUTE = "auto";
const NO_THINK_WRAPPER = "no-think/";
const CC_DISCOVERY_WRAPPER = "claude/";
const CC_DISCOVERY_COMBO = "combo/";

export function isMetaRoute(modelId: string): boolean {
  let id = modelId;

  for (;;) {
    if (id.startsWith(NO_THINK_WRAPPER)) {
      id = id.slice(NO_THINK_WRAPPER.length);
    } else if (id.startsWith(CC_DISCOVERY_WRAPPER)) {
      id = id.slice(CC_DISCOVERY_WRAPPER.length);
      if (id.startsWith(CC_DISCOVERY_COMBO)) return true;
    } else {
      break;
    }
  }

  return id === AUTO_ROUTE || id.startsWith(META_ROUTE_PREFIX);
}
