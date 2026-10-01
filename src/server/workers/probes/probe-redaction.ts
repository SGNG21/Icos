/**
 * Bounded, redacted rendering of probe failure text (M6.1, extracted for the HTTP probe).
 *
 * Both probes report WHY a worker is unhealthy, and in both the text comes from outside
 * ICOS: a runtime's stderr, or a gateway's error body. Some gateways echo the key back in
 * a 401 body, so the masking here is not decoration. It lived privately inside
 * `CommandWorkerProbe`; the OmniRoute HTTP probe needs exactly the same guarantee, and
 * two copies of a redaction rule means the copy that drifts is the one that leaks.
 *
 * ONE LINE, 200 CHARS, TOKENS MASKED. Enough to diagnose "the provider refused and said
 * why", never enough to carry a credential or a response body.
 */
export function firstLineRedacted(text: string): string {
  return text
    .split("\n")[0]!
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, "$1<redacted>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>")
    .slice(0, 200);
}
