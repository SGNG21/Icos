import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GoalPlanPreview, HighLevelGoal } from "@/core/contracts/high-level-goal";
import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import { InMemoryHumanAgentLinkRepository } from "@/server/services/in-memory/human-agent-link-repository";
import { buildMemoryContainer, type Container } from "@/server/container";

/**
 * The 200 PATH, executed against the real in-memory composition.
 *
 * The first version of this route's tests mocked `protectRoute` and `getContainer` and
 * only ever asserted the 403 branch, so `buildObjectiveReadModel` was never run from the
 * route and a cross-scope leak shipped invisibly. These tests exist to make that class of
 * miss impossible: they go through the real container, the real scope resolution and the
 * real projection.
 */

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";

const goal = (id: string, metadata: Record<string, string> = {}): HighLevelGoal => ({
  id,
  title: `objective ${id}`,
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata,
  createdAt: "2026-10-01T00:00:00.000Z",
});

const preview = (id: string): GoalPlanPreview => ({
  goalId: id,
  missionTitle: id,
  missionObjective: "o",
  tasks: [],
});

function install(role: Role | "anonymous") {
  const session: AuthenticatedSession | null =
    role === "anonymous"
      ? null
      : { user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" }, roles: [role] };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  } as unknown as AuthGateway;

  const base = buildMemoryContainer();
  const agentLinks = base.agentLinks ?? new InMemoryHumanAgentLinkRepository();
  /*
   * buildMemoryContainer composes no `operationalAccess`, so scope resolution falls to
   * NO_AGENTS and every reader sees nothing — safe, but it would make a scope test
   * vacuous. Compose it exactly as buildPostgresContainer does, so the scope rule under
   * test is the real one.
   */
  const container = {
    ...base,
    auth,
    agentLinks,
    operationalAccess: new OperationalAccessService(agentLinks),
  } as Container;
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

const call = async (query = "") => {
  const { GET } = await import("./route");
  return GET(
    new Request(`${ORIGIN}/api/supervisor/objectives${query}`, {
      headers: { origin: ORIGIN, cookie: COOKIE },
    }),
  );
};

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("GET /api/supervisor/objectives — the 200 path, really executed", () => {
  it("an owner sees the objectives, scored, with the policy version on the record", async () => {
    const container = install("owner");
    await container.goalRepository.create(
      goal("g-user", { "icos.source": "cognitive_conversation" }),
      preview("g-user"),
    );
    await container.goalRepository.create(goal("g-research"), preview("g-research"));

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectives: { objectiveId: string; priority: { class: string; policyVersion: string } }[] };

    // Doctrine order, through the real projection: USER before RESEARCH.
    expect(body.objectives.map((o) => o.objectiveId)).toEqual(["g-user", "g-research"]);
    expect(body.objectives[0].priority.class).toBe("USER");
    expect(body.objectives[0].priority.policyVersion).toMatch(/^priority\//);
  });

  it("a reader whose scope cannot be resolved sees nothing (fail closed)", async () => {
    const base = buildMemoryContainer();
    const container = {
      ...base,
      auth: {
        createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
        readSession: vi.fn(async () => ({
          user: { id: "h", email: "h@icos.test", name: "H", status: "active" },
          roles: ["owner"],
        })),
        revokeSession: async () => {},
        revokeUserSessions: async () => {},
      },
      operationalAccess: undefined,
    } as unknown as Container;
    (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
    await container.goalRepository.create(goal("g-x"), preview("g-x"));

    const body = (await (await call()).json()) as { objectives: unknown[] };
    expect(body.objectives).toEqual([]);
  });

  it("a viewer with no linked agents sees nothing, not everyone's objectives", async () => {
    const container = install("viewer");
    await container.goalRepository.create(goal("g-secret"), preview("g-secret"));

    const res = await call();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectives: unknown[] };
    // `cockpit.read` lets a viewer READ the projection; it does not widen what they may see.
    expect(body.objectives).toEqual([]);
  });

  it("refuses an anonymous caller", async () => {
    install("anonymous");
    const res = await call();
    expect(res.status).toBe(401);
  });

  it("caps the page size a caller can ask for", async () => {
    const container = install("owner");
    for (let i = 0; i < 5; i += 1) {
      await container.goalRepository.create(goal(`g-${i}`), preview(`g-${i}`));
    }
    const res = await call("?limit=99999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { objectives: unknown[] };
    expect(body.objectives.length).toBeLessThanOrEqual(200);
  });

  it("reports cost as UNKNOWN rather than inventing a measurement", async () => {
    const container = install("owner");
    await container.goalRepository.create(goal("g-1"), preview("g-1"));
    const body = (await (await call()).json()) as { objectives: { cost: unknown }[] };
    expect(body.objectives[0].cost).toBe("UNKNOWN");
  });
});
