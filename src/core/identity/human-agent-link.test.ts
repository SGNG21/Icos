import { describe, expect, it } from "vitest";

import { humanAgentLinkSchema, humanAgentRelationSchema } from "./index";

const validLink = {
  id: "link-001",
  humanUserId: "human-001",
  agentId: "agent-cto",
  relation: "supervisor",
  createdAt: "2026-07-23T08:00:00.000Z",
  createdByHumanUserId: "human-owner",
};

describe("humanAgentRelationSchema", () => {
  it.each(["supervisor", "operator", "observer"] as const)("accepte la relation %s", (relation) => {
    expect(humanAgentRelationSchema.safeParse(relation).success).toBe(true);
  });

  it("rejette une relation inconnue", () => {
    expect(humanAgentRelationSchema.safeParse("manager").success).toBe(false);
  });
});

describe("humanAgentLinkSchema", () => {
  it("accepte exactement le contrat de rattachement humain-agent", () => {
    expect(humanAgentLinkSchema.parse(validLink)).toEqual(validLink);
  });

  it("rejette tout champ updatedAt", () => {
    expect(
      humanAgentLinkSchema.safeParse({
        ...validLink,
        updatedAt: "2026-07-23T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejette les identifiants et horodatages invalides", () => {
    expect(humanAgentLinkSchema.safeParse({ ...validLink, humanUserId: "Human 1" }).success).toBe(
      false,
    );
    expect(humanAgentLinkSchema.safeParse({ ...validLink, createdAt: "hier" }).success).toBe(false);
  });
});
