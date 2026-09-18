import {
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  Mission,
  MissionTask,
} from "@/core/mission/contracts";

import type {
  MissionPlan,
} from "@/server/mission/mission-plan";

import {
  AutonomousMissionRunner,
  type AutonomousMissionPlanner,
  type AutonomousSupervisor,
} from "@/server/autonomy/autonomous-mission-runner";

function mission(
  status: Mission["status"] = "draft",
): Mission {
  const now = new Date(
    "2026-09-13T17:00:00.000Z",
  );

  return {
    id: "mission-1",
    title: "Autonomy",
    objective:
      "Run autonomously",
    status,
    createdAt: now,
    updatedAt: now,
  };
}

function task(input: {
  id: string;
  taskId?: string;
  status: MissionTask["status"];
  dependsOn?: string[];
}): MissionTask {
  return {
    id: input.id,
    missionId: "mission-1",
    taskId:
      input.taskId ??
      `canonical-${input.id}`,
    title: input.id,
    description: input.id,
    status: input.status,
    dependsOn:
      input.dependsOn ?? [],
    workerKind: "agent",
    capability: null,
  };
}

function planner(
  plan?: MissionPlan,
): AutonomousMissionPlanner {
  return {
    plan: vi.fn().mockResolvedValue(
      plan ?? {
        version: 1,
        tasks: [
          {
            key: "A",
            title: "A",
            description: "A",
            dependsOn: [],
            workerKind: "agent",
          },
        ],
      },
    ),
  };
}

