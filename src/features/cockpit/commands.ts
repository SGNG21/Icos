import { z } from "zod";

/**
 * Governed control commands — frontend contract (C6).
 *
 * The cockpit never mutates ICOS state itself. Every control produces ONE
 * `ControlCommand` that the backend command bus (BR-10) must run through
 * authorization → policy → risk → state validation → execution → audit.
 * Until that bus exists the transport is `notWiredTransport`: controls show
 * their confirmation preview, then report NOT YET WIRED — never fake success.
 *
 * Risk classes here drive CONFIRMATION UX only. The backend stays authoritative
 * and may demand more (re-auth, escalation) than the UI anticipated.
 */
export const RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];

export const COMMAND_ACTIONS = {
  "worker.pause": { risk: "LOW", label: "Pause" },
  "worker.resume": { risk: "LOW", label: "Resume" },
  "worker.retry": { risk: "MEDIUM", label: "Retry" },
  "worker.stop": { risk: "MEDIUM", label: "Stop" },
  "mission.pause": { risk: "LOW", label: "Pause" },
  "mission.resume": { risk: "LOW", label: "Resume" },
  "mission.change_priority": { risk: "LOW", label: "Change priority" },
  "mission.stop": { risk: "MEDIUM", label: "Stop" },
  // Emergency controls reduce risk, so they must stay reachable under stress:
  // explicit confirmation, no re-auth. Loosening them (exit safe mode) is HIGH.
  "system.pause_new_work": { risk: "MEDIUM", label: "Pause new work" },
  "system.freeze_integrations": { risk: "MEDIUM", label: "Freeze integrations" },
  "system.lock_self_modification": { risk: "MEDIUM", label: "Lock self-modification" },
  "system.enter_safe_mode": { risk: "MEDIUM", label: "Enter safe mode" },
  "system.stop_external_workers": { risk: "HIGH", label: "Stop external workers" },
  "system.exit_safe_mode": { risk: "HIGH", label: "Exit safe mode" },
} as const satisfies Record<string, { risk: RiskClass; label: string }>;
export type CommandAction = keyof typeof COMMAND_ACTIONS;

export const controlCommandSchema = z.object({
  commandId: z.string().uuid(),
  intent: z.string().min(1).max(500),
  target: z.object({
    kind: z.enum(["worker", "mission", "task", "system", "provider"]),
    id: z.string().min(1),
    label: z.string().min(1),
  }),
  action: z.enum(Object.keys(COMMAND_ACTIONS) as [CommandAction, ...CommandAction[]]),
  riskClass: z.enum(RISK_CLASSES),
  issuedAt: z.string().datetime(),
  /** Stable across resubmissions of the SAME command: the server dedupes on it. */
  idempotencyKey: z.string().uuid(),
  /** Version of the target the owner was looking at. `null` = backend exposes none yet (BR-11). */
  expectedStateVersion: z.string().nullable(),
});
/**
 * `actor` is deliberately absent: the server binds it from the authenticated
 * session. A client-asserted actor would be a forgeable identity.
 */
export type ControlCommand = z.infer<typeof controlCommandSchema>;

export function createCommand(
  input: {
    action: CommandAction;
    target: ControlCommand["target"];
    intent?: string;
    expectedStateVersion?: string | null;
  },
  now: Date = new Date(),
  uuid: () => string = () => crypto.randomUUID(),
): ControlCommand {
  const spec = COMMAND_ACTIONS[input.action];
  return controlCommandSchema.parse({
    commandId: uuid(),
    intent: input.intent ?? `${spec.label} ${input.target.label}`,
    target: input.target,
    action: input.action,
    riskClass: spec.risk,
    issuedAt: now.toISOString(),
    idempotencyKey: uuid(),
    expectedStateVersion: input.expectedStateVersion ?? null,
  });
}

export type ConfirmationPolicy =
  { kind: "single" } | { kind: "explicit" } | { kind: "typed_reauth" } | { kind: "escalation" };

export function confirmationPolicy(risk: RiskClass): ConfirmationPolicy {
  switch (risk) {
    case "LOW":
      return { kind: "single" };
    case "MEDIUM":
      return { kind: "explicit" };
    case "HIGH":
      return { kind: "typed_reauth" };
    case "CRITICAL":
      return { kind: "escalation" };
  }
}

export interface ConfirmationInput {
  acknowledged: boolean;
  typed: string;
  /** Step-up re-authentication proof. Never true until BR-18 exists. */
  reauthenticated: boolean;
}

/** Whether the UI may send the command. CRITICAL never executes from the UI. */
export function canSubmit(command: ControlCommand, input: ConfirmationInput): boolean {
  const policy = confirmationPolicy(command.riskClass);
  switch (policy.kind) {
    case "single":
      return true;
    case "explicit":
      return input.acknowledged;
    case "typed_reauth":
      return (
        input.acknowledged && input.typed.trim() === command.target.label && input.reauthenticated
      );
    case "escalation":
      return false;
  }
}

export type CommandStatus =
  | "accepted"
  | "executed"
  | "rejected"
  | "requires_reauth"
  | "not_wired"
  /** Request may or may not have executed (timeout, dropped connection). */
  | "unknown_execution_state"
  /** Reconciliation proved the server never received it: resubmit is safe. */
  | "not_received";

export interface CommandOutcome {
  status: CommandStatus;
  detail?: string;
}

export interface CommandTransport {
  /** Throws on network failure / timeout — the caller cannot know what happened. */
  submit(command: ControlCommand): Promise<CommandOutcome>;
  status(commandId: string): Promise<CommandOutcome | "not_found">;
}

export const notWiredTransport: CommandTransport = {
  async submit() {
    return {
      status: "not_wired",
      detail: "The governed command bus does not exist yet (BR-10). Nothing was executed.",
    };
  },
  async status() {
    return "not_found";
  },
};

export async function submitCommand(
  transport: CommandTransport,
  command: ControlCommand,
): Promise<CommandOutcome> {
  try {
    return await transport.submit(command);
  } catch {
    return {
      status: "unknown_execution_state",
      detail:
        "The request left the device but no answer came back. Checking server state before any retry.",
    };
  }
}

/** Query server state for an ambiguous command. Never resubmits by itself. */
export async function reconcileCommand(
  transport: CommandTransport,
  command: ControlCommand,
): Promise<CommandOutcome> {
  try {
    const found = await transport.status(command.commandId);
    return found === "not_found"
      ? {
          status: "not_received",
          detail: "The server has no record of this command. It is safe to send it again.",
        }
      : found;
  } catch {
    return {
      status: "unknown_execution_state",
      detail: "Server state still unreachable. Do not retry yet.",
    };
  }
}

/** Resubmission is allowed only once the server proved it never got the command. */
export function mayResubmit(outcome: CommandOutcome | null): boolean {
  return outcome?.status === "not_received";
}
