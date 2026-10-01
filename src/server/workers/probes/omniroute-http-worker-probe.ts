import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type {
  WorkerHealthObservation,
  WorkerHealthProbePort,
} from "@/server/services/worker-registry/worker-health-prober";
import { omniRouteChatCompletion } from "@/server/workers/compute-fleet";
import { firstLineRedacted } from "@/server/workers/probes/probe-redaction";

/**
 * MODEL HEALTH OVER HTTP, with no host authority at all.
 *
 * WHY THIS EXISTS. `CommandWorkerProbe` answers "can this runtime execute here" by
 * spawning the runtime, which is right for a runtime and wrong for a MODEL. Probing a
 * model through an agent CLI was measured to hand every probe the server's whole
 * environment (9 secrets including `DATABASE_URL` for the live database) plus that CLI's
 * enabled toolsets — terminal, file, code execution, browser, computer use, cron,
 * delegation — with approvals auto-bypassed, unattended, every 30 seconds. The prompt was
 * benign, so nothing happened; but a health check must not hold authority it cannot use,
 * and ICOS's own rule is that a probe has no destructive side effects and does not mutate
 * the live database. This path can do neither: there is no child process, no shell, no
 * filesystem, no tool surface and no credential beyond the gateway's own.
 *
 * WHAT IT MEASURES, AND ONLY THAT. One tiny completion against the model named in the
 * worker's canonical metadata. Healthy requires ALL of: the request completed, the gateway
 * answered 2xx, the body parsed, the response had the OpenAI/OmniRoute shape, the response
 * identified the model we asked for, and the content matched the health predicate.
 *
 * EVERY OTHER OUTCOME THROWS, and a thrown probe is recorded `failed` — a dated negative,
 * never "not looked at yet" and never healthy. 401/403/404/429/5xx, a timeout, an abort,
 * malformed JSON, an empty choice and a substituted model are all failures, each with its
 * own distinguishable code so an operator can tell a deployment gap from a refusal.
 *
 * NO FALLBACK. Nothing here reaches for the command probe when a request fails. Falling
 * back on failure would mean a gateway hiccup silently restores exactly the host authority
 * this adapter exists to remove. Which probe serves a worker is decided BEFORE any request,
 * from the worker's own metadata, by the selector in the container.
 *
 * REGISTERED != HEALTHY != AVAILABLE != ROUTABLE. This returns an observation, not a
 * routing decision: the canonical matcher still gates on status, runtime support, evidence
 * freshness and capacity.
 */

/** The health question. Smallest deterministic request that proves a model answered. */
export const DEFAULT_PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";
/** The answer that counts. Same predicate the certified command probe used, so evidence compares. */
export const DEFAULT_HEALTH_PATTERN = "^\\s*OK\\.?\\s*$";
/**
 * Default budget for one probe.
 *
 * MEASURED, not guessed: 15 live candidates through the local gateway gave p50 4058 ms,
 * p95 5297 ms and a worst observed probe of 6305 ms, with zero timeouts at a 45 s bound.
 * 15 s is ~2.4x the worst observation and ~2.8x p95, so a healthy-but-slow model is not
 * killed, while the whole fleet (15 workers / PROBE_CONCURRENCY 6 = 3 waves) has a
 * worst-case sweep of 45 s — comfortably inside the 120 s health-evidence horizon, which a
 * 45 s budget would have exceeded at 135 s and made routability flicker. Overridable,
 * because those numbers describe a LOCAL gateway; a remote one must be re-measured.
 */
export const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 15_000;
/**
 * Token budget for the reply. A verdict needs one word; this allows far more, on purpose.
 *
 * MEASURED: at 16 tokens two `openrouter/*:free` routes returned HTTP 502
 * `upstream_empty_response`, and at 512 the SAME routes returned `finish_reason: "stop"`
 * with `content: "OK"`. A reasoning model spends budget thinking before it answers, so a
 * budget tight enough to truncate the thought reports a WORKING model as unavailable —
 * a false negative that silently removes real capacity, which is as harmful as a false
 * positive. A probe reply is a handful of tokens either way, so the headroom is free.
 */
export const DEFAULT_PROBE_MAX_TOKENS = 512;

