import { createHash, randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts";
import {
  COMMAND_SPECS,
  confirmationPhrase,
  type ControlCommandRequest,
  type ControlCommandResult,
  type ControlTarget,
  type ReauthStatus,
  type RejectionCode,
} from "@/core/control/contracts";
import {
  authRequirement,
  evaluateAuthFreshness,
  requiredPermission,
  type ProofCheck,
} from "@/core/control/policy";
import { hasPermission, type AuthenticatedSession } from "@/core/identity";
import { isValidMissionTransition } from "@/core/mission/machine";

import type { CommandRecord, ControlEffects, ControlStore, ControlTx } from "./ports";

/**
 * THE control command authority (decision 0044, BR-10/11/18/12).
 *
 * authenticate (caller) → validate (caller, Zod) → authorize → risk → auth
 * freshness / re-auth → idempotency → version lock → state validation →
 * admission → execution through the canonical authority → durable result +
 * audit → new version. Anything unexpected throws: nothing is ever reported
 * as executed unless it was.
 */

export interface CommandActor {
  session: AuthenticatedSession;
  /** Better Auth session id (never the token). */
  sessionId: string;
  sessionIssuedAt: Date;
}

export interface ControlCommandBusDeps {
  store: ControlStore;
  effects: ControlEffects;
  now?: () => Date;
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Deterministic, actor-scoped command id: same actor + same idempotency key ⇒ same command. */
export function deriveCommandId(actorUserId: string, idempotencyKey: string): string {
  const h = sha256(`icos-control:${actorUserId}:${idempotencyKey.toLowerCase()}`);
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Hash of the command's meaning. Auth evidence (proof, confirmation) is not part of it. */
export function requestHash(r: ControlCommandRequest): string {
  return sha256(JSON.stringify([r.type, r.target.kind, r.target.id, r.expectedVersion, r.reason]));
}

type Admission =
  | { kind: "done"; result: ControlCommandResult }
  | { kind: "admitted"; record: CommandRecord; target: ControlTarget; from?: string };

export class ControlCommandBus {
  private readonly now: () => Date;

  constructor(private readonly deps: ControlCommandBusDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async execute(
    actor: CommandActor,
    request: ControlCommandRequest,
  ): Promise<ControlCommandResult> {
    const commandId = deriveCommandId(actor.session.user.id, request.idempotencyKey);
    const admission = await this.deps.store.transaction(commandId, (tx) =>
      this.admit(tx, actor, request, commandId),
    );
    if (admission.kind === "done") return admission.result;
    return this.applyExternalEffect(admission.record, admission.target, admission.from);
  }

  /** Stored result of a command, reconciled against canonical state if it is still ADMITTED. */
  async get(actor: AuthenticatedSession, commandId: string): Promise<ControlCommandResult | null> {
    const record = await this.deps.store.getCommand(commandId);
    if (!record) return null;
    const privileged = actor.roles.some((r) => r === "owner" || r === "admin");
    if (record.actorUserId !== actor.user.id && !privileged) return null;
    if (record.status !== "ADMITTED") return toResult(record, true);
    return this.reconcile(record);
  }

  // ---------------------------------------------------------------- admission

  private async admit(
    tx: ControlTx,
    actor: CommandActor,
    request: ControlCommandRequest,
    commandId: string,
  ): Promise<Admission> {
    const now = this.now();
    const at = now.toISOString();
    const spec = COMMAND_SPECS[request.type];
    const hash = requestHash(request);
    const userId = actor.session.user.id;

    const existing = await tx.getCommand(commandId);
    if (existing) {
      if (existing.requestHash !== hash) {
        // A second, different command under an already-used key: refused and audited,
        // but the original record is untouched.
        const auditId = `ctl-${commandId}-reuse-${randomUUID()}`;
        await tx.appendAudit(
          auditEntry(auditId, "control.command.rejected", userId, at, {
            commandId,
            type: request.type,
            targetKind: request.target.kind,
            targetId: request.target.id,
            code: "IDEMPOTENCY_KEY_REUSED",
          }),
        );
        return {
          kind: "done",
          result: {
            ...toResult(existing, false),
            status: "REJECTED",
            rejection: {
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "This idempotency key was already used for a different command.",
            },
            auditEntryId: auditId,
          },
        };
      }
      return { kind: "done", result: toResult(existing, true) };
    }

    const record: CommandRecord = {
      commandId,
      actorUserId: userId,
      idempotencyKey: request.idempotencyKey,
      requestHash: hash,
      type: request.type,
      targetKind: request.target.kind,
      targetId: request.target.id,
      riskClass: spec.risk,
      reason: request.reason,
      expectedVersion: request.expectedVersion,
      status: "REJECTED",
      reauth: authRequirement(spec.risk).reauth ? "REQUIRED" : "NOT_REQUIRED",
      rejectionCode: null,
      rejectionMessage: null,
      version: null,
      auditEntryId: null,
      createdAt: at,
      completedAt: null,
    };

    const reject = async (
      code: RejectionCode,
      message: string,
      extra: Partial<CommandRecord> = {},
    ): Promise<Admission> => {
      const final: CommandRecord = {
        ...record,
        ...extra,
        status: "REJECTED",
        rejectionCode: code,
        rejectionMessage: message,
        auditEntryId: `ctl-${commandId}-rejected`,
        completedAt: at,
      };
      await tx.saveCommand(final);
      await tx.appendAudit(
        auditEntry(final.auditEntryId!, "control.command.rejected", userId, at, details(final)),
      );
      return { kind: "done", result: toResult(final, false) };
    };

    const target = request.target;
    if (target.kind !== spec.target) {
      return reject("TARGET_KIND_MISMATCH", `${request.type} targets a ${spec.target}.`);
    }
    if (!hasPermission(actor.session.roles, requiredPermission(request.type))) {
      return reject("FORBIDDEN", `Missing permission ${requiredPermission(request.type)}.`);
    }

    // Target existence + operational scope (out of scope is indistinguishable from unknown).
    const mission =
      target.kind === "mission" ? await this.deps.effects.readMission(target.id) : null;
    const worker = target.kind === "worker" ? await this.deps.effects.readWorker(target.id) : null;
    if (
      target.kind === "mission" &&
      (!mission || !(await this.deps.effects.missionInScope(target.id, actor.session)))
    ) {
      return reject("TARGET_NOT_FOUND", "Mission not found.");
    }
    if (target.kind === "worker" && !worker) return reject("TARGET_NOT_FOUND", "Worker not found.");

    // Authentication freshness / re-auth / typed confirmation.
    const requirement = authRequirement(spec.risk);
    const proofHash = request.reauthProof ? sha256(request.reauthProof) : null;
    const proof: ProofCheck =
      requirement.reauth && proofHash
        ? await tx.checkProof(proofHash, userId, actor.sessionId, now)
        : "missing";
    const freshness = evaluateAuthFreshness({
      risk: spec.risk,
      sessionIssuedAt: actor.sessionIssuedAt,
      now,
      proof,
      confirmationOk: request.confirmation === confirmationPhrase(request.type, target),
    });
    if (!freshness.ok) {
      return reject(freshness.code, rejectionMessage(freshness.code, request.type, target), {
        reauth: freshness.reauth,
      });
    }
    record.reauth = freshness.reauth;

    // BR-11: optimistic concurrency on the durable target version, under a row lock.
    const version = await tx.lockVersion(target.kind, target.id);
    if (version !== request.expectedVersion) {
      return reject(
        "VERSION_CONFLICT",
        `Target is at version ${version}, not ${request.expectedVersion}.`,
        { version },
      );
    }

    // State validation against canonical + control state.
    let from: string | undefined;
    switch (request.type) {
      case "PAUSE_MISSION":
        if (["succeeded", "failed", "cancelled"].includes(mission!.status))
          return reject("INVALID_TRANSITION", `Mission is ${mission!.status}.`, { version });
        if (await tx.isHeld(target.id))
          return reject("INVALID_TRANSITION", "Mission is already paused.", { version });
        break;
      case "RESUME_MISSION":
        if (!(await tx.isHeld(target.id)))
          return reject("INVALID_TRANSITION", "Mission is not paused.", { version });
        break;
      case "CANCEL_MISSION":
        if (!isValidMissionTransition(mission!.status, "cancelled"))
          return reject("INVALID_TRANSITION", `A ${mission!.status} mission cannot be cancelled.`, {
            version,
          });
        from = mission!.status;
        break;
      case "DISABLE_WORKER":
        if (worker!.status !== "active")
          return reject("INVALID_TRANSITION", `Worker is ${worker!.status}.`, { version });
        break;
      case "ENABLE_WORKER":
        if (worker!.status === "active")
          return reject("INVALID_TRANSITION", "Worker is already active.", { version });
        break;
      case "ENTER_SAFE_MODE":
        if ((await tx.getFlags()).safeMode)
          return reject("INVALID_TRANSITION", "Safe mode is already on.", { version });
        break;
      case "EXIT_SAFE_MODE":
        if (!(await tx.getFlags()).safeMode)
          return reject("INVALID_TRANSITION", "Safe mode is off.", { version });
        break;
    }

    // Single-use proof, consumed only by an admitted command.
    if (requirement.reauth && !(await tx.consumeProof(proofHash!, at))) {
      return reject("REAUTH_INVALID", "Re-authentication proof was already used.", {
        version,
        reauth: "INVALID",
      });
    }

    const newVersion = version + 1;
    await tx.setVersion(target.kind, target.id, newVersion);

    // Control-plane effects: applied atomically with the record, audit and version.
    const internal = await this.applyInternalEffect(tx, request.type, target.id, commandId, at);
    if (internal) {
      const final: CommandRecord = {
        ...record,
        status: "EXECUTED",
        version: newVersion,
        auditEntryId: `ctl-${commandId}-executed`,
        completedAt: at,
      };
      await tx.saveCommand(final);
      await tx.appendAudit(
        auditEntry(final.auditEntryId!, "control.command.executed", userId, at, details(final)),
      );
      return { kind: "done", result: toResult(final, false) };
    }

    // Canonical-authority effects: record ADMITTED first, act after commit.
    const admitted: CommandRecord = {
      ...record,
      status: "ADMITTED",
      version: newVersion,
      auditEntryId: `ctl-${commandId}-admitted`,
    };
    await tx.saveCommand(admitted);
    await tx.appendAudit(
      auditEntry(admitted.auditEntryId!, "control.command.admitted", userId, at, details(admitted)),
    );
    return { kind: "admitted", record: admitted, target, from };
  }

  private async applyInternalEffect(
    tx: ControlTx,
    type: ControlCommandRequest["type"],
    targetId: string,
    commandId: string,
    at: string,
  ): Promise<boolean> {
    switch (type) {
      case "PAUSE_MISSION":
        await tx.setHold(targetId, commandId, at);
        return true;
      case "RESUME_MISSION":
        await tx.clearHold(targetId);
        return true;
      case "ENTER_SAFE_MODE":
        await tx.setFlags({ ...(await tx.getFlags()), safeMode: true }, commandId, at);
        return true;
      case "EXIT_SAFE_MODE":
        await tx.setFlags({ ...(await tx.getFlags()), safeMode: false }, commandId, at);
        return true;
      default:
        return false;
    }
  }

  // ---------------------------------------------------------------- execution

  private async applyExternalEffect(
    record: CommandRecord,
    target: ControlTarget,
    from?: string,
  ): Promise<ControlCommandResult> {
    let applied: boolean;
    try {
      switch (record.type) {
        case "CANCEL_MISSION":
          applied = await this.deps.effects.cancelMission(target.id, from as never);
          break;
        case "DISABLE_WORKER":
          await this.deps.effects.disableWorker(target.id);
          applied = true;
          break;
        case "ENABLE_WORKER":
          await this.deps.effects.enableWorker(target.id);
          applied = true;
          break;
        default:
          throw new Error(`UNEXPECTED_EXTERNAL_EFFECT ${record.type}`);
      }
    } catch {
      // The effect may or may not have happened. No implicit retry: GET reconciles.
      return { ...toResult(record, false), status: "UNKNOWN_EXECUTION_STATE" };
    }
    return this.complete(record, applied ? "EXECUTED" : "FAILED", false);
  }

  private async complete(
    record: CommandRecord,
    status: "EXECUTED" | "FAILED",
    replayed: boolean,
  ): Promise<ControlCommandResult> {
    const at = this.now().toISOString();
    return this.deps.store.transaction(record.commandId, async (tx) => {
      const current = await tx.getCommand(record.commandId);
      if (!current || current.status !== "ADMITTED") return toResult(current ?? record, true);
      const final: CommandRecord = {
        ...current,
        status,
        rejectionCode: status === "FAILED" ? "INVALID_TRANSITION" : null,
        rejectionMessage:
          status === "FAILED" ? "The target changed state before the command could apply." : null,
        auditEntryId: `ctl-${record.commandId}-${status.toLowerCase()}`,
        completedAt: at,
      };
      await tx.saveCommand(final);
      await tx.appendAudit(
        auditEntry(
          final.auditEntryId!,
          status === "EXECUTED" ? "control.command.executed" : "control.command.failed",
          final.actorUserId,
          at,
          details(final),
        ),
      );
      return toResult(final, replayed);
    });
  }

  /** Observes canonical state for an ADMITTED command. Never re-executes the effect. */
  private async reconcile(record: CommandRecord): Promise<ControlCommandResult> {
    let observed = false;
    try {
      if (record.type === "CANCEL_MISSION") {
        observed = (await this.deps.effects.readMission(record.targetId))?.status === "cancelled";
      } else if (record.type === "DISABLE_WORKER") {
        observed = (await this.deps.effects.readWorker(record.targetId))?.status === "inactive";
      } else if (record.type === "ENABLE_WORKER") {
        observed = (await this.deps.effects.readWorker(record.targetId))?.status === "active";
      }
    } catch {
      observed = false;
    }
    if (observed) return this.complete(record, "EXECUTED", true);
    return { ...toResult(record, true), status: "UNKNOWN_EXECUTION_STATE" };
  }
}

// ---------------------------------------------------------------- helpers

function rejectionMessage(
  code: RejectionCode,
  type: ControlCommandRequest["type"],
  target: ControlTarget,
): string {
  switch (code) {
    case "SESSION_TOO_OLD":
      return "This command needs a session younger than 12 hours. Sign in again.";
    case "REAUTH_REQUIRED":
      return "This command needs a fresh re-authentication proof (POST /api/control/reauth).";
    case "REAUTH_INVALID":
      return "The re-authentication proof is not valid for this session.";
    case "REAUTH_EXPIRED":
      return "The re-authentication proof expired. Re-authenticate again.";
    case "CONFIRMATION_REQUIRED":
      return `Type exactly: ${confirmationPhrase(type, target)}`;
    default:
      return code;
  }
}

function details(r: CommandRecord): Record<string, string | number | null> {
  return {
    commandId: r.commandId,
    type: r.type,
    targetKind: r.targetKind,
    targetId: r.targetId,
    riskClass: r.riskClass,
    reason: r.reason,
    status: r.status,
    code: r.rejectionCode,
    expectedVersion: r.expectedVersion,
    version: r.version,
    reauth: r.reauth,
  };
}

function auditEntry(
  id: string,
  eventType: AuditEntry["eventType"],
  userId: string,
  at: string,
  detail: Record<string, string | number | null>,
): AuditEntry {
  return {
    id,
    eventType,
    actor: { kind: "human", id: userId },
    details: detail,
    occurredAt: at,
    createdAt: at,
  };
}

export function toResult(r: CommandRecord, replayed: boolean): ControlCommandResult {
  return {
    commandId: r.commandId,
    type: r.type,
    target: { kind: r.targetKind, id: r.targetId } as ControlTarget,
    riskClass: r.riskClass,
    status: r.status === "ADMITTED" ? "UNKNOWN_EXECUTION_STATE" : r.status,
    reauth: r.reauth as ReauthStatus,
    rejection: r.rejectionCode
      ? { code: r.rejectionCode, message: r.rejectionMessage ?? r.rejectionCode }
      : null,
    expectedVersion: r.expectedVersion,
    version: r.version,
    auditEntryId: r.auditEntryId,
    replayed,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}
