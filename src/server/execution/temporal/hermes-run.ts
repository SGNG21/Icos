/**
 * Classifies one governed `hermes -z` run from the STRUCTURED status it writes to
 * `--usage-file`.
 *
 * Hermes exits 0 and prints the provider's error text on stdout when a call fails, so
 * stdout must NEVER decide success — no string matching, no "looks like an error" list.
 * Fail closed: without an explicit `completed === true` and `failed === false`, the run
 * is a failure.
 */
export type HermesRunClassification =
  | { readonly ok: true; readonly result: string; readonly model?: string }
  | {
      readonly ok: false;
      readonly code: "WORKER_FAILED" | "INVALID_RESULT";
      readonly message: string;
    };

const MAX_MESSAGE = 300;

export function classifyHermesRun(stdout: string, usage: unknown): HermesRunClassification {
  const text = stdout.trim();
  const status = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;

  if (!status || status.completed !== true || status.failed !== false) {
    const detail = text ? text.slice(0, MAX_MESSAGE) : "no output";
    return {
      ok: false,
      code: "WORKER_FAILED",
      message: status
        ? `hermes run failed: ${detail}`
        : `hermes returned no structured status: ${detail}`,
    };
  }
  if (!text) {
    return { ok: false, code: "INVALID_RESULT", message: "hermes completed with an empty result" };
  }
  return {
    ok: true,
    result: text,
    ...(typeof status.model === "string" ? { model: status.model } : {}),
  };
}