export interface OmniRouteHttpWorkerProbeOptions {
  baseUrl: string;
  credential: string;
  timeoutMs?: number;
  prompt?: string;
  /** Regex the model's reply must match. Anything else is a failure, never "unknown". */
  healthPattern?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

interface ChatCompletionBody {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** The model this worker IS. Absent means the worker is not model compute — a config defect. */
export function probeModelOf(worker: WorkerRegistryEntry): string | null {
  const model = worker.metadata?.model;
  return typeof model === "string" && model.trim() !== "" ? model : null;
}

/**
 * Compares the model we asked for with the one the gateway says answered.
 *
 * THE RULE IS MEASURED, not assumed. All 15 live candidates were asked and their responses
 * recorded: every answer is either the requested id VERBATIM (`gpt-5.6-sol`) or the
 * requested id with exactly ONE leading route segment removed
 * (`nvidia/nvidia/x` -> `nvidia/x`, `cc/claude-sonnet-5` -> `claude-sonnet-5`). Nothing
 * else occurred — no missing field, no renaming, no deeper stripping.
 *
 * So accept exactly those two forms. An earlier version compared only the LAST segment,
 * which would also have accepted `some-other-vendor/claude-sonnet-5` as an answer for
 * `claude/claude-sonnet-5`; a substituted model must not pass as health, or execution
 * history, capacity accounting and reviewer independence get credited to a model that
 * never ran.
 *
 * KNOWN BLIND SPOT, stated rather than papered over: the gateway reports the resolved
 * MODEL, never the route it took, so `cc/claude-sonnet-5` and `claude/claude-sonnet-5`
 * both answer as `claude-sonnet-5`. If the gateway silently served one route's request via
 * the other, nothing in the response could reveal it. Those are distinct workers with
 * distinct capacity pools, so that is a real residual risk; closing it needs the gateway
 * to echo its route, not a cleverer comparison here.
 */
export function sameModelIdentity(requested: string, reported: string): boolean {
  const norm = (id: string) => id.trim().toLowerCase();
  const asked = norm(requested);
  const answered = norm(reported);
  const withoutRoute = asked.includes("/") ? asked.slice(asked.indexOf("/") + 1) : null;
  return answered === asked || answered === withoutRoute;
}

export class OmniRouteHttpWorkerProbe implements WorkerHealthProbePort {
  constructor(private readonly options: OmniRouteHttpWorkerProbeOptions) {}

  async probe(worker: WorkerRegistryEntry): Promise<WorkerHealthObservation> {
    const model = probeModelOf(worker);
    if (!model) {
      /* Never guess a model: a probe of the wrong model is worse than no probe. */
      throw new Error(
        `WORKER_PROBE_NO_MODEL: worker ${worker.id} declares no metadata.model to probe`,
      );
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_HTTP_PROBE_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("PROBE_TIMEOUT")), timeoutMs);

    let response;
    try {
      response = await omniRouteChatCompletion({
        baseUrl: this.options.baseUrl,
        credential: this.options.credential,
        model,
        prompt: this.options.prompt ?? DEFAULT_PROBE_PROMPT,
        maxTokens: this.options.maxTokens ?? DEFAULT_PROBE_MAX_TOKENS,
        signal: controller.signal,
        fetch: this.options.fetch,
      });
    } catch (error) {
      /*
       * A timeout and a transport failure are both negative OBSERVATIONS, never missing
       * ones. `controller.signal.aborted` separates "we gave up" from "it refused",
       * because an operator fixes those differently.
       */
      if (controller.signal.aborted) {
        throw new Error(`WORKER_PROBE_TIMEOUT: ${model} did not answer within ${timeoutMs}ms`);
      }
      throw new Error(
        `WORKER_PROBE_TRANSPORT: ${model} — ${firstLineRedacted(
          error instanceof Error ? error.message : String(error),
        )}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      /* The status is the diagnosis; the body may be the gateway's, so it is redacted. */
      throw new Error(
        `WORKER_PROBE_HTTP_${response.status}: ${model} — ${
          firstLineRedacted(response.body.trim()) || "<empty body>"
        }`,
      );
    }

    let body: ChatCompletionBody;
    try {
      body = JSON.parse(response.body) as ChatCompletionBody;
    } catch {
      throw new Error(
        `WORKER_PROBE_MALFORMED_RESPONSE: ${model} — ${
          firstLineRedacted(response.body.trim()) || "<empty body>"
        }`,
      );
    }

    if (typeof body.model === "string" && !sameModelIdentity(model, body.model)) {
      throw new Error(
        `WORKER_PROBE_MODEL_MISMATCH: asked ${model}, gateway answered as ${firstLineRedacted(
          body.model,
        )}`,
      );
    }

    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(`WORKER_PROBE_EMPTY_RESPONSE: ${model} returned no usable content`);
    }

    const pattern = this.options.healthPattern ?? DEFAULT_HEALTH_PATTERN;
    if (!new RegExp(pattern).test(content)) {
      /*
       * Answered 200 and said something else. This is the fail-open hole decision 0054
       * closed: a gateway returns "no active credentials for provider" as a successful
       * completion, and an HTTP status alone would certify a dead model.
       */
      throw new Error(
        `WORKER_PROBE_UNEXPECTED_OUTPUT: ${model} — ${firstLineRedacted(content.trim())}`,
      );
    }

    return { health: "healthy", availability: "available" };
  }
}
