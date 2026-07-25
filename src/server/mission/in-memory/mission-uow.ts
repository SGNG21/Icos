import { randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts";
import type { Mission, MissionResult, MissionStatus } from "@/core/mission";
import type { MissionRepository, MissionUnitOfWork } from "@/server/mission/ports";
import type { AuditRepository } from "@/server/repositories/ports";

/**
 * Unité de travail mémoire pour missions.
 *
 * Implémente les transitions avec section critique non interruptible
 * (pas d'await entre lecture, validation et écriture).
 */
export class InMemoryMissionUnitOfWork implements MissionUnitOfWork {
  constructor(
    private readonly missions: MissionRepository,
    private readonly audit: AuditRepository,
  ) {}

  async transitionStatus(input: {
    missionId: string;
    fromStatus: MissionStatus;
    toStatus: MissionStatus;
    auditEntry: AuditEntry;
  }): Promise<MissionResult<{ mission: Mission }>> {
    const mission = await this.missions.findById(input.missionId);
    if (!mission) {
      return { ok: false, reason: "not_found", message: "Mission introuvable" };
    }

    if (mission.status !== input.fromStatus) {
      return {
        ok: false,
        reason: "concurrent_modification",
        message: `Attendu ${input.fromStatus}, actuel ${mission.status}`,
      };
    }

    // Pas d'await entre update et audit (section critique mémoire)
    const updated = {
      ...mission,
      status: input.toStatus,
      updatedAt: new Date().toISOString(),
    };

    const saved = await this.missions.update(updated);
    await this.audit.append(input.auditEntry);

    return { ok: true, data: { mission: saved } };
  }
}
