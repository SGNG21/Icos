import type { RuntimeFlags } from "@/core/control/contracts";
import { effectiveFlags } from "@/core/control/policy";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "@/server/execution/ports";

import type { ControlStore } from "./ports";

/**
 * Runtime enforcement of control state (decision 0044). Read-only: it never
 * changes flags or holds — only the command bus does.
 *
 * FAIL CLOSED: an unreadable flags row means nothing may start; an unreadable
 * hold means the mission is held.
 */
export type HoldReason =
  | "SAFE_MODE"
  | "DISPATCH_DISABLED"
  | "INTEGRATION_DISABLED"
  | "EXTERNAL_ACTIONS_DISABLED"
  | "MISSION_HELD"
  | "CONTROL_STATE_UNAVAILABLE";

export type ControlDecision = { allowed: true } | { allowed: false; reason: HoldReason };

export class ControlHeldError extends Error {
  readonly code = "CONTROL_HELD";
  constructor(
    readonly reason: HoldReason,
    readonly what: string,
  ) {
    super(`CONTROL_HELD: ${what} refused (${reason})`);
    this.name = "ControlHeldError";
  }
}

export function isControlHeld(error: unknown): error is ControlHeldError {
  return error instanceof ControlHeldError;
}

export class RuntimeControlGuard {
  constructor(private readonly store: Pick<ControlStore, "readFlags" | "isHeld">) {}

  /** Stored flags (null = unreadable) and the effective ones after fail-closed rules. */
  async flags(): Promise<{ stored: RuntimeFlags | null; effective: RuntimeFlags }> {
    let stored: RuntimeFlags | null = null;
    try {
      stored = await this.store.readFlags();
    } catch {
      stored = null;
    }
    return { stored, effective: effectiveFlags(stored) };
  }

  private async flagDecision(
    pick: (f: RuntimeFlags) => boolean,
    disabled: HoldReason,
  ): Promise<ControlDecision> {
    const { stored, effective } = await this.flags();
    if (!stored) return { allowed: false, reason: "CONTROL_STATE_UNAVAILABLE" };
    if (effective.safeMode) return { allowed: false, reason: "SAFE_MODE" };
    return pick(effective) ? { allowed: true } : { allowed: false, reason: disabled };
  }

  /** May NEW work be dispatched (optionally: for this mission)? */
  async dispatch(missionId?: string): Promise<ControlDecision> {
    const flags = await this.flagDecision((f) => f.dispatchEnabled, "DISPATCH_DISABLED");
    if (!flags.allowed || !missionId) return flags;
    try {
      return (await this.store.isHeld(missionId))
        ? { allowed: false, reason: "MISSION_HELD" }
        : flags;
    } catch {
      return { allowed: false, reason: "CONTROL_STATE_UNAVAILABLE" };
    }
  }

  /** May a canonical integration DECISION be made? */
  integration(): Promise<ControlDecision> {
    return this.flagDecision((f) => f.integrationEnabled, "INTEGRATION_DISABLED");
  }

  /** May an irreversible side effect outside ICOS happen? */
  externalAction(): Promise<ControlDecision> {
    return this.flagDecision((f) => f.externalActionsEnabled, "EXTERNAL_ACTIONS_DISABLED");
  }
}

/**
 * THE guard every irreversible external executor must call before acting:
 * external APIs, messages, deployments, publishing, spend, customer-system
 * writes. Throws ControlHeldError when external actions are not allowed.
 */
export async function assertExternalActionAllowed(
  guard: Pick<RuntimeControlGuard, "externalAction">,
  action: string,
): Promise<void> {
  const decision = await guard.externalAction();
  if (!decision.allowed) throw new ControlHeldError(decision.reason, action);
}

/** Marks a dispatcher whose `dispatch` goes through the control backstop. */
export const CONTROL_BACKSTOP = Symbol.for("icos.control.dispatch-backstop");

/**
 * Last line of defence on the container's dispatcher. Every admission point
 * holds work BEFORE reaching here; this only fires for a path that missed its
 * admission guard, and then refuses rather than dispatches.
 *
 * Installed IN PLACE (the instance keeps its class) rather than as a wrapper:
 * the dispatcher's concrete identity — Temporal vs runtime router — is part of
 * what CORE3 certifies about the production graph, and a control layer must not
 * change that fact. Idempotent.
 */
export function installDispatchBackstop<T extends TaskExecutionDispatcher>(
  dispatcher: T,
  guard: Pick<RuntimeControlGuard, "dispatch">,
): T {
  if (hasDispatchBackstop(dispatcher)) return dispatcher;
  const original = dispatcher.dispatch.bind(dispatcher);
  const gated = async (
    input: TaskExecutionDispatchInput,
    digitalosFacadePath?: string,
  ): Promise<TaskExecutionDispatchResult> => {
    const decision = await guard.dispatch(input.missionId);
    if (!decision.allowed)
      throw new ControlHeldError(decision.reason, `dispatch of task ${input.taskId}`);
    return original(input, digitalosFacadePath);
  };
  Object.defineProperty(dispatcher, "dispatch", {
    value: gated,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(dispatcher, CONTROL_BACKSTOP, { value: true });
  return dispatcher;
}

export function hasDispatchBackstop(dispatcher: TaskExecutionDispatcher): boolean {
  return (dispatcher as unknown as Record<symbol, unknown>)[CONTROL_BACKSTOP] === true;
}
