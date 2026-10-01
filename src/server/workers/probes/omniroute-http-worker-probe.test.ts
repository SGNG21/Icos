import { describe, expect, it, vi } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import {
  DEFAULT_HTTP_PROBE_TIMEOUT_MS,
  OmniRouteHttpWorkerProbe,
  probeModelOf,
  sameModelIdentity,
} from "@/server/workers/probes/omniroute-http-worker-probe";
import { CommandWorkerProbe } from "@/server/workers/probes/command-worker-probe";
import {
  candidateRegistration,
  classifyModels,
  representativeModels,
} from "@/server/workers/compute-fleet";
import { DEFAULT_COMPUTE_CAPABILITIES } from "@/server/workers/compute-bootstrap";

/*
 * MODEL HEALTH OVER HTTP.
 *
 * The question these answer is not "does fetch work" but "can anything that is not a
 * healthy, identified model reply reach `healthy`". Every non-2xx, every malformed body,
 * every substituted model and every wrong answer must be a dated FAILURE.
 */

const MODEL = "claude/claude-sonnet-5";
const BASE = "http://127.0.0.1:20129";
const CREDENTIAL = "omniroute-test-credential-abcdef0123456789";

const worker = (over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    workerKind: "agent",
    displayName: `compute:${MODEL}`,
    capabilities: ["code_editing"],
    features: [],
    supportsTools: false,
    supportsStructuredOutput: false,
    status: "active",
    runtime: "binary",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "unknown",
    availability: "unknown",
    tags: [],
    metadata: { model: MODEL, provider: "claude" },
    lastProbeAt: null,
    lastProbeOutcome: "never",
    maxConcurrency: 1,
    capacityPool: "provider:claude",
    capacityPoolLimit: null,
    updatedAt: new Date().toISOString(),
    ...over,
  }) as WorkerRegistryEntry;

const body = (content: string, model: string = MODEL) =>
  JSON.stringify({ model, choices: [{ message: { content } }] });

/** A gateway that answers with a status and a raw body. Records what was sent. */
function gateway(status: number, raw: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => raw,
    } as unknown as Response;
  });
  return { calls, fetch: impl as unknown as typeof fetch };
}

const probeWith = (g: { fetch: typeof fetch }, over = {}) =>
  new OmniRouteHttpWorkerProbe({ baseUrl: BASE, credential: CREDENTIAL, fetch: g.fetch, ...over });

