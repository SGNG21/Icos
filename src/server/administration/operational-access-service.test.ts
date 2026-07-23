import { describe, expect, it } from "vitest";

import type { AuthenticatedSession } from "@/core/identity";
import type { HumanAgentLinkRepository } from "@/server/repositories/ports";

import {
  canCreateTaskInScope,
  OperationalAccessService,
  scopeContainsAgent,
} from "./operational-access-service";

const session = (roles: AuthenticatedSession["roles"]): AuthenticatedSession => ({
  user: {
    id: "human-operator",
    email: "operator@example.test",
    status: "active",
  },
  roles,
});

function links(agentIds: readonly string[]): HumanAgentLinkRepository {
  return {
    listForHuman: async () => [],
    listAgentIdsForHuman: async () => new Set(agentIds),
  };
}

describe("OperationalAccessService", () => {
  it.each(["owner", "admin"] as const)("accorde une portée globale à %s", async (role) => {
    const service = new OperationalAccessService(links(["agent-linked"]));

    await expect(service.resolveScope(session([role]))).resolves.toEqual({ kind: "global" });
  });

  it.each(["operator", "viewer"] as const)(
    "limite %s aux agents liés sans interpréter la relation",
    async (role) => {
      const service = new OperationalAccessService(links(["agent-a", "agent-b"]));

      const scope = await service.resolveScope(session([role]));

      expect(scope.kind).toBe("linked");
      expect(scope.kind === "linked" ? [...scope.agentIds] : []).toEqual(["agent-a", "agent-b"]);
    },
  );

  it("échoue fermé sans rôle ou sans lien", async () => {
    await expect(
      new OperationalAccessService(links(["agent-a"])).resolveScope(session([])),
    ).resolves.toEqual({
      kind: "linked",
      agentIds: new Set(),
    });
    await expect(
      new OperationalAccessService(links([])).resolveScope(session(["operator"])),
    ).resolves.toEqual({ kind: "linked", agentIds: new Set() });
  });
});

describe("prédicats de portée", () => {
  const global = { kind: "global" } as const;
  const linked = { kind: "linked", agentIds: new Set(["agent-a"]) } as const;

  it("reconnaît un agent global ou explicitement lié", () => {
    expect(scopeContainsAgent(global, "agent-missing")).toBe(true);
    expect(scopeContainsAgent(linked, "agent-a")).toBe(true);
    expect(scopeContainsAgent(linked, "agent-b")).toBe(false);
  });

  it("autorise les tâches non assignées globalement mais exige un agent lié localement", () => {
    expect(canCreateTaskInScope({ scope: global })).toBe(true);
    expect(canCreateTaskInScope({ scope: linked })).toBe(false);
    expect(canCreateTaskInScope({ scope: linked, assignedAgentId: "agent-a" })).toBe(true);
    expect(canCreateTaskInScope({ scope: linked, assignedAgentId: "agent-b" })).toBe(false);
  });
});
