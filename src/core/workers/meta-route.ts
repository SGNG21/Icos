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
 *   4. PROVIDER-SIDE AUTOMATIC MODELS. Some providers expose a model whose job is to pick
 *      another model (`openrouter/auto`, Cursor's `auto`, Kilo's `kilo-auto/*`, the
 *      "Free Models Router" ...). The gateway forwards them as ordinary provider models, but
 *      the model that answers is chosen upstream, possibly a paid one. They are matched
 *      EXACTLY, `<provider id or alias>/<provider model id>`, against the list below, read in
 *      the installed gateway's registry (open-sse/config/providers/registry, OmniRoute
 *      3.8.49); a client addresses a provider by its id or its alias
 *      (open-sse/services/model.ts:414-420, resolveProviderAlias :134). A trailing `[1m]`
 *      (extended-context marker, stripped by parseModel at model.ts:397-400) is peeled first.
 *      Exact matching is the point: `./auto`, `src/auto`, `my-openrouter/auto` stay ordinary
 *      strings.
 *
 * NOT meta-routes by this rule: `autonomous/x`, `automatic-model`, `x/auto/y`, `AUTO/x`,
 * ` auto/x` (untrimmed), `./auto`. A router model a provider adds to its DYNAMIC catalogue
 * after 3.8.49, and gateway-configured redirections (model-combo mappings, task-aware
 * routing), are NOT detected: the first is not in the registry this list was read from, the
 * second is gateway state no pure predicate can read — the metered proxy's served-model check
 * (`SPEND_MODEL_SUBSTITUTED`) is the runtime net for both.
 *
 * PURE: the one definition of "not one model", shared by every boundary that refuses it.
 */
export const META_ROUTE_PREFIX = "auto/";

const AUTO_ROUTE = "auto";
const NO_THINK_WRAPPER = "no-think/";
const CC_DISCOVERY_WRAPPER = "claude/";
const CC_DISCOVERY_COMBO = "combo/";

const EXTENDED_CONTEXT_SUFFIX = "[1m]";

/**
 * Provider-side automatic models, as `<provider id or alias>/<model id>`. Each row cites the
 * registry entry (path under open-sse/config/providers/registry, 3.8.49) that declares the
 * provider's id/alias and the router model.
 */
const PROVIDER_ROUTERS: ReadonlyArray<{
  readonly prefixes: readonly string[];
  readonly models: readonly string[];
}> = [
  /* openrouter/index.ts:4-5 (id = alias = openrouter), :16 `auto` "Auto (Best Available)".
   * OpenRouter's own catalogue ids for its routers, `openrouter/auto(-beta)` and
   * `openrouter/free` "Free Models Router", are named in config/freeModelCatalog.data.ts:273-274;
   * a synced catalogue exposes them under the provider prefix, and `openrouter/free` is a
   * listed id measured 502 on 2026-10-14 (OMNIROUTE_MODEL_STRATEGY_2026-10-14.md §1). */
  {
    prefixes: ["openrouter"],
    models: ["auto", "free", "openrouter/auto", "openrouter/auto-beta", "openrouter/free"],
  },
  /* factory/index.ts:20-21, :32 `auto` "Factory Auto (best model)". */
  { prefixes: ["factory"], models: ["auto"] },
  /* trae/index.ts:4-5 (alias tr), :13 `auto` "Server Picks", :14 `work` "Work (Auto · fast)". */
  { prefixes: ["trae", "tr"], models: ["auto", "work"] },
  /* dify/index.ts:4-5, :11 `auto`. */
  { prefixes: ["dify"], models: ["auto"] },
  /* cursor/index.ts:5-6 (alias cu), :17 `auto` "Auto (Server Picks)". */
  { prefixes: ["cursor", "cu"], models: ["auto"] },
  /* charm-hyper/index.ts:4-5, :12 `hyper/auto`. */
  { prefixes: ["charm-hyper"], models: ["hyper/auto"] },
  /* orcarouter/index.ts:12-13, :27 `orcarouter/auto` "Auto (smart routing)". */
  { prefixes: ["orcarouter"], models: ["orcarouter/auto"] },
  /* kilo-gateway/index.ts:4-5 (alias kg), :13-15 `kilo-auto/*`; freeModelCatalog.data.ts:273-274
   * lists `openrouter/auto-beta` and `openrouter/free` under kilo-gateway. */
  {
    prefixes: ["kilo-gateway", "kg"],
    models: [
      "kilo-auto/frontier",
      "kilo-auto/balanced",
      "kilo-auto/free",
      "openrouter/auto-beta",
      "openrouter/free",
    ],
  },
  /* kilocode/index.ts:4-5 (alias kc), :27 `openrouter/free` "Free Models Router". */
  { prefixes: ["kilocode", "kc"], models: ["openrouter/free"] },
  /* cline/index.ts:4-5 (alias cl), :79-80 `openrouter/free` "Free Models Router". */
  { prefixes: ["cline", "cl"], models: ["openrouter/free"] },
  /* dgrid/index.ts:4-5, :13 `dgridai/free` "DGrid Free Models Router". */
  { prefixes: ["dgrid"], models: ["dgridai/free"] },
  /* bazaarlink/index.ts:4-5 (alias bzl), :13 `auto:free` "Auto Free (Zero Cost)". */
  { prefixes: ["bazaarlink", "bzl"], models: ["auto:free"] },
  /* perplexity/web/index.ts:4-5 (id perplexity-web, alias pplx-web), :12 `pplx-auto`. */
  { prefixes: ["perplexity-web", "pplx-web"], models: ["pplx-auto"] },
  /* adapta-web/index.ts:4-5 (alias adp-web), :12 `adapta-one` "Adapta ONE (Auto)". */
  { prefixes: ["adapta-web", "adp-web"], models: ["adapta-one"] },
];

export const PROVIDER_AUTO_ROUTES: ReadonlySet<string> = new Set(
  PROVIDER_ROUTERS.flatMap(({ prefixes, models }) =>
    prefixes.flatMap((prefix) => models.map((model) => `${prefix}/${model}`)),
  ),
);

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

  if (id.endsWith(EXTENDED_CONTEXT_SUFFIX)) id = id.slice(0, -EXTENDED_CONTEXT_SUFFIX.length);

  return id === AUTO_ROUTE || id.startsWith(META_ROUTE_PREFIX) || PROVIDER_AUTO_ROUTES.has(id);
}
