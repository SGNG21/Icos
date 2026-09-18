import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Mission } from "@/core/mission/contracts";
import { OmniRouteAutonomousMissionPlanner } from "@/server/autonomy/omniroute-autonomous-mission-planner";

const mission: Mission = {
  id: "mission-live-planner",
  title: "Live planner adapter",
  objective: "Prove real HTTP transport through an OpenAI-compatible OmniRoute boundary",
  status: "planning",
  createdAt: new Date("2026-09-14T18:00:00.000Z"),
  updatedAt: new Date("2026-09-14T18:00:00.000Z"),
};

describe("OmniRouteAutonomousMissionPlanner HTTP integration", () => {
  let server: Server;
  let baseUrl: string;
  const requests: Array<{ authorization?: string; body: unknown }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        rawBody += chunk;
      });
      request.on("end", () => {
        requests.push({
          authorization: request.headers.authorization,
          body: JSON.parse(rawBody),
        });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    version: 1,
                    tasks: [
                      {
                        key: "execute",
                        title: "Execute objective",
                        dependsOn: [],
                        workerKind: "hermes",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("PLANNER_TEST_SERVER_ADDRESS_UNAVAILABLE");
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("performs a real HTTP request and accepts the validated plan", async () => {
    const planner = new OmniRouteAutonomousMissionPlanner({
      baseUrl,
      apiKey: "integration-secret",
      model: "integration-planner",
      timeoutMs: 5_000,
    });

    const plan = await planner.plan({ mission, tasks: [], reason: "initial" });

    expect(plan.tasks[0].key).toBe("execute");
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe("Bearer integration-secret");
    expect(requests[0].body).toMatchObject({
      model: "integration-planner",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });
});
