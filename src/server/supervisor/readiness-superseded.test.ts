import { describe, expect, it } from "vitest";

import type { Mission, MissionTask } from "@/core/mission/contracts";
import { computeReadyTasks } from "@/server/supervisor/readiness";

/*
 * Decision 0029 invariant lock.
 *
 * replacePlan preserves replaced work as `superseded` instead of deleting the
 * rows. That only stays safe while NOTHING treats a superseded MissionTask as
 * runnable or as a satisfied dependency. These tests pin that contract so a
 * future edit to the readiness deny-list cannot silently resurrect replaced
 * work or unlock a task whose dependency was never actually completed.
 */

const mission: Mission = {
  id: "m-1",
  title: "Mission",
  objective: "Objective",
  status: "running",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const task = (
  over: Partial<MissionTask> & Pick<MissionTask, "id" | "status">,
): MissionTask => ({
  missionId: mission.id,
  title: `Task ${over.id}`,
  description: null,
  dependsOn: [],
  workerKind: null,
  capability: null,
  taskId: `task-${over.id}`,
  ...over,
});

describe("readiness — superseded tasks (decision 0029)", () => {
  it("never reports a superseded task as ready", () => {
    const ready = computeReadyTasks(mission, [
      task({ id: "replaced", status: "superseded" }),
    ]);

    expect(ready).toEqual([]);
  });

  it("does not let a superseded dependency unlock a downstream task", () => {
    /*
     * The dependency was replaced, not completed. Treating `superseded` as
     * satisfied would advance the DAG past work that never produced a result.
     */
    const ready = computeReadyTasks(mission, [
      task({ id: "dep", status: "superseded" }),
      task({
        id: "downstream",
        status: "draft",
        dependsOn: ["dep"],
      }),
    ]);

    expect(ready).toEqual([]);
  });

  it("still unlocks a downstream task whose dependency genuinely succeeded", () => {
    const ready = computeReadyTasks(mission, [
      task({ id: "dep", status: "succeeded" }),
      task({
        id: "downstream",
        status: "draft",
        dependsOn: ["dep"],
      }),
    ]);

    expect(ready.map((t) => t.id)).toEqual(["downstream"]);
  });

  it("dispatches only the replacement when a replan leaves superseded history behind", () => {
    /*
     * The shape replacePlan produces: succeeded history preserved, replaced
     * work superseded, the new plan's task inserted as draft.
     */
    const ready = computeReadyTasks(mission, [
      task({ id: "kept", status: "succeeded" }),
      task({ id: "abandoned", status: "superseded" }),
      task({ id: "replacement", status: "draft" }),
    ]);

    expect(ready.map((t) => t.id)).toEqual(["replacement"]);
  });

  it("reports nothing ready once only succeeded and superseded work remains", () => {
    /*
     * This is the state the supervisor reads as mission success:
     *   tasks.every(t => t.status === "succeeded" || t.status === "superseded")
     * Readiness must be empty so the mission is not kept alive by history.
     */
    const tasks = [
      task({ id: "kept", status: "succeeded" }),
      task({ id: "abandoned", status: "superseded" }),
    ];

    expect(computeReadyTasks(mission, tasks)).toEqual([]);
    expect(
      tasks.every(
        (t) =>
          t.status === "succeeded" ||
          t.status === "superseded",
      ),
    ).toBe(true);
  });
});
