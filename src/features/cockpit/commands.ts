import { z } from "zod";

import {
  COMMAND_SPECS,
  confirmationPhrase,
  controlCommandRequestSchema,
  controlCommandResultSchema,
  controlStateSchema,
  type ControlCommandRequest,
  type ControlCommandResult,
  type ControlCommandType,
  type ControlState,
  type ControlTarget,
  type RiskClass,
} from "@/core/control/contracts";

/**
 * Cockpit side of the governed control plane (decision 0044, feat/control-foundation).
 *
 * The contract is the backend's (`@/core/control/contracts`): 7 commands, risk
 * fixed server-side, integer `expectedVersion`, single-use re-auth proofs,
 * typed confirmation for CRITICAL. The cockpit never decides whether a command
 * is allowed; it collects what the backend asks for, sends it, and shows the
 * typed answer. When the control API is absent from this deployment every
 * control reports NOT_CONNECTED — never a success it did not receive.
 */
export { COMMAND_SPECS, confirmationPhrase };
export type { ControlCommandType, ControlTarget, RiskClass };

export const COMMAND_LABEL: Record<ControlCommandType, string> = {
  PAUSE_MISSION: "Pause",
  RESUME_MISSION: "Resume",
  CANCEL_MISSION: "Cancel",
  DISABLE_WORKER: "Disable",
  ENABLE_WORKER: "Enable",
  ENTER_SAFE_MODE: "Enter safe mode",
  EXIT_SAFE_MODE: "Exit safe mode",
};

/** UI lifecycle. Only SUCCEEDED means the effect is durably applied. */
export type ControlPhase =
  | "REQUESTED"
  | "AUTH_REQUIRED"
  | "AUTHORIZED"
  | "EXECUTING"
  | "SUCCEEDED"
  | "REJECTED"
  | "FAILED"
  | "UNKNOWN"
  | "NOT_CONNECTED"
  | "UNAVAILABLE";

export const riskOf = (type: ControlCommandType): RiskClass => COMMAND_SPECS[type].risk;

/**
 * UX anticipation of the server policy (HIGH/CRITICAL need a password proof).
 * The server stays authoritative and can still answer REAUTH_REQUIRED.
 */
export const needsReauth = (type: ControlCommandType) =>
  riskOf(type) === "HIGH" || riskOf(type) === "CRITICAL";

// ------------------------------------------------------------------ transport

export type Reply<T> =
  | { kind: "ok"; status: number; value: T }
  /** The control API does not exist on this deployment (route missing). */
  | { kind: "not_connected" }
  | { kind: "error"; status: number; code: string; message: string };

export interface ControlTransport {
  state(target: ControlTarget): Promise<Reply<ControlState>>;
  reauth(password: string): Promise<Reply<{ proof: string; expiresAt: string }>>;
  submit(request: ControlCommandRequest): Promise<Reply<ControlCommandResult>>;
  get(commandId: string): Promise<Reply<ControlCommandResult>>;
}

const errorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const proofSchema = z.object({ proof: z.string(), expiresAt: z.string() });

async function parseReply<T>(res: Response, schema: z.ZodType<T>): Promise<Reply<T>> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const value = schema.safeParse(body);
  if (value.success) return { kind: "ok", status: res.status, value: value.data };
  const envelope = errorEnvelope.safeParse(body);
  if (envelope.success) return { kind: "error", status: res.status, ...envelope.data.error };
  // A 404 without the ICOS error envelope is the framework's "no such route".
  if (res.status === 404) return { kind: "not_connected" };
  return { kind: "error", status: res.status, code: "unexpected_response", message: "" };
}

