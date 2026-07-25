import type { Mission, MissionStatus } from "@/core/mission";
import type { MissionRepository } from "@/server/mission/ports";

/**
 * Repository mémoire de missions.
 * Perd les données au redémarrage — suffisant pour D2 développement.
 * La persistance PostgreSQL viendra après validation du modèle.
 */
export class InMemoryMissionRepository implements MissionRepository {
  private readonly missions = new Map<string, Mission>();

  async create(mission: Mission): Promise<Mission> {
    this.missions.set(mission.id, { ...mission });
    return { ...mission };
  }

  async update(mission: Mission): Promise<Mission> {
    if (!this.missions.has(mission.id)) {
      throw new Error(`Mission ${mission.id} not found`);
    }
    this.missions.set(mission.id, { ...mission });
    return { ...mission };
  }

  async findById(id: string): Promise<Mission | null> {
    const m = this.missions.get(id);
    return m ? { ...m } : null;
  }

  async findByStatus(status: MissionStatus): Promise<Mission[]> {
    return Array.from(this.missions.values())
      .filter((m) => m.status === status)
      .map((m) => ({ ...m }));
  }

  async findActive(): Promise<Mission[]> {
    const terminals = new Set<MissionStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
    return Array.from(this.missions.values())
      .filter((m) => !terminals.has(m.status))
      .map((m) => ({ ...m }));
  }

  async findStaleBefore(olderThanMs: number): Promise<Mission[]> {
    const cutoff = Date.now() - olderThanMs;
    const terminals = new Set<MissionStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
    return Array.from(this.missions.values())
      .filter((m) => {
        if (terminals.has(m.status)) return false;
        const updated = new Date(m.updatedAt).getTime();
        return updated < cutoff;
      })
      .map((m) => ({ ...m }));
  }
}
