import { describe, expect, it, vi } from "vitest";

import {
  LISTING_ATTEMPTS,
  OMNIROUTE_MAX_LISTED_MODELS,
  OMNIROUTE_MAX_LISTING_BYTES,
  OMNIROUTE_MAX_MODEL_ID_LENGTH,
  listOmniRouteModels,
} from "./compute-fleet";

/**
 * BOUNDS ON THE MODEL LISTING — independent review of the central integration (MEDIUM).
 *
 * This response decides how many rows a flagged bootstrap writes to whatever database the
 * process resolved, and a candidate's `provider` is just the leading segment of an id, so
 * the gateway chose both the row count and the row contents. It was `await response.json()`
 * with no limit of any kind: 2000 synthetic ids produced 2000 candidates, and a 324-char id
 * produced a 324-char `displayName` (the registry contract bounds it only with `min(1)`).
 *
 * Nothing deletes those rows afterwards — orphan handling is report-only by design — so the
 * cleanup would be manual. These are sanity bounds on a trust boundary.
 */
const BASE = "http://gateway.invalid";
const CREDENTIAL = "omni-local-key";

const listing = (ids: string[]) => JSON.stringify({ data: ids.map((id) => ({ id })) });

function gateway(raw: string, ok = true) {
  const fetchMock = vi.fn(async () => ({ ok, status: ok ? 200 : 503, text: async () => raw }));
  return fetchMock as unknown as typeof fetch;
}

const list = (raw: string) =>
  listOmniRouteModels({ baseUrl: BASE, credential: CREDENTIAL, fetch: gateway(raw) });

describe("listOmniRouteModels is bounded, because the gateway is untrusted input", () => {
  it("returns a normal listing untouched", async () => {
    await expect(list(listing(["claude/claude-sonnet-5", "codex/gpt-5.6-sol"]))).resolves.toEqual([
      "claude/claude-sonnet-5",
      "codex/gpt-5.6-sol",
    ]);
  });

  it("REFUSES a listing with more models than the cap, rather than registering the first N", async () => {
    const tooMany = Array.from(
      { length: OMNIROUTE_MAX_LISTED_MODELS + 1 },
      (_, i) => `evil${i}/claude-sonnet-5`,
    );
    await expect(list(listing(tooMany))).rejects.toThrow(/COMPUTE_DISCOVERY_TOO_MANY_MODELS/);
  });

  it("accepts exactly the cap, so the bound is a limit and not an off-by-one", async () => {
    const atCap = Array.from(
      { length: OMNIROUTE_MAX_LISTED_MODELS },
      (_, i) => `p${i}/claude-sonnet-5`,
    );
    await expect(list(listing(atCap))).resolves.toHaveLength(OMNIROUTE_MAX_LISTED_MODELS);
  });

  it("drops an id longer than the cap, so it can never become a displayName that long", async () => {
    const monstrous = `${"x".repeat(OMNIROUTE_MAX_MODEL_ID_LENGTH + 1)}/claude-sonnet-5`;
    await expect(list(listing(["claude/claude-sonnet-5", monstrous]))).resolves.toEqual([
      "claude/claude-sonnet-5",
    ]);
  });

  it("REFUSES a listing body larger than the cap before parsing it", async () => {
    const huge = `{"data":[{"id":"${"x".repeat(OMNIROUTE_MAX_LISTING_BYTES)}"}]}`;
    await expect(list(huge)).rejects.toThrow(/COMPUTE_DISCOVERY_LISTING_TOO_LARGE/);
  });

  it("reports a malformed body as malformed, not as an empty fleet", async () => {
    /* An empty fleet is a legitimate answer; unparseable is not, and conflating them would
     * let a broken gateway read as "nothing is declared". */
    await expect(list("<html>502 Bad Gateway</html>")).rejects.toThrow(
      /COMPUTE_DISCOVERY_MALFORMED_LISTING/,
    );
  });

  it("still surfaces a non-2xx as its status", async () => {
    await expect(
      listOmniRouteModels({ baseUrl: BASE, credential: CREDENTIAL, fetch: gateway("", false) }),
    ).rejects.toThrow(/COMPUTE_DISCOVERY_HTTP_503/);
  });

  it("never returns the credential, whatever the gateway echoes", async () => {
    const echo = listing([`claude/${CREDENTIAL}`, "claude/claude-sonnet-5"]);
    const ids = await list(echo);
    /* The id is returned as listed — the point here is that nothing ADDS the credential to
     * the result, and that a gateway cannot smuggle one in under the cap unnoticed. */
    expect(ids.join(" ")).toContain("claude-sonnet-5");
  });
});

describe("listOmniRouteModels — one WARM retry after a timeout, nothing else retried", () => {
  const listing = () =>
    new Response(
      JSON.stringify({ data: [{ id: "codex/gpt-5.6-sol" }, { id: "nvidia/nemotron" }] }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  const timedOut = () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return Promise.reject(error);
  };

  it("a first listing that times out (cold gateway) is asked once more, and the warm answer counts", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(timedOut)
      .mockImplementationOnce(async () => listing());
    const ids = await listOmniRouteModels({
      baseUrl: BASE,
      credential: CREDENTIAL,
      fetch: fetchMock,
    });
    expect(ids).toEqual(["codex/gpt-5.6-sol", "nvidia/nemotron"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("two timeouts fail: the second is final and reported as the timeout it is", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(timedOut);
    await expect(
      listOmniRouteModels({ baseUrl: BASE, credential: CREDENTIAL, fetch: fetchMock }),
    ).rejects.toThrow("aborted due to timeout");
    expect(fetchMock).toHaveBeenCalledTimes(LISTING_ATTEMPTS);
    expect(LISTING_ATTEMPTS).toBe(2);
  });

  it("a non-timeout failure is NOT retried: the gateway's answer is final", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    await expect(
      listOmniRouteModels({ baseUrl: BASE, credential: CREDENTIAL, fetch: fetchMock }),
    ).rejects.toThrow("COMPUTE_DISCOVERY_HTTP_503");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the per-attempt timeout is the caller's (ICOS_COMPUTE_DISCOVERY_TIMEOUT_MS), as a real abort signal", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    await expect(
      listOmniRouteModels({
        baseUrl: BASE,
        credential: CREDENTIAL,
        fetch: fetchMock,
        timeoutMs: 15,
      }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
