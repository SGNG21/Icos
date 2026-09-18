import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Container } from "@/server/container";
import { buildMemoryContainer, getContainer } from "@/server/container";
import type { DispatchAttempt, DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { MissionRepository } from "@/server/mission/ports";
import { InMemoryQualityControlRepository } from "@/server/services/in-memory/quality-control-repository";

import { POST as completedPOST } from "./completed/route";
import { POST as startedPOST } from "./started/route";

vi.mock("@/server/container", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/container")>();
  return {
    ...actual,
    getContainer: vi.fn(),
  };
});

const CALLBACK_SECRET = "callback-secret-for-route-proof-0001";

const failurePayload = (taskId: string, workflowId: string) => ({
  taskId,
  workflowId,
  outcome: "failure" as const,
  workerKind: "hermes" as const,
  error: {
    code: "WORKER_FAILED" as const,
    message: "synthetic worker failure",
  },
  startedAt: "2026-09-16T10:00:00.000Z",
  completedAt: "2026-09-16T10:05:00.000Z",
});

function request(path: "started" | "completed", body: unknown): Request {
  return new Request(`http://localhost/api/internal/executions/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-icos-callback-secret": CALLBACK_SECRET,
    },
    body: JSON.stringify(body),
  });
}

describe("Temporal failure callback route sequence", () => {
  let container: Container;

  beforeEach(async () => {
    container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    container.executionCallbackSecret = CALLBACK_SECRET;
    container.qualityControlJobs = new InMemoryQualityControlRepository(
      container.mission,
      container.tasks,
      container.executionResults,
      container.reviewDecisions,
      container.dispatchAttempts,
      container.autonomousRuntime,
    );
    vi.mocked(getContainer).mockResolvedValue(container);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await container.close();
  });

  it("accepts reportStarted then the exact reportFailure payload without changing correlation", async () => {
    const mission = await container.mission.create({
      title: "Route proof mission",
      objective: "Prove started then failure callback",
      tasks: [
        {
          title: "Synthetic execution",
          description: "No external dispatch",
          dependsOn: [],
          workerKind: "hermes",
        },
      ],
    });
    const missionTaskBefore = (await container.mission.listTasks(mission.id))[0];
    const workflowId = `icos-task-${missionTaskBefore.taskId}`;
    const prepared = await container.dispatchAttempts.prepare({
      missionId: mission.id,
      missionTaskId: missionTaskBefore.id,
      taskId: missionTaskBefore.taskId,
      attempt: 1,
      workflowId,
      prompt: missionTaskBefore.description ?? missionTaskBefore.title,
      workerKind: "hermes",
    });
    const taskBefore = await container.tasks.getById(missionTaskBefore.taskId);
    const attemptBefore = await container.dispatchAttempts.getByWorkflowId(workflowId);

    const startedAt = "2026-09-16T10:00:00.000Z";
    const startedResponse = await startedPOST(
      request("started", {
        taskId: missionTaskBefore.taskId,
        workflowId,
        startedAt,
      }),
    );

    const missionTaskAfterStarted = await container.mission.getMissionTaskById(missionTaskBefore.id);
    const taskAfterStarted = await container.tasks.getById(missionTaskBefore.taskId);
    const attemptAfterStarted = await container.dispatchAttempts.getByWorkflowId(workflowId);

    const completedResponse = await completedPOST(
      request("completed", failurePayload(missionTaskBefore.taskId, workflowId)),
    );
    const completedBody = (await completedResponse.json()) as { duplicate?: boolean };
    const replayResponse = await completedPOST(
      request("completed", failurePayload(missionTaskBefore.taskId, workflowId)),
    );
    const replayBody = (await replayResponse.json()) as { duplicate?: boolean };

    expect(startedResponse.status).toBe(200);
    expect(completedResponse.status).toBe(200);
    expect(completedBody.duplicate).toBe(false);
    expect(replayResponse.status).toBe(200);
    expect(replayBody.duplicate).toBe(true);
    expect(attemptBefore).toMatchObject({
      workflowId,
      taskId: missionTaskBefore.taskId,
      missionTaskId: missionTaskBefore.id,
      missionId: mission.id,
      state: "prepared",
    });
    expect(attemptAfterStarted).toMatchObject({
      workflowId,
      taskId: missionTaskBefore.taskId,
      missionTaskId: missionTaskBefore.id,
      missionId: mission.id,
      state: "prepared",
    });
    expect(attemptAfterStarted).toEqual(attemptBefore);
    expect(missionTaskAfterStarted).toMatchObject({
      id: missionTaskBefore.id,
      taskId: missionTaskBefore.taskId,
      missionId: mission.id,
      status: "queued",
    });
    expect(taskBefore?.status).toBe("queued");
    expect(taskAfterStarted?.status).toBe("running");
  });

  it.each([
    {
      branch: "B",
      prepare: (subject: Container) => {
        vi.spyOn(subject.dispatchAttempts, "getByWorkflowId").mockResolvedValue(null);
      },
    },
    {
      branch: "C",
      prepare: (subject: Container) => {
        vi.spyOn(subject.dispatchAttempts, "getByWorkflowId").mockResolvedValue({
          taskId: "different-task",
        } as DispatchAttempt);
      },
    },
    {
      branch: "D",
      prepare: (subject: Container) => {
        vi.spyOn(subject.mission, "getMissionTaskByCanonicalTaskId").mockResolvedValue(null);
      },
    },
    {
      branch: "E",
      prepare: (subject: Container) => {
        vi.spyOn(subject.mission, "getMissionTaskByCanonicalTaskId").mockResolvedValue({
          id: "different-mission-task",
          missionId: "mission-route-branch",
        } as Awaited<ReturnType<MissionRepository["getMissionTaskByCanonicalTaskId"]>>);
      },
    },
    {
      branch: "F",
      prepare: (subject: Container) => {
        vi.spyOn(subject.mission, "getMissionTaskByCanonicalTaskId").mockResolvedValue({
          id: "mission-task-route-branch",
          missionId: "different-mission",
        } as Awaited<ReturnType<MissionRepository["getMissionTaskByCanonicalTaskId"]>>);
      },
    },
  ])("identifies correlation rejection branch $branch with the real route", async ({ prepare }) => {
    const taskId = "task-route-branch";
    const workflowId = "workflow-route-branch";
    container.dispatchAttempts = {
      getByWorkflowId: vi.fn().mockResolvedValue({
        id: "attempt-route-branch",
        missionId: "mission-route-branch",
        missionTaskId: "mission-task-route-branch",
        taskId,
        attempt: 1,
        workflowId,
        prompt: "route branch",
        state: "prepared",
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    } as unknown as DispatchAttemptRepository;
    container.mission = {
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue({
        id: "mission-task-route-branch",
        missionId: "mission-route-branch",
        taskId,
      }),
    } as unknown as MissionRepository;
    prepare(container);

    const response = await completedPOST(
      request("completed", failurePayload(taskId, workflowId)),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_input",
        message: "workflow d'exécution non corrélé",
      },
    });
  });

  it("identifies branch A with the real route", async () => {
    const response = await completedPOST(
      request("completed", {
        ...failurePayload("task-route-schema", "workflow-route-schema"),
        unexpected: true,
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_input", message: "paramètres invalides" },
    });
  });
});
