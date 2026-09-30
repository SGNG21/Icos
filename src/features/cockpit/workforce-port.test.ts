import { describe, expect, it } from "vitest";

import { loadWorkforceBootstrap } from "@/core/workforce/bootstrap";
import { buildMemoryContainer } from "@/server/container";

import { isReal } from "./truth";
import { workforceReadPort } from "./workforce";

/*
 * Wave I3 composition proof: the cockpit's workforce projection is REAL through the container's
 * composed runtime and the caller's session — not a literal principal, not a fixture. Built,
 * proven, never wired has recurred; this test fails if `container.workforce` disappears or if the
 * service output stops matching the cockpit read contract.
 */
const owner = {
  user: { id: "owner-1", email: "owner@example.test", status: "active" as const },
  roles: ["owner" as const],
};

describe("cockpit workforce read port over the composed runtime", () => {
  it("container.workforce is composed and an empty tenant reads as a REAL (empty) projection", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    expect(container.workforce).toBeDefined();
    const truth = await workforceReadPort(container.workforce!, owner).read();
    expect(isReal(truth)).toBe(true);
    if (isReal(truth)) {
      expect(truth.value.agents).toEqual([]);
      expect(truth.value.performance?.count).toBe(0);
    }
  });

  it("the real bootstrap (roles, skills, departments) parses through the read contract", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    const wf = container.workforce!;
    await wf.service.seedBootstrap(wf.sessions.fromSession(owner), loadWorkforceBootstrap());
    const truth = await workforceReadPort(wf, owner).read();
    expect(isReal(truth)).toBe(true);
    if (isReal(truth)) {
      expect(truth.value.roles.length).toBeGreaterThan(10);
      expect(truth.value.skills.length).toBeGreaterThan(10);
      expect(truth.value.departments.length).toBeGreaterThan(5);
    }
  });
});