describe(
  "N2.7 AutonomousMissionRunner",
  () => {
    it(
      "creates an initial plan for an empty mission then runs the Supervisor",
      async () => {
        const currentMission =
          mission();

        let tasks:
          MissionTask[] = [];

        const applyPlan = vi.fn(
          async () => {
            tasks = [
              task({
                id: "mt-a",
                status: "draft",
              }),
            ];

            return tasks;
          },
        );

        const missions = {
          findById:
            vi.fn().mockImplementation(
              async () =>
                currentMission,
            ),
          listTasks:
            vi.fn().mockImplementation(
              async () => tasks,
            ),
          applyPlan,
        };

        const supervisor:
          AutonomousSupervisor = {
            reconcilePreparedDispatches:
              vi.fn().mockResolvedValue(
                undefined,
              ),
            run:
              vi.fn().mockImplementation(
                async () => {
                  tasks = [
                    task({
                      id: "mt-a",
                      status: "queued",
                    }),
                  ];
                },
              ),
          };

        const p = planner();

        const runner =
          new AutonomousMissionRunner(
            missions,
            supervisor,
            p,
          );

        const result =
          await runner.run(
            currentMission.id,
          );

        expect(
          p.plan,
        ).toHaveBeenCalledTimes(1);

        expect(
          applyPlan,
        ).toHaveBeenCalledTimes(1);

        expect(
          supervisor.run,
        ).toHaveBeenCalledTimes(1);

        expect(result.state).toBe(
          "waiting",
        );

        expect(result.reason).toBe(
          "AUTONOMY_EXTERNAL_WORK_PENDING",
        );
      },
    );

    it(
      "returns succeeded when Supervisor completes the mission",
      async () => {
        let currentMission =
          mission();

        let tasks = [
          task({
            id: "mt-a",
            status: "draft",
          }),
        ];

        const missions = {
          findById:
            vi.fn().mockImplementation(
              async () =>
                currentMission,
            ),
          listTasks:
            vi.fn().mockImplementation(
              async () => tasks,
            ),
          applyPlan:
            vi.fn(),
        };

        const supervisor:
          AutonomousSupervisor = {
            reconcilePreparedDispatches:
              vi.fn().mockResolvedValue(
                undefined,
              ),
            run:
              vi.fn().mockImplementation(
                async () => {
                  tasks = [
                    task({
                      id: "mt-a",
                      status: "succeeded",
                    }),
                  ];

                  currentMission = {
                    ...currentMission,
                    status: "succeeded",
                  };
                },
              ),
          };

        const runner =
          new AutonomousMissionRunner(
            missions,
            supervisor,
            planner(),
          );

        const result =
          await runner.run(
            currentMission.id,
          );

        expect(result.state).toBe(
          "succeeded",
        );

        expect(result.cycleCount).toBe(
          1,
        );
      },
    );

    it(
      "detects deterministic DAG deadlock",
      async () => {
        const currentMission =
          mission();

        const tasks = [
          task({
            id: "mt-a",
            status: "draft",
            dependsOn: ["mt-b"],
          }),
          task({
            id: "mt-b",
            status: "draft",
            dependsOn: ["mt-a"],
          }),
        ];

        const missions = {
          findById:
            vi.fn().mockResolvedValue(
              currentMission,
            ),
          listTasks:
            vi.fn().mockResolvedValue(
              tasks,
            ),
          applyPlan:
            vi.fn(),
        };

        const supervisor:
          AutonomousSupervisor = {
            reconcilePreparedDispatches:
              vi.fn().mockResolvedValue(
                undefined,
              ),
            run:
              vi.fn().mockResolvedValue(
                undefined,
              ),
          };

        const runner =
          new AutonomousMissionRunner(
            missions,
            supervisor,
            planner(),
          );

        const result =
          await runner.run(
            currentMission.id,
          );

        expect(result.state).toBe(
          "deadlock",
        );

        expect(result.reason).toBe(
          "AUTONOMY_DAG_DEADLOCK",
        );
      },
    );

    it(
      "does not classify queued external work as stagnation",
      async () => {
        const currentMission =
          mission();

        const tasks = [
          task({
            id: "mt-a",
            status: "queued",
          }),
        ];

        const missions = {
          findById:
            vi.fn().mockResolvedValue(
              currentMission,
            ),
          listTasks:
            vi.fn().mockResolvedValue(
              tasks,
            ),
          applyPlan:
            vi.fn(),
        };

        const supervisor:
          AutonomousSupervisor = {
            reconcilePreparedDispatches:
              vi.fn().mockResolvedValue(
                undefined,
              ),
            run:
              vi.fn().mockResolvedValue(
                undefined,
              ),
          };

        const runner =
          new AutonomousMissionRunner(
            missions,
            supervisor,
            planner(),
            {
              maxCycles: 10,
              maxRuntimeMs:
                60_000,
              maxStagnationCycles: 1,
            },
          );

        const result =
          await runner.run(
            currentMission.id,
          );

        expect(result.state).toBe(
          "waiting",
        );

        expect(
          result.stagnationCount,
        ).toBe(0);
      },
    );

    it(
      "fails closed on cycle budget exhaustion",
      async () => {
        const currentMission =
          mission();

        let tasks = [
          task({
            id: "mt-a",
            status: "draft",
          }),
        ];

        let toggle = false;

        const missions = {
          findById:
            vi.fn().mockResolvedValue(
              currentMission,
            ),
          listTasks:
            vi.fn().mockImplementation(
              async () => tasks,
            ),
          applyPlan:
            vi.fn(),
        };

        const supervisor:
          AutonomousSupervisor = {
            reconcilePreparedDispatches:
              vi.fn().mockResolvedValue(
                undefined,
              ),
            run:
              vi.fn().mockImplementation(
                async () => {
                  toggle = !toggle;

                  tasks = [
                    task({
                      id: "mt-a",
                      status: "draft",
                      taskId:
                        toggle
                          ? "canonical-a1"
                          : "canonical-a2",
                    }),
                  ];
                },
              ),
          };

        const runner =
          new AutonomousMissionRunner(
            missions,
            supervisor,
            planner(),
            {
              maxCycles: 2,
              maxRuntimeMs:
                60_000,
              maxStagnationCycles: 10,
            },
          );

        const result =
          await runner.run(
            currentMission.id,
          );

        expect(result.state).toBe(
          "escalated",
        );

        expect(result.reason).toBe(
          "AUTONOMY_CYCLE_BUDGET_EXCEEDED",
        );

        expect(result.cycleCount).toBe(
          2,
        );
      },
    );
  },
);
