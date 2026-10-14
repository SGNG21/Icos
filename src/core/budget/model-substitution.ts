import { isMetaRoute } from "@/core/workers/meta-route";

/**
 * DID THE GATEWAY SERVE THE MODEL ICOS ASKED FOR? (decision 0078 §3, runtime half)
 *
 * The static rule (`isMetaRoute`) refuses the routes it can SEE. An operator combo, a pattern
 * mapping or a routing override bound to a concrete-looking id is gateway state no pure
 * predicate can read; the only place it shows is the answer. OmniRoute 3.8.49 rewrites a
 * non-streaming body's `model` to the resolved backend model and sends the same value in
 * `X-OmniRoute-Model` (open-sse/handlers/chatCore.ts:4594-4600). That value is PROVIDER-SCOPED:
 * a request for `nvidia/nvidia/nemotron-3-super-120b-a12b` is answered as
 * `nvidia/nemotron-3-super-120b-a12b`, i.e. the requested id minus its gateway prefix.
 *
 * THE RULE: the served id matches iff it equals the requested id, or the requested id ends with
 * `/<served>` (gateway prefix and request-side wrappers such as `no-think/` removed), after
 * dropping a trailing `[1m]` marker. A requested meta-route never matches: whatever answered
 * was chosen by the gateway.
 *
 * DELIBERATELY A REPORT, NOT A REFUSAL. False positives exist (a provider model alias the
 * gateway canonicalises, e.g. an undated id answered by a dated one), and a cross-provider
 * substitution that keeps the same model id is not seen. See the budget commit for why this
 * lot does not deny on it.
 *
 * PURE.
 */
export type ModelSubstitution =
  | { readonly kind: "SAME" }
  | { readonly kind: "META_ROUTE_REQUESTED" }
  | { readonly kind: "DIFFERENT_MODEL" };

const EXTENDED_CONTEXT_SUFFIX = "[1m]";

export function compareServedModel(requested: string, served: string): ModelSubstitution {
  if (isMetaRoute(requested)) return { kind: "META_ROUTE_REQUESTED" };
  const asked = requested.endsWith(EXTENDED_CONTEXT_SUFFIX)
    ? requested.slice(0, -EXTENDED_CONTEXT_SUFFIX.length)
    : requested;
  if (served === asked || asked.endsWith(`/${served}`)) return { kind: "SAME" };
  return { kind: "DIFFERENT_MODEL" };
}