/** HTTP transport to `/api/control/*`. Throws only on network failure. */
export function httpControlTransport(doFetch: typeof fetch = fetch): ControlTransport {
  const init = (method: "GET" | "POST", body?: unknown): RequestInit => ({
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    async state(target) {
      const q =
        target.kind === "mission"
          ? `?missionId=${encodeURIComponent(target.id)}`
          : target.kind === "worker"
            ? `?workerId=${encodeURIComponent(target.id)}`
            : "";
      return parseReply(await doFetch(`/api/control/state${q}`, init("GET")), controlStateSchema);
    },
    async reauth(password) {
      return parseReply(
        await doFetch("/api/control/reauth", init("POST", { password })),
        proofSchema,
      );
    },
    async submit(request) {
      return parseReply(
        await doFetch("/api/control/commands", init("POST", request)),
        controlCommandResultSchema,
      );
    },
    async get(commandId) {
      return parseReply(
        await doFetch(`/api/control/commands/${encodeURIComponent(commandId)}`, init("GET")),
        controlCommandResultSchema,
      );
    },
  };
}

// ------------------------------------------------------------------ flow

export interface Outcome {
  phase: ControlPhase;
  detail: string;
  result?: ControlCommandResult;
}

/** The version the owner is acting on, read from the control plane — never guessed. */
export function versionOf(state: ControlState, target: ControlTarget): number | null {
  switch (target.kind) {
    case "runtime":
      return state.runtime.version;
    case "mission":
      return state.missions.find((m) => m.id === target.id)?.version ?? null;
    case "worker":
      return state.workers.find((w) => w.id === target.id)?.version ?? null;
  }
}

export async function loadVersion(
  transport: ControlTransport,
  target: ControlTarget,
): Promise<{ ok: true; version: number } | { ok: false; outcome: Outcome }> {
  let reply: Reply<ControlState>;
  try {
    reply = await transport.state(target);
  } catch {
    return { ok: false, outcome: { phase: "UNAVAILABLE", detail: "ICOS is unreachable." } };
  }
  if (reply.kind !== "ok") return { ok: false, outcome: fromTransportError(reply, false) };
  const version = versionOf(reply.value, target);
  return version === null
    ? {
        ok: false,
        outcome: {
          phase: "UNAVAILABLE",
          detail: "ICOS did not return a version for this target; nothing can be sent.",
        },
      }
    : { ok: true, version };
}

export function phaseOfResult(result: ControlCommandResult): ControlPhase {
  switch (result.status) {
    case "EXECUTED":
      return "SUCCEEDED";
    case "FAILED":
      return "FAILED";
    case "UNKNOWN_EXECUTION_STATE":
      return "UNKNOWN";
    case "REJECTED":
      return result.rejection?.code.startsWith("REAUTH_") ? "AUTH_REQUIRED" : "REJECTED";
  }
}

const RESULT_TEXT: Record<ControlCommandResult["status"], string> = {
  EXECUTED: "Executed and durably applied by ICOS.",
  FAILED: "Admitted, but the canonical authority refused the effect. Nothing changed.",
  UNKNOWN_EXECUTION_STATE: "Admitted; the outcome is not observable yet. Do not assume either way.",
  REJECTED: "Rejected by ICOS. Nothing changed.",
};

function fromResult(result: ControlCommandResult): Outcome {
  const detail = result.rejection
    ? `${result.rejection.code}: ${result.rejection.message}`
    : RESULT_TEXT[result.status];
  return { phase: phaseOfResult(result), detail, result };
}

function fromTransportError(
  reply: Exclude<Reply<unknown>, { kind: "ok" }>,
  mutation: boolean,
): Outcome {
  if (reply.kind === "not_connected")
    return {
      phase: "NOT_CONNECTED",
      detail: "The governed control API is not deployed here. Nothing was sent or executed.",
    };
  const text = `${reply.code}${reply.message ? `: ${reply.message}` : ""} (HTTP ${reply.status})`;
  if (reply.status === 503)
    return { phase: "UNAVAILABLE", detail: `Control plane unavailable — ${text}` };
  // A server crash after admission may have applied the effect.
  if (mutation && reply.status >= 500) return { phase: "UNKNOWN", detail: text };
  return { phase: "REJECTED", detail: text };
}

export function buildRequest(input: {
  type: ControlCommandType;
  target: ControlTarget;
  expectedVersion: number;
  reason: string;
  idempotencyKey: string;
  reauthProof?: string;
  confirmation?: string;
}): ControlCommandRequest {
  return controlCommandRequestSchema.parse({
    idempotencyKey: input.idempotencyKey,
    type: input.type,
    target: input.target,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
    ...(input.reauthProof ? { reauthProof: input.reauthProof } : {}),
    ...(riskOf(input.type) === "CRITICAL" ? { confirmation: input.confirmation ?? "" } : {}),
  });
}

export async function executeCommand(
  transport: ControlTransport,
  request: ControlCommandRequest,
): Promise<Outcome> {
  try {
    const reply = await transport.submit(request);
    return reply.kind === "ok" ? fromResult(reply.value) : fromTransportError(reply, true);
  } catch {
    return {
      phase: "UNKNOWN",
      detail:
        "The request left the device but no answer came back. Check server state before anything else.",
    };
  }
}

/**
 * Resolve an UNKNOWN outcome. With a command id, read the stored result. Without
 * one (the answer never arrived), resend the IDENTICAL request: the backend
 * dedupes on the idempotency key and returns the stored result (`replayed`)
 * instead of executing twice.
 */
export async function reconcileCommand(
  transport: ControlTransport,
  request: ControlCommandRequest,
  last?: ControlCommandResult,
): Promise<Outcome> {
  if (!last) return executeCommand(transport, request);
  try {
    const reply = await transport.get(last.commandId);
    return reply.kind === "ok" ? fromResult(reply.value) : fromTransportError(reply, true);
  } catch {
    return { phase: "UNKNOWN", detail: "Server state still unreachable. Do not act yet." };
  }
}

export async function reauthenticate(
  transport: ControlTransport,
  password: string,
): Promise<{ ok: true; proof: string; expiresAt: string } | { ok: false; outcome: Outcome }> {
  try {
    const reply = await transport.reauth(password);
    if (reply.kind === "ok") return { ok: true, ...reply.value };
    const outcome = fromTransportError(reply, false);
    return {
      ok: false,
      outcome:
        outcome.phase === "REJECTED" ? { phase: "AUTH_REQUIRED", detail: outcome.detail } : outcome,
    };
  } catch {
    return { ok: false, outcome: { phase: "UNAVAILABLE", detail: "ICOS is unreachable." } };
  }
}

/** Resending is only offered where the backend's idempotency makes it safe. */
export const mayReconcile = (outcome: Outcome | null) => outcome?.phase === "UNKNOWN";

// ------------------------------------------------------------------ runtime flags view

export const FLAG_LABEL: Record<keyof ControlState["runtime"]["effective"], string> = {
  safeMode: "Safe mode",
  dispatchEnabled: "New dispatch",
  integrationEnabled: "Integration",
  externalActionsEnabled: "External actions",
};

export interface FlagRow {
  key: keyof typeof FLAG_LABEL;
  label: string;
  effective: boolean;
  /** null = the stored row was unreadable; ICOS then runs fail-closed. */
  stored: boolean | null;
  /** "on" is only good news for the *Enabled flags; safe mode on is an alarm. */
  tone: "ok" | "critical" | "warn";
}

export function runtimeFlagRows(state: ControlState): FlagRow[] {
  const { stored, effective } = state.runtime;
  return (Object.keys(FLAG_LABEL) as (keyof typeof FLAG_LABEL)[]).map((key) => {
    const bad = key === "safeMode" ? effective[key] : !effective[key];
    const drift = stored !== null && stored[key] !== effective[key];
    return {
      key,
      label: FLAG_LABEL[key],
      effective: effective[key],
      stored: stored ? stored[key] : null,
      tone: bad ? "critical" : drift || stored === null ? "warn" : "ok",
    };
  });
}
