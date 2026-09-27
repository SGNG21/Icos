import { describe, expect, it, vi } from "vitest";

import type { Mission } from "@/core/mission/contracts";
import {
  createOmniRouteAutonomousMissionPlanner,
  OmniRouteAutonomousMissionPlanner,
} from "@/server/autonomy/omniroute-autonomous-mission-planner";

const mission: Mission = {
  id: "mission-1",
  title: "Production planner",
  objective: "Produce and execute a validated implementation plan",
  status: "planning",
  createdAt: new Date("2026-09-14T18:00:00.000Z"),
  updatedAt: new Date("2026-09-14T18:00:00.000Z"),
};

function response(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
    }),
    {
      status,
      statusText: status === 200 ? "OK" : "Service Unavailable",
      headers: { "Content-Type": "application/json" },
    },
  );
}

function planner(fetchImpl: typeof fetch): OmniRouteAutonomousMissionPlanner {
  return new OmniRouteAutonomousMissionPlanner({
    baseUrl: "http://127.0.0.1:20128/",
    apiKey: "planner-secret",
    model: "planner-model",
    timeoutMs: 5_000,
    fetch: fetchImpl,
  });
}

describe("OmniRouteAutonomousMissionPlanner", () => {
  it("returns a schema-valid and DAG-valid initial MissionPlan", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        JSON.stringify({
          version: 1,
          tasks: [
            {
              key: "inspect",
              title: "Inspect repository",
              description: "Collect evidence",
              dependsOn: [],
              workerKind: "hermes",
              capability: "repository-inspection",
            },
            {
              key: "implement",
              title: "Implement change",
              dependsOn: ["inspect"],
              workerKind: "hermes",
            },
          ],
        }),
      ),
    );

    const result = await planner(fetchMock).plan({
      mission,
      tasks: [],
      reason: "initial",
    });

    expect(result.tasks.map((task) => task.key)).toEqual(["inspect", "implement"]);
    expect(result.tasks[1].dependsOn).toEqual(["inspect"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:20128/v1/chat/completions");
    expect(request?.headers).toEqual({
      Authorization: "Bearer planner-secret",
      "Content-Type": "application/json",
    });

    const body = JSON.parse(String(request?.body)) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("planner-model");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].content).toContain(mission.objective);
    expect(body.messages[1].content).toContain("Planning reason: initial");
  });

  it("carries planner-supplied execution envelopes through to the MissionPlan", async () => {
    /*
     * The task schema is `.strict()`. Before CORE3 M2 it declared only
     * key/title/description/dependsOn/workerKind/capability, so a planner that
     * DID specify a risk class or attempt budget had its entire plan rejected —
     * planning metadata could never originate from planner output.
     */
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        JSON.stringify({
          version: 1,
          tasks: [
            {
              key: "inspect",
              title: "Inspect repository",
              dependsOn: [],
              objective: "Understand the module",
              instructions: "Read only",
              successCriteria: ["findings recorded"],
              requiredCapabilities: ["repository-inspection"],
              riskClass: "read_only",
              allowedFileScope: ["src/**"],
              expectedArtifacts: ["report.md"],
              priority: 1,
              attemptBudget: 2,
              reviewPolicy: "never",
              integrationPolicy: "none",
            },
            {
              key: "implement",
              title: "Implement change",
              dependsOn: ["inspect"],
              riskClass: "sensitive",
              reviewPolicy: "always",
              priority: 5,
              attemptBudget: 4,
            },
          ],
        }),
      ),
    );

    const result = await planner(fetchMock).plan({
      mission,
      tasks: [],
      reason: "initial",
    });

    expect(result.tasks[0]).toMatchObject({
      key: "inspect",
      objective: "Understand the module",
      instructions: "Read only",
      successCriteria: ["findings recorded"],
      requiredCapabilities: ["repository-inspection"],
      riskClass: "read_only",
      allowedFileScope: ["src/**"],
      expectedArtifacts: ["report.md"],
      priority: 1,
      attemptBudget: 2,
      reviewPolicy: "never",
      integrationPolicy: "none",
    });

    expect(result.tasks[1]).toMatchObject({
      key: "implement",
      riskClass: "sensitive",
      reviewPolicy: "always",
      priority: 5,
      attemptBudget: 4,
    });
  });

  it("asks the provider for the execution envelope", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        JSON.stringify({
          version: 1,
          tasks: [{ key: "a", title: "A", dependsOn: [] }],
        }),
      ),
    );

    await planner(fetchMock).plan({
      mission,
      tasks: [],
      reason: "initial",
    });

    const [, request] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const prompt = body.messages
      .map((m) => m.content)
      .join("\n");

    expect(prompt).toContain("riskClass");
    expect(prompt).toContain("reviewPolicy");
    expect(prompt).toContain("attemptBudget");
    expect(prompt).toContain("successCriteria");
    expect(prompt).toContain("allowedFileScope");
  });

  it("fails closed when a planner-supplied envelope is semantically unsafe", async () => {
    /*
     * Schema-valid (sensitive and never are both legal values) but rejected by
     * validateMissionPlan: the semantic gate is not duplicated in the schema.
     */
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        JSON.stringify({
          version: 1,
          tasks: [
            {
              key: "risky",
              title: "Risky",
              dependsOn: [],
              riskClass: "sensitive",
              reviewPolicy: "never",
            },
          ],
        }),
      ),
    );

    await expect(
      planner(fetchMock).plan({
        mission,
        tasks: [],
        reason: "initial",
      }),
    ).rejects.toThrow(/AUTONOMY_PLANNER_/);
  });

  it("fails closed when provider output is not valid JSON", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("not-json"));

    await expect(
      planner(fetchMock).plan({ mission, tasks: [], reason: "initial" }),
    ).rejects.toThrow("AUTONOMY_PLANNER_INVALID_OUTPUT");
  });

  it("fails closed when structured output violates the planner schema", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(JSON.stringify({ version: 1, tasks: [{ key: "A", title: "A" }] })),
      );

    await expect(
      planner(fetchMock).plan({ mission, tasks: [], reason: "initial" }),
    ).rejects.toThrow("AUTONOMY_PLANNER_INVALID_OUTPUT");
  });

  it("fails closed when schema-valid output is not a valid DAG", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      response(
        JSON.stringify({
          version: 1,
          tasks: [
            { key: "A", title: "A", dependsOn: ["B"] },
            { key: "B", title: "B", dependsOn: ["A"] },
          ],
        }),
      ),
    );

    await expect(
      planner(fetchMock).plan({ mission, tasks: [], reason: "initial" }),
    ).rejects.toThrow("AUTONOMY_PLANNER_INVALID_PLAN:MISSION_PLAN_CYCLE");
  });

  it("fails closed on provider HTTP errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response("ignored", 503));

    await expect(
      planner(fetchMock).plan({ mission, tasks: [], reason: "initial" }),
    ).rejects.toThrow("AUTONOMY_PLANNER_PROVIDER_HTTP:503");
  });

  it("fails closed when the configured request timeout aborts the provider", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    );

    const timedPlanner = new OmniRouteAutonomousMissionPlanner({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "planner-secret",
      model: "planner-model",
      timeoutMs: 1,
      fetch: fetchMock,
    });

    await expect(timedPlanner.plan({ mission, tasks: [], reason: "initial" })).rejects.toThrow(
      "AUTONOMY_PLANNER_TIMEOUT",
    );
  });

  it("propagates caller cancellation without leaking the abort reason", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, request) =>
        new Promise<Response>((_resolve, reject) => {
          request?.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        }),
    );
    const caller = new AbortController();
    const result = planner(fetchMock).plan({
      mission,
      tasks: [],
      reason: "initial",
      signal: caller.signal,
    });

    caller.abort(new Error("sensitive caller reason"));

    await expect(result).rejects.toThrow("AUTONOMY_PLANNER_ABORTED");
  });

  it("does not leak the configured API key when provider access fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network rejected planner-secret"));

    const error = await planner(fetchMock)
      .plan({ mission, tasks: [], reason: "initial" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("AUTONOMY_PLANNER_PROVIDER_FAILURE");
    expect((error as Error).message).not.toContain("planner-secret");
  });
});

describe("createOmniRouteAutonomousMissionPlanner", () => {
  it("keeps autonomous planning disabled when no planner setting is supplied", () => {
    expect(createOmniRouteAutonomousMissionPlanner({})).toBeUndefined();
  });

  it("creates the planner when the complete planner configuration is supplied", () => {
    expect(
      createOmniRouteAutonomousMissionPlanner({
        OMNIROUTE_BASE_URL: "http://127.0.0.1:20128",
        OMNIROUTE_API_KEY: "planner-secret",
        ICOS_PLANNER_MODEL: "planner-model",
        ICOS_PLANNER_TIMEOUT_MS: 5_000,
      }),
    ).toBeInstanceOf(OmniRouteAutonomousMissionPlanner);
  });

  it("fails closed on partial planner configuration", () => {
    expect(() =>
      createOmniRouteAutonomousMissionPlanner({
        ICOS_PLANNER_MODEL: "planner-model",
      }),
    ).toThrow("AUTONOMY_PLANNER_CONFIGURATION_INCOMPLETE");
  });
});
