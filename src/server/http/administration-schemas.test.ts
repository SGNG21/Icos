import { describe, expect, it } from "vitest";

import { zodDetails } from "./errors";
import {
  createAgentLinkBodySchema,
  createHumanBodySchema,
  replaceRoleBodySchema,
  setStatusBodySchema,
} from "./administration-schemas";

describe("schémas HTTP d'administration", () => {
  it("normalise et accepte une création humaine valide", () => {
    expect(
      createHumanBodySchema.parse({
        email: "  human@example.test  ",
        password: "correct horse battery staple",
        name: "  Human Operator  ",
        role: "operator",
      }),
    ).toEqual({
      email: "human@example.test",
      password: "correct horse battery staple",
      name: "Human Operator",
      role: "operator",
    });
  });

  it("refuse un mot de passe de moins de douze caractères sans réfléchir sa valeur", () => {
    const password = "short-value";
    const parsed = createHumanBodySchema.safeParse({
      email: "human@example.test",
      password,
      role: "viewer",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(JSON.stringify(zodDetails(parsed.error))).not.toContain(password);
  });

  it("refuse les champs supplémentaires", () => {
    expect(
      createHumanBodySchema.safeParse({
        email: "human@example.test",
        password: "correct horse battery staple",
        role: "viewer",
        token: "must-not-pass",
      }).success,
    ).toBe(false);
    expect(replaceRoleBodySchema.safeParse({ role: "viewer", owner: true }).success).toBe(false);
    expect(setStatusBodySchema.safeParse({ status: "active", session: "x" }).success).toBe(false);
    expect(
      createAgentLinkBodySchema.safeParse({
        agentId: "agent-001",
        relation: "observer",
        authorizationLevel: 3,
      }).success,
    ).toBe(false);
  });

  it("accepte uniquement les rôles, statuts et relations fermés", () => {
    expect(replaceRoleBodySchema.parse({ role: "admin" })).toEqual({ role: "admin" });
    expect(replaceRoleBodySchema.safeParse({ role: "root" }).success).toBe(false);

    expect(setStatusBodySchema.parse({ status: "disabled" })).toEqual({ status: "disabled" });
    expect(setStatusBodySchema.safeParse({ status: "pending" }).success).toBe(false);

    expect(
      createAgentLinkBodySchema.parse({ agentId: "agent-001", relation: "supervisor" }),
    ).toEqual({ agentId: "agent-001", relation: "supervisor" });
    expect(
      createAgentLinkBodySchema.safeParse({ agentId: "agent-001", relation: "administrator" })
        .success,
    ).toBe(false);
    expect(
      createAgentLinkBodySchema.safeParse({ agentId: "../../agent", relation: "observer" }).success,
    ).toBe(false);
  });
});