describe("OmniRoute HTTP worker probe", () => {
  it("HTTP_PROBE_OK: a healthy model reply is healthy and available", async () => {
    const g = gateway(200, body("OK"));

    expect(await probeWith(g).probe(worker())).toEqual({
      health: "healthy",
      availability: "available",
    });

    /* The MINIMAL deterministic request: target model, no tools, no stream, tiny budget. */
    const sent = JSON.parse(String(g.calls[0]!.init.body));
    expect(g.calls[0]!.url).toBe(`${BASE}/v1/chat/completions`);
    expect(sent.model).toBe(MODEL);
    expect(sent.temperature).toBe(0);
    expect(sent.stream).toBe(false);
    expect(sent.max_tokens).toBe(512);
    expect(sent.tools).toBeUndefined();
    expect(sent.functions).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    expect(sent.messages).toHaveLength(1);
  });

  it("accepts the trailing-period and whitespace forms a model actually returns", async () => {
    for (const reply of ["OK", "OK.", " OK ", "OK\n"]) {
      const g = gateway(200, body(reply));
      await expect(probeWith(g).probe(worker())).resolves.toMatchObject({ health: "healthy" });
    }
  });

  it("HTTP_PROBE_WRONG_OUTPUT: 200 with a refusal is a FAILURE, not health", async () => {
    /* The exact fail-open hole decision 0054 closed: a refusal delivered as a success. */
    const g = gateway(200, body("HTTP 404: No active credentials for provider"));

    await expect(probeWith(g).probe(worker())).rejects.toThrow(/WORKER_PROBE_UNEXPECTED_OUTPUT/);
  });

  it("HTTP_PROBE_EMPTY_RESPONSE: no usable content is a failure", async () => {
    for (const raw of [
      JSON.stringify({ model: MODEL, choices: [] }),
      JSON.stringify({ model: MODEL, choices: [{ message: {} }] }),
      JSON.stringify({ model: MODEL, choices: [{ message: { content: "   " } }] }),
      JSON.stringify({ model: MODEL }),
      JSON.stringify({}),
    ]) {
      await expect(probeWith(gateway(200, raw)).probe(worker())).rejects.toThrow(
        /WORKER_PROBE_EMPTY_RESPONSE/,
      );
    }
  });

  it("a TRUNCATED reasoning reply is a failure: a model that never answered is not healthy", async () => {
    /*
     * Measured against the live gateway: a reasoning route can return `content: null` (or a
     * truncated thought) with `finish_reason: "length"`. Reasoning is not an answer, so this
     * must read as "produced no usable output" and never as health.
     */
    const truncated = JSON.stringify({
      model: MODEL,
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: null, reasoning_content: "The user wants me to" },
        },
      ],
    });

    await expect(probeWith(gateway(200, truncated)).probe(worker())).rejects.toThrow(
      /WORKER_PROBE_EMPTY_RESPONSE/,
    );

    const preamble = JSON.stringify({
      model: MODEL,
      choices: [
        {
          finish_reason: "length",
          message: { content: 'The user wants me to reply with exactly the word "OK"' },
        },
      ],
    });
    await expect(probeWith(gateway(200, preamble)).probe(worker())).rejects.toThrow(
      /WORKER_PROBE_UNEXPECTED_OUTPUT/,
    );
  });

  it("HTTP_PROBE_MALFORMED_JSON: an unparseable body is a failure", async () => {
    const g = gateway(200, "<html><body>502 Bad Gateway</body></html>");

    await expect(probeWith(g).probe(worker())).rejects.toThrow(/WORKER_PROBE_MALFORMED_RESPONSE/);
  });

  it.each([
    ["HTTP_PROBE_401", 401, "invalid api key"],
    ["HTTP_PROBE_403", 403, "forbidden"],
    ["HTTP_PROBE_404_MODEL", 404, "unknown model"],
    ["HTTP_PROBE_429", 429, "rate limit exceeded"],
    ["HTTP_PROBE_5XX", 503, "upstream unavailable"],
  ])("%s: never healthy, and the status stays legible", async (_name, status, text) => {
    const g = gateway(status, text);

    await expect(probeWith(g).probe(worker())).rejects.toThrow(
      new RegExp(`WORKER_PROBE_HTTP_${status}`),
    );
  });

  it("HTTP_PROBE_TIMEOUT: a slow gateway is a dated failure, and the request is aborted", async () => {
    let seen: AbortSignal | undefined;
    const slow = vi.fn(async (_url: unknown, init: unknown) => {
      seen = (init as RequestInit).signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        seen!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }) as unknown as typeof fetch;

    await expect(probeWith({ fetch: slow }, { timeoutMs: 20 }).probe(worker())).rejects.toThrow(
      /WORKER_PROBE_TIMEOUT/,
    );
    expect(seen?.aborted).toBe(true);
  });

  it("HTTP_PROBE_ABORT: a transport failure is distinguished from a timeout", async () => {
    const dead = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:20129"));

    await expect(
      probeWith({ fetch: dead as unknown as typeof fetch }).probe(worker()),
    ).rejects.toThrow(/WORKER_PROBE_TRANSPORT/);
  });

  it("HTTP_PROBE_MODEL_MISMATCH: a substituted model is never credited as healthy", async () => {
    const g = gateway(200, body("OK", "claude/claude-haiku-4-5-20251001"));

    await expect(probeWith(g).probe(worker())).rejects.toThrow(/WORKER_PROBE_MODEL_MISMATCH/);
  });

  it("accepts the two identity forms the live gateway actually produces, and nothing else", async () => {
    /*
     * MEASURED against all 15 candidates: every answer is the requested id verbatim, or
     * the requested id minus exactly ONE leading route segment. Nothing else occurred.
     */
    expect(sameModelIdentity("gpt-5.6-sol", "gpt-5.6-sol")).toBe(true);
    expect(sameModelIdentity("claude/claude-sonnet-5", "claude-sonnet-5")).toBe(true);
    expect(
      sameModelIdentity(
        "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
        "nvidia/nemotron-3-ultra-550b-a55b",
      ),
    ).toBe(true);
    expect(
      sameModelIdentity(
        "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
        "nvidia/nemotron-3-super-120b-a12b:free",
      ),
    ).toBe(true);

    /* A different model is a substitution. */
    expect(sameModelIdentity("claude/claude-sonnet-5", "claude/claude-opus-5")).toBe(false);
    expect(sameModelIdentity("claude/claude-sonnet-5", "claude-opus-5")).toBe(false);

    /*
     * THE HOLE THE OLD TAIL-ONLY COMPARISON LEFT OPEN. Comparing only the last segment
     * accepted a foreign vendor, and accepted a two-segment strip we never observed.
     */
    expect(sameModelIdentity("claude/claude-sonnet-5", "some-other-vendor/claude-sonnet-5")).toBe(
      false,
    );
    expect(
      sameModelIdentity("nvidia/nvidia/nemotron-3-ultra-550b-a55b", "nemotron-3-ultra-550b-a55b"),
    ).toBe(false);

    const g = gateway(200, body("OK", "claude-sonnet-5"));
    await expect(probeWith(g).probe(worker())).resolves.toMatchObject({ health: "healthy" });
    /* A gateway that reports no model at all cannot be held to an identity it never gave. */
    const silent = gateway(200, JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    await expect(probeWith(silent).probe(worker())).resolves.toMatchObject({ health: "healthy" });
  });

  it("never substitutes a model, and refuses a worker that declares none", async () => {
    const g = gateway(200, body("OK"));

    await expect(probeWith(g).probe(worker({ metadata: {} }))).rejects.toThrow(
      /WORKER_PROBE_NO_MODEL/,
    );
    /* It did not guess a model and ask anyway. */
    expect(g.calls).toHaveLength(0);
  });

  it("HTTP_PROBE_SECRET_REDACTION: no credential or body bulk reaches a failure message", async () => {
    const leaky = [
      `401 Unauthorized: Authorization: Bearer ${CREDENTIAL}`,
      `invalid key sk-live-abcdef0123456789abcdef`,
      "x".repeat(5_000),
    ].join(" ");

    const failures: string[] = [];
    for (const g of [gateway(401, leaky), gateway(200, body(leaky))]) {
      await probeWith(g)
        .probe(worker())
        .catch((e: unknown) => failures.push(String((e as Error).message)));
    }

    expect(failures).toHaveLength(2);
    for (const message of failures) {
      expect(message).not.toContain(CREDENTIAL);
      expect(message).not.toContain("sk-live-abcdef0123456789abcdef");
      expect(message).not.toContain("x".repeat(300));
      expect(message.length).toBeLessThan(400);
    }
  });

  it("HTTP_PROBE_NO_TOOL_AUTHORITY: the probe spawns no process and reads no host secret", async () => {
    /*
     * Structural, not aspirational. The adapter's ONLY outbound capability is the injected
     * fetch: it imports no child_process and no fs, and the request it builds carries the
     * gateway credential and nothing else from the environment.
     */
    const raw = await import("node:fs").then((fs) =>
      fs.readFileSync("src/server/workers/probes/omniroute-http-worker-probe.ts", "utf8"),
    );
    /* CODE only — the header comment names these very secrets to explain why it avoids them. */
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/child_process|node:fs|spawn\(|exec\(|execFile/);
    expect(code).not.toMatch(/DATABASE_URL|BETTER_AUTH_SECRET|ICOS_OWNER_PASSWORD|GITHUB_TOKEN/);
    /* It reads no environment at all: every value is injected by the container. */
    expect(code).not.toMatch(/process\.env/);

    const g = gateway(200, body("OK"));
    process.env.ICOS_HTTP_PROBE_CANARY = "must-not-travel";
    try {
      await probeWith(g).probe(worker());
    } finally {
      delete process.env.ICOS_HTTP_PROBE_CANARY;
    }
    const sent = JSON.stringify(g.calls[0]);
    expect(sent).not.toContain("must-not-travel");
    /* Exactly one header carries a secret, and it is the gateway's own. */
    const headers = g.calls[0]!.init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Authorization", "Content-Type"]);
    expect(headers.Authorization).toBe(`Bearer ${CREDENTIAL}`);
  });

  it("HTTP_PROBE_NO_FALLBACK_TO_COMMAND: a failed HTTP probe never reaches the command probe", async () => {
    const store = new InMemoryWorkerRegistryStore();
    const registration = new WorkerRegistrationService(store);
    await registration.register({
      id: worker().id,
      workerKind: "agent",
      displayName: worker().displayName,
      capabilities: ["code_editing"],
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
      metadata: { model: MODEL, provider: "claude" },
    });

    const command = new CommandWorkerProbe(() => ({ command: "/bin/true" }));
    const spy = vi.spyOn(command, "probe");
    const http = probeWith(gateway(503, "upstream unavailable"));
    const prober = new WorkerHealthProber(store, registration, {
      /* The command probe IS configured for `binary` — and must still never be consulted. */
      adapters: { binary: command },
      selectProbe: (w) => (probeModelOf(w) ? http : undefined),
    });

    const [record] = await prober.probeAll();

    expect(record!.outcome).toBe("failed");
    expect(record!.health).toBe("unhealthy");
    expect(spy).not.toHaveBeenCalled();
  });

  it("selection is explicit: a worker with no model keeps the command probe", async () => {
    const store = new InMemoryWorkerRegistryStore();
    const registration = new WorkerRegistrationService(store);
    await registration.register({
      id: "22222222-2222-4222-8222-222222222222",
      workerKind: "agent",
      displayName: "binary-worker",
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });

    const command = new CommandWorkerProbe(() => ({ command: "/bin/true" }));
    const spy = vi.spyOn(command, "probe").mockResolvedValue({
      health: "healthy",
      availability: "available",
    });
    const http = probeWith(gateway(200, body("OK")));
    const prober = new WorkerHealthProber(store, registration, {
      adapters: { binary: command },
      selectProbe: (w) => (probeModelOf(w) ? http : undefined),
    });

    const [record] = await prober.probeAll();

    expect(record!.outcome).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("HTTP_PROBE_ROUTABILITY_SEMANTICS: registered != healthy != available != routable", async () => {
    const store = new InMemoryWorkerRegistryStore();
    const registration = new WorkerRegistrationService(store);
    const router = new CapabilityRouter(store);
    const declaration = {
      id: worker().id,
      workerKind: "agent",
      displayName: worker().displayName,
      capabilities: ["code_editing"],
      runtime: "binary" as const,
      runtimeSupport: "SUPPORTED_RUNTIME" as const,
      metadata: { model: MODEL, provider: "claude" },
    };
    await registration.register(declaration);

    /* REGISTERED is not healthy, and not routable. */
    expect((await store.get(declaration.id))?.health).toBe("unknown");
    expect((await router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );

    const prober = (g: { fetch: typeof fetch }) =>
      new WorkerHealthProber(store, registration, {
        selectProbe: () => probeWith(g),
      });

    /* A FAILED probe is availability-negative, still not routable. */
    await prober(gateway(429, "rate limited")).probeAll();
    expect((await store.get(declaration.id))?.health).toBe("unhealthy");
    expect((await router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );

    /* HEALTHY + AVAILABLE + fresh dated evidence is what finally makes it ROUTABLE. */
    await prober(gateway(200, body("OK"))).probeAll();
    const healthy = await store.get(declaration.id);
    expect(healthy?.health).toBe("healthy");
    expect(healthy?.availability).toBe("available");
    expect(healthy?.lastProbeOutcome).toBe("ok");
    expect((await router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "ROUTED",
    );

    /* And availability alone is not routability: taken out of rotation, it routes nothing. */
    await registration.deactivate(declaration.id);
    expect((await store.get(declaration.id))?.health).toBe("healthy");
    expect((await router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("ALL_PLANNED_CANDIDATES_RESOLVE: every declared compute worker has a valid probe mechanism", async () => {
    const served = [
      "cc/claude-haiku-4-5-20251001",
      "cc/claude-opus-5",
      "cc/claude-sonnet-5",
      "claude/claude-haiku-4-5-20251001",
      "claude/claude-opus-5",
      "claude/claude-sonnet-5",
      "codex/gpt-5.6-sol",
      "cx/gpt-5.6-sol",
      "gpt-5.6-sol",
      "nvidia/nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
      "oc/nemotron-3-ultra-free",
      "oc/oc/nemotron-3-super-free",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    ];
    const planned = representativeModels(classifyModels(served));
    expect(planned).toHaveLength(15);

    /* No `model` echoed back, so identity cannot be asserted against a value never given. */
    const g = gateway(200, JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    const http = probeWith(g);
    const select = (w: WorkerRegistryEntry) => (probeModelOf(w) ? http : undefined);

    for (const model of planned) {
      const w = candidateRegistration(model, {
        runtime: "binary",
        capabilities: [...DEFAULT_COMPUTE_CAPABILITIES],
      }) as WorkerRegistryEntry;
      expect(select(w), `no probe mechanism for ${model.modelId}`).toBe(http);
      expect(probeModelOf(w)).toBe(model.modelId);
    }
    /* Each candidate is asked for ITS OWN model — 15 distinct ids, no substitution. */
    const asked = g.calls.map((c) => JSON.parse(String(c.init.body)).model);
    expect(asked).toEqual([]);
    for (const model of planned) {
      await http.probe(
        candidateRegistration(model, {
          runtime: "binary",
          capabilities: [],
        }) as WorkerRegistryEntry,
      );
    }
    expect(new Set(g.calls.map((c) => JSON.parse(String(c.init.body)).model)).size).toBe(15);
  });

  it("the default timeout is the measured one, and is overridable", () => {
    expect(DEFAULT_HTTP_PROBE_TIMEOUT_MS).toBe(15_000);
    /* > 2x the worst observed probe (6305ms), and 3 waves of it fit the 120s horizon. */
    expect(DEFAULT_HTTP_PROBE_TIMEOUT_MS).toBeGreaterThan(6_305 * 2);
    expect(Math.ceil(15 / 6) * DEFAULT_HTTP_PROBE_TIMEOUT_MS).toBeLessThan(120_000);
  });
});
