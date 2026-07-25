import { randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts";
import type { AuditRepository } from "@/server/repositories/ports";
import {
  isTransitionAllowed,
  isTerminal,
  isSuspended,
  type Mission,
  type MissionResult,
  type MissionStatus,
  type Plan,
  type Run,
} from "@/core/mission";
import type {
  CreateMissionInput,
  TransitionStatusInput,
  AddRunInput,
  SetPlanInput,
} from "@/core/mission/contract";
import type { MissionRepository, MissionUnitOfWork } from "./ports";

/**
 * Service D2 Mission — orchestrateur central.
 *
 * INVARIANTS :
 * - Toute mutation passe par le repository (persistance)
 * - Le contexte Claude n'est jamais la source de vérité
 * - Les transitions illégales sont refusées (fail-closed)
 * - Les missions sont toujours créées avec un tenantId
 * - Les missions terminées sont immutables
 */
export class MissionService {
  constructor(
    private readonly missions: MissionRepository,
    private readonly audit: AuditRepository,
    private readonly missionUow?: MissionUnitOfWork,
  ) {}

  /**
   * Crée une mission. Statut initial : CREATED.
   */
  async createMission(input: CreateMissionInput): Promise<MissionResult<Mission>> {
    const now = new Date().toISOString();
    const mission: Mission = {
      id: `mission-${randomUUID()}`,
      tenantId: input.tenantId,
      userRequest: input.userRequest,
      status: "CREATED",
      runs: [],
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.missions.create(mission);

    await this.audit.append({
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "mission.created",
      actor: { kind: "system", id: "d2-mission-service" },
      details: { missionId: mission.id, tenantId: mission.tenantId },
    });

    return { ok: true, data: created };
  }

  /**
   * Transitionne l'état d'une mission avec validation.
   */
  async transitionStatus(input: TransitionStatusInput): Promise<MissionResult<Mission>> {
    const mission = await this.missions.findById(input.missionId);
    if (!mission) {
      return { ok: false, reason: "not_found", message: "Mission introuvable" };
    }

    if (isTerminal(mission.status)) {
      return {
        ok: false,
        reason: "terminal",
        message: `Mission déjà terminée (${mission.status})`,
      };
    }

    if (!isTransitionAllowed(mission.status, input.targetStatus)) {
      return {
        ok: false,
        reason: "invalid_transition",
        message: `Transition ${mission.status} → ${input.targetStatus} non autorisée`,
      };
    }

    // Validation spécifique aux transitions.
    if (
      input.targetStatus === "WAITING_FOR_APPROVAL" &&
      isSuspended(mission.status)
    ) {
      return {
        ok: false,
        reason: "already_suspended",
        message: `Mission déjà suspendue (${mission.status})`,
      };
    }

    const now = new Date().toISOString();
    const isTerminalTarget = input.targetStatus === "COMPLETED" || input.targetStatus === "FAILED" || input.targetStatus === "CANCELLED";

    const auditEntry: AuditEntry = {
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "mission.transitioned",
      actor: { kind: "system", id: input.actorLabel },
      details: {
        missionId: mission.id,
        fromStatus: mission.status,
        toStatus: input.targetStatus,
        reason: input.reason ?? null,
      },
    };

    if (this.missionUow) {
      const result = await this.missionUow.transitionStatus({
        missionId: mission.id,
        fromStatus: mission.status,
        toStatus: input.targetStatus as MissionStatus,
        auditEntry,
      });
      if (!result.ok) return result;
      return { ok: true, data: result.data.mission };
    }

    // Fallback direct : mettre à jour la mission avec toutes ses métadonnées sans UoW.
    const saved = await this.missions.update({
      ...mission,
      status: input.targetStatus as MissionStatus,
      error: input.reason ?? mission.error,
      approvedBy: input.approvedBy ?? mission.approvedBy,
      updatedAt: now,
      completedAt: isTerminalTarget ? now : mission.completedAt,
    });
    await this.audit.append(auditEntry);
    return { ok: true, data: saved };
  }

  /**
   * Assigne un plan à une mission.
   */
  async setPlan(input: SetPlanInput): Promise<MissionResult<Mission>> {
    const mission = await this.missions.findById(input.missionId);
    if (!mission) {
      return { ok: false, reason: "not_found", message: "Mission introuvable" };
    }

    if (mission.status !== "PLANNING") {
      return {
        ok: false,
        reason: "invalid_state",
        message: `Impossible d'assigner un plan en état ${mission.status}`,
      };
    }

    const now = new Date().toISOString();
    const updated = {
      ...mission,
      plan: input.plan,
      status: "PLANNED" as MissionStatus,
      updatedAt: now,
    };

    const saved = await this.missions.update(updated);

    await this.audit.append({
      id: `audit-${randomUUID()}`,
      occurredAt: now,
      eventType: "mission.plan_set",
      actor: { kind: "system", id: input.actorLabel },
      details: {
        missionId: mission.id,
        stepCount: input.plan.steps.length,
        description: input.plan.description,
      },
    });

    return { ok: true, data: saved };
  }

  /**
   * Ajoute un run à une mission.
   */
  async addRun(input: AddRunInput): Promise<MissionResult<Run>> {
    const mission = await this.missions.findById(input.missionId);
    if (!mission) {
      return { ok: false, reason: "not_found", message: "Mission introuvable" };
    }

    if (!mission.plan) {
      return { ok: false, reason: "no_plan", message: "Mission sans plan" };
    }

    if (input.stepIndex < 0 || input.stepIndex >= mission.plan.steps.length) {
      return {
        ok: false,
        reason: "invalid_step",
        message: `Step index ${input.stepIndex} hors limites (0-${mission.plan.steps.length - 1})`,
      };
    }

    const now = new Date().toISOString();
    const run: Run = {
      id: `run-${randomUUID()}`,
      missionId: input.missionId,
      stepIndex: input.stepIndex,
      startedAt: now,
      status: "in_progress",
    };

    const updated = {
      ...mission,
      runs: [...mission.runs, run],
      currentRunId: run.id,
      updatedAt: now,
    };

    await this.missions.update(updated);

    return { ok: true, data: run };
  }

  /**
   * Récupère une mission par ID.
   */
  async getMission(id: string): Promise<Mission | null> {
    return this.missions.findById(id);
  }

  /**
   * Récupère les missions actives (non terminales).
   */
  async getActiveMissions(): Promise<Mission[]> {
    return this.missions.findActive();
  }

  /**
   * Récupère les missions suspendues (en attente d'événement externe).
   */
  async getSuspendedMissions(): Promise<Mission[]> {
    const all = await this.missions.findActive();
    return all.filter((m) => isSuspended(m.status));
  }
}
