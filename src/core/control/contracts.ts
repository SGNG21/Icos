import { z } from "zod";

/**
 * Control-plane contract (decision 0043). PURE: no Next.js, Drizzle, PostgreSQL
 * or Better Auth. This is the typed surface the Control Center consumes.
 */

export const CONTROL_COMMAND_TYPES = [
  "PAUSE_MISSION",
  "RESUME_MISSION",
  "CANCEL_MISSION",
  "DISABLE_WORKER",
  "ENABLE_WORKER",
  "ENTER_SAFE_MODE",
  "EXIT_SAFE_MODE",
] as const;
export const controlCommandTypeSchema = z.enum(CONTROL_COMMAND_TYPES);
export type ControlCommandType = z.infer<typeof controlCommandTypeSchema>;

export const RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const riskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof riskClassSchema>;

export const controlTargetKindSchema = z.enum(["mission", "worker", "runtime"]);
export type ControlTargetKind = z.infer<typeof controlTargetKindSchema>;

/** The only runtime target: ICOS as a whole. */
export const RUNTIME_TARGET_ID = "global";

export const controlTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mission"), id: z.string().min(1).max(200) }),
  z.object({ kind: z.literal("worker"), id: z.string().uuid() }),
  z.object({ kind: z.literal("runtime"), id: z.literal(RUNTIME_TARGET_ID) }),
]);
export type ControlTarget = z.infer<typeof controlTargetSchema>;

/** Fixed, server-side specification of every command. The client cannot pick the risk. */
export const COMMAND_SPECS = {
  PAUSE_MISSION: { risk: "LOW", target: "mission" },
  RESUME_MISSION: { risk: "MEDIUM", target: "mission" },
  CANCEL_MISSION: { risk: "HIGH", target: "mission" },
  DISABLE_WORKER: { risk: "MEDIUM", target: "worker" },
  ENABLE_WORKER: { risk: "HIGH", target: "worker" },
  ENTER_SAFE_MODE: { risk: "MEDIUM", target: "runtime" },
  EXIT_SAFE_MODE: { risk: "CRITICAL", target: "runtime" },
} as const satisfies Record<ControlCommandType, { risk: RiskClass; target: ControlTargetKind }>;

/**
 * HTTP request body. No actor (bound from the session), no command id (derived
 * from actor + idempotencyKey), no risk (fixed by COMMAND_SPECS), no password.
 */
export const controlCommandRequestSchema = z
  .object({
    idempotencyKey: z.string().uuid(),
    type: controlCommandTypeSchema,
    target: controlTargetSchema,
    expectedVersion: z.number().int().min(0),
    reason: z.string().trim().min(3).max(500),
    /** Opaque token from POST /api/control/reauth. Required for HIGH and CRITICAL. */
    reauthProof: z.string().min(32).max(200).optional(),
    /** CRITICAL only: must equal the target's confirmation phrase exactly. */
    confirmation: z.string().max(200).optional(),
  })
  .strict();
export type ControlCommandRequest = z.infer<typeof controlCommandRequestSchema>;

export const REJECTION_CODES = [
  "FORBIDDEN",
  "TARGET_KIND_MISMATCH",
  "TARGET_NOT_FOUND",
  "VERSION_CONFLICT",
  "SESSION_TOO_OLD",
  "REAUTH_REQUIRED",
  "REAUTH_INVALID",
  "REAUTH_EXPIRED",
  "CONFIRMATION_REQUIRED",
  "INVALID_TRANSITION",
  "IDEMPOTENCY_KEY_REUSED",
  "CONTROL_STATE_UNAVAILABLE",
] as const;
export const rejectionCodeSchema = z.enum(REJECTION_CODES);
export type RejectionCode = z.infer<typeof rejectionCodeSchema>;

/**
 * EXECUTED: the effect is durably applied.
 * REJECTED: nothing changed (see rejection).
 * FAILED: admitted, but the canonical authority refused the effect; nothing changed.
 * UNKNOWN_EXECUTION_STATE: admitted, outcome not yet observable. Never retried implicitly.
 */
export const commandStatusSchema = z.enum(["EXECUTED", "REJECTED", "FAILED", "UNKNOWN_EXECUTION_STATE"]);
export type CommandStatus = z.infer<typeof commandStatusSchema>;

export const reauthStatusSchema = z.enum(["NOT_REQUIRED", "SATISFIED", "REQUIRED", "INVALID", "EXPIRED"]);
export type ReauthStatus = z.infer<typeof reauthStatusSchema>;

export const controlCommandResultSchema = z.object({
  commandId: z.string().uuid(),
  type: controlCommandTypeSchema,
  target: controlTargetSchema,
  riskClass: riskClassSchema,
  status: commandStatusSchema,
  reauth: reauthStatusSchema,
  rejection: z.object({ code: rejectionCodeSchema, message: z.string() }).nullable(),
  expectedVersion: z.number().int(),
  /** Current version after this command (null if the target has no version yet). */
  version: z.number().int().nullable(),
  auditEntryId: z.string().nullable(),
  /** True when this response is the stored result of an earlier identical request. */
  replayed: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ControlCommandResult = z.infer<typeof controlCommandResultSchema>;

export const runtimeFlagsSchema = z.object({
  safeMode: z.boolean(),
  dispatchEnabled: z.boolean(),
  integrationEnabled: z.boolean(),
  externalActionsEnabled: z.boolean(),
});
export type RuntimeFlags = z.infer<typeof runtimeFlagsSchema>;

export const controlStateSchema = z.object({
  runtime: z.object({
    /** Null when the flags row could not be read: everything is then effectively off. */
    stored: runtimeFlagsSchema.nullable(),
    effective: runtimeFlagsSchema,
    version: z.number().int().nullable(),
  }),
  missions: z.array(z.object({ id: z.string(), held: z.boolean(), version: z.number().int() })),
  workers: z.array(z.object({ id: z.string(), version: z.number().int() })),
});
export type ControlState = z.infer<typeof controlStateSchema>;

/** CRITICAL commands require the owner to type this exactly. */
export function confirmationPhrase(type: ControlCommandType, target: ControlTarget): string {
  return `${type} ${target.kind}:${target.id}`;
}
