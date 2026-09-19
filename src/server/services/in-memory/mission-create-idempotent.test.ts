import { describe, expect, it } from "vitest";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";

const repo = () => new InMemoryMissionRepository(new InMemoryTaskRepository(new InMemoryAuditLog(), []));

describe("MissionRepository.create with an imposed id (idempotent)", () => {
  it("creates the mission under the given id, and replays return the same mission", async () => {
    const missions = repo();
    const first = await missions.create({ id: "mission-fixed", title: "T", objective: "O", tasks: [] });
    const replay = await missions.create({ id: "mission-fixed", title: "T", objective: "O", tasks: [] });
    expect(first.id).toBe("mission-fixed");
    expect(replay).toEqual(first);
    expect(await missions.list()).toHaveLength(1);
  });

  it("refuses to reuse an id for a different mission, and only supports an empty graph", async () => {
    const missions = repo();
    await missions.create({ id: "m1", title: "T", objective: "O", tasks: [] });
    await expect(missions.create({ id: "m1", title: "T2", objective: "O", tasks: [] })).rejects.toThrow(
      "MISSION_ID_CONFLICT",
    );
    await expect(
      missions.create({
        id: "m2",
        title: "T",
        objective: "O",
        tasks: [{ title: "a", description: "a", dependsOn: [], workerKind: "agent" }],
      }),
    ).rejects.toThrow("MISSION_CREATE_ID_REQUIRES_EMPTY_GRAPH");
  });

  it("concurrent creates with the same id yield exactly one mission", async () => {
    const missions = repo();
    await Promise.all(
      Array.from({ length: 5 }, () => missions.create({ id: "m3", title: "T", objective: "O", tasks: [] })),
    );
    expect(await missions.list()).toHaveLength(1);
  });
});
