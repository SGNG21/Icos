import { describe, expect, it } from "vitest";

import type { Mission, MissionTask } from "@/core/mission/contracts";
import {
  CANONICAL_COMPLETION_STATUS,
  READY_ELIGIBLE_STATUSES,
  computeReadyTasks,
} from "@/server/supervisor/readiness";

/*
 * M3 — one canonical dependency/readiness authority (decision 0030).
 *
 * `mission_tasks.depends_on` is the only edge authority, `succeeded` is the only
 * status that satisfies a dependency, and readiness is a pure derivation from
 * persisted state.
 */

const mission = (
  status: Mission["status"] = "running",
): Mission => ({
  id: "m-1",
  title: "Mission",
  objective: "Objective",
  status,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const task = (
  over: Partial<MissionTask> &
    Pick<MissionTask, "id" | "status">,
): MissionTask => ({
  missionId: "m-1",
  title: `Task ${over.id}`,
  description: null,
  dependsOn: [],
  workerKind: null,
  capability: null,
  taskId: `task-${over.id}`,
  ...over,
});

const ids = (tasks: MissionTask[]) =>
  tasks.map((t) => t.id);

describe("canonical readiness authority", () => {
  it("exposes succeeded as the only completion status", () => {
    expect(CANONICAL_COMPLETION_STATUS).toBe(
      "succeeded",
    );
    expect([...READY_ELIGIBLE_STATUSES]).toEqual([
      "draft",
    ]);
  });

  describe("no unlock before ALL canonical dependencies complete", () => {
    const fanIn = (
      aStatus: MissionTask["status"],
      bStatus: MissionTask["status"],
    ) => [
      task({ id: "a", status: aStatus }),
      task({ id: "b", status: bStatus }),
      task({
        id: "c",
        status: "draft",
        dependsOn: ["a", "b"],
      }),
    ];

    it("unlocks C only when BOTH A and B succeeded", () => {
      expect(
        ids(
          computeReadyTasks(
            mission(),
            fanIn("succeeded", "succeeded"),
          ),
        ),
      ).toContain("c");
    });

    it("does not unlock C when only A succeeded", () => {
      expect(
        ids(
          computeReadyTasks(
            mission(),
            fanIn("succeeded", "draft"),
          ),
        ),
      ).not.toContain("c");
    });

    it.each([
      "draft",
      "queued",
      "running",
      "review_pending",
      "awaiting_approval",
      "blocked",
      "failed",
      "cancelled",
      "superseded",
    ] as const)(
      "does not accept a dependency in state %s as satisfied",
      (status) => {
        expect(
          ids(
            computeReadyTasks(
              mission(),
              fanIn("succeeded", status),
            ),
          ),
        ).not.toContain("c");
      },
    );
  });

  describe("stale workers cannot advance the DAG", () => {
    it("a dependency a worker claims to have finished, but which is still running canonically, does not unlock downstream", () => {
      /*
       * Mission N13: never merely trust worker claims. The only thing that
       * advances the DAG is canonical persisted completion.
       */
      const tasks = [
        task({ id: "a", status: "running" }),
        task({
          id: "b",
          status: "draft",
          dependsOn: ["a"],
        }),
      ];

      expect(
        ids(computeReadyTasks(mission(), tasks)),
      ).toEqual([]);
    });

    it("an already-dispatched task is never returned as ready again", () => {
      // A stale worker cannot cause a second dispatch of work in flight.
      for (const status of [
        "queued",
        "running",
        "review_pending",
      ] as const) {
        expect(
          computeReadyTasks(mission(), [
            task({ id: "a", status }),
          ]),
        ).toEqual([]);
      }
    });
  });

  describe("unresolvable edges fail closed", () => {
    it("blocks forever on a dependency that is not in the mission graph", () => {
      const tasks = [
        task({
          id: "orphan",
          status: "draft",
          dependsOn: ["does-not-exist"],
        }),
      ];

      expect(
        computeReadyTasks(mission(), tasks),
      ).toEqual([]);
    });
  });

  describe("tasks.dependencies is NON-authoritative", () => {
    it("ignores advisory Task.dependencies entirely", () => {
      /*
       * decision 0030: readiness reads mission_tasks.depends_on only. A
       * MissionTask carries no `dependencies` field at all, so contradictory
       * advisory data on the canonical Task row cannot reach this decision.
       * Proven structurally: the readiness input type has no such field.
       */
      const blocked = task({
        id: "blocked",
        status: "draft",
        dependsOn: ["a"],
      });

      // Advisory content attached the way an API caller could set it.
      const withAdvisory = {
        ...blocked,
        dependencies: [
          { taskId: "a", type: "blocking" as const },
        ],
      } as MissionTask;

      // Still blocked: the canonical edge is unsatisfied.
      expect(
        computeReadyTasks(mission(), [
          task({ id: "a", status: "running" }),
          withAdvisory,
        ]),
      ).toEqual([]);

      // And advisory content cannot block a task with no canonical edges.
      const free = {
        ...task({ id: "free", status: "draft" }),
        dependencies: [
          {
            taskId: "missing",
            type: "blocking" as const,
          },
        ],
      } as MissionTask;

      expect(
        ids(
          computeReadyTasks(mission(), [free]),
        ),
      ).toEqual(["free"]);
    });
  });

  describe("parallel roots remain parallel", () => {
    it("returns every independent root at once", () => {
      const tasks = [
        task({ id: "r1", status: "draft" }),
        task({ id: "r2", status: "draft" }),
        task({ id: "r3", status: "draft" }),
        task({
          id: "join",
          status: "draft",
          dependsOn: ["r1", "r2", "r3"],
        }),
      ];

      expect(
        ids(
          computeReadyTasks(mission(), tasks),
        ).sort(),
      ).toEqual(["r1", "r2", "r3"]);
    });

    it("keeps independent branches unblocked when a sibling branch fails", () => {
      const tasks = [
        task({ id: "bad", status: "failed" }),
        task({ id: "good", status: "draft" }),
      ];

      expect(
        ids(computeReadyTasks(mission(), tasks)),
      ).toEqual(["good"]);
    });
  });

  describe("replan cannot unlock superseded nodes", () => {
    it("never returns a superseded task and never lets one satisfy a dependency", () => {
      const tasks = [
        task({ id: "old", status: "superseded" }),
        task({
          id: "downstream-of-old",
          status: "draft",
          dependsOn: ["old"],
        }),
        task({
          id: "replacement",
          status: "draft",
        }),
      ];

      // Only the replacement runs; the abandoned branch stays blocked.
      expect(
        ids(computeReadyTasks(mission(), tasks)),
      ).toEqual(["replacement"]);
    });
  });

  describe("idempotence — unlock cannot fire twice", () => {
    it("is a pure derivation: repeated calls give identical results", () => {
      const tasks = [
        task({ id: "a", status: "succeeded" }),
        task({
          id: "b",
          status: "draft",
          dependsOn: ["a"],
        }),
      ];

      const first = computeReadyTasks(
        mission(),
        tasks,
      );
      const second = computeReadyTasks(
        mission(),
        tasks,
      );
      const third = computeReadyTasks(
        mission(),
        tasks,
      );

      expect(ids(first)).toEqual(["b"]);
      expect(ids(second)).toEqual(ids(first));
      expect(ids(third)).toEqual(ids(first));
    });

    it("stops reporting a task as ready once it has been dispatched", () => {
      const before = computeReadyTasks(mission(), [
        task({ id: "a", status: "draft" }),
      ]);
      expect(ids(before)).toEqual(["a"]);

      // The dispatcher moved it to queued; it must not be handed out again.
      const after = computeReadyTasks(mission(), [
        task({ id: "a", status: "queued" }),
      ]);
      expect(after).toEqual([]);
    });

    it("does not mutate its input", () => {
      const tasks = [
        task({ id: "a", status: "succeeded" }),
        task({
          id: "b",
          status: "draft",
          dependsOn: ["a"],
        }),
      ];
      const snapshot = JSON.parse(
        JSON.stringify(tasks),
      );

      computeReadyTasks(mission(), tasks);

      expect(
        JSON.parse(JSON.stringify(tasks)),
      ).toEqual(snapshot);
    });
  });

  describe("terminal missions dispatch nothing", () => {
    it.each(["succeeded", "failed", "cancelled"] as const)(
      "returns nothing for a %s mission even with ready work",
      (status) => {
        expect(
          computeReadyTasks(mission(status), [
            task({ id: "a", status: "draft" }),
          ]),
        ).toEqual([]);
      },
    );
  });
});
