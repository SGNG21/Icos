import { describe, expect, it, vi } from "vitest";

import type { Agent, AuditEntry } from "@/core/contracts";
import type { HumanAgentLink } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import type {
  AdminHumanUser,
  AgentRepository,
  AuditRepository,
  HumanAgentLinkRepository,
  HumanUserAdministrationRepository,
} from "@/server/repositories/ports";
import type { HumanAdministrationResult, HumanAdministrationUnitOfWork } from "@/server/uow/ports";

import { HumanAdministrationService } from "./human-administration-service";

const users: AdminHumanUser[] = [
  {
    id: "human-operator",
    email: "operator@example.test",
    name: "Operator",
    status: "active",
    role: "operator",
  },
  {
    id: "human-viewer",
    email: "viewer@example.test",
    status: "disabled",
    role: "viewer",
  },
];

const agent: Agent = {
  id: "agent-cto",
  name: "CTO",
  role: "Direction technique",
  status: "available",
  authorizationLevel: 2,
  description: "Agent technique",
};

const link: HumanAgentLink = {
  id: "link-001",
  humanUserId: "human-operator",
  agentId: agent.id,
  relation: "supervisor",
  createdAt: "2026-07-23T10:00:00.000Z",
  createdByHumanUserId: "human-owner",
};

function harness(
  overrides: {
    findById?: HumanUserAdministrationRepository["findById"];
    findByEmail?: HumanUserAdministrationRepository["findByEmail"];
    getAgentById?: AgentRepository["getById"];
    createHumanUser?: AuthGateway["createHumanUser"];
    deleteHumanUser?: AuthGateway["deleteHumanUser"];
    appendAudit?: AuditRepository["append"];
    finalizeHumanCreation?: HumanAdministrationUnitOfWork["finalizeHumanCreation"];
    replaceRole?: HumanAdministrationUnitOfWork["replaceRole"];
    setStatus?: HumanAdministrationUnitOfWork["setStatus"];
    createAgentLink?: HumanAdministrationUnitOfWork["createAgentLink"];
    removeAgentLink?: HumanAdministrationUnitOfWork["removeAgentLink"];
  } = {},
) {
  const findById = vi.fn(
    overrides.findById ??
      (async (id: string) => users.find((candidate) => candidate.id === id) ?? null),
  );
  const findByEmail = vi.fn(
    overrides.findByEmail ??
      (async (email: string) => users.find((candidate) => candidate.email === email) ?? null),
  );
  const createHumanUser = vi.fn(
    overrides.createHumanUser ?? (async () => ({ ok: true as const, userId: "human-created" })),
  );
  const deleteHumanUser = vi.fn(overrides.deleteHumanUser ?? (async () => {}));
  const appendAudit = vi.fn(overrides.appendAudit ?? (async (entry: AuditEntry) => entry));

  const createdUser: AdminHumanUser = {
    id: "human-created",
    email: "created@example.test",
    status: "active",
    role: "viewer",
  };
  const success = <T>(value: T, changed = true): HumanAdministrationResult<T> => ({
    ok: true,
    value,
    changed,
  });

  const repositories = {
    users: {
      list: async () => [...users],
      findById,
      findByEmail,
    } satisfies HumanUserAdministrationRepository,
    links: {
      listForHuman: async (humanUserId: string) => (humanUserId === link.humanUserId ? [link] : []),
      listAgentIdsForHuman: async (humanUserId: string) =>
        new Set(humanUserId === link.humanUserId ? [link.agentId] : []),
    } satisfies HumanAgentLinkRepository,
    agents: {
      list: async () => [agent],
      listForScope: async () => [agent],
      getById: vi.fn(
        overrides.getAgentById ?? (async (id: string) => (id === agent.id ? agent : null)),
      ),
      getByIdForScope: async (id) => (id === agent.id ? agent : null),
    } satisfies AgentRepository,
    audit: {
      append: appendAudit,
      appendMany: async (entries) => [...entries],
      list: async () => [],
      query: async () => [],
    } satisfies AuditRepository,
  };

  const auth = {
    createHumanUser,
    readHumanUser: async () => null,
    readHumanUserByEmail: async () => null,
    deleteHumanUser,
    readSession: async () => null,
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  } satisfies AuthGateway;

  const uow = {
    finalizeHumanCreation: vi.fn(
      overrides.finalizeHumanCreation ?? (async () => success(createdUser)),
    ),
    replaceRole: vi.fn(
      overrides.replaceRole ??
        (async (input) =>
          success({ ...users[0], role: input.nextRole }, input.nextRole !== users[0].role)),
    ),
    setStatus: vi.fn(
      overrides.setStatus ??
        (async (input) =>
          success({ ...users[0], status: input.nextStatus }, input.nextStatus !== users[0].status)),
    ),
    createAgentLink: vi.fn(overrides.createAgentLink ?? (async () => success(link))),
    removeAgentLink: vi.fn(overrides.removeAgentLink ?? (async () => success(link))),
  } satisfies HumanAdministrationUnitOfWork;

  return {
    service: new HumanAdministrationService({
      auth,
      users: repositories.users,
      links: repositories.links,
      agents: repositories.agents,
      audit: repositories.audit,
      uow,
      now: () => "2026-07-23T10:00:00.000Z",
      newId: (prefix) => `${prefix}-001`,
    }),
    auth,
    uow,
    appendAudit,
    findByEmail,
  };
}

const actor = {
  actorUserId: "human-owner",
  actorRoles: ["owner"] as const,
};

describe("HumanAdministrationService", () => {
  it("liste les projections humaines et les liens d'une cible autorisée", async () => {
    const { service } = harness();

    await expect(service.listUsers()).resolves.toEqual(users);
    await expect(service.listLinks({ ...actor, targetUserId: "human-operator" })).resolves.toEqual({
      ok: true,
      value: [link],
      changed: false,
    });
  });

  it("crée l'identité via Better Auth puis finalise rôle et audit dans l'UoW", async () => {
    const { service, auth, uow } = harness();

    const result = await service.createHuman({
      ...actor,
      email: "created@example.test",
      password: "correct horse battery staple",
      role: "viewer",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: "human-created",
        email: "created@example.test",
        status: "active",
        role: "viewer",
      },
      changed: true,
    });
    expect(auth.createHumanUser).toHaveBeenCalledWith({
      email: "created@example.test",
      password: "correct horse battery staple",
      name: undefined,
    });
    expect(uow.finalizeHumanCreation).toHaveBeenCalledWith({
      targetUserId: "human-created",
      role: "viewer",
      actorUserId: "human-owner",
      auditId: "audit-001",
      occurredAt: "2026-07-23T10:00:00.000Z",
    });
  });

  it("refuse un rôle hors hiérarchie et audite le refus sans créer d'identité", async () => {
    const { service, auth, appendAudit } = harness();

    const result = await service.createHuman({
      actorUserId: "human-admin",
      actorRoles: ["admin"],
      email: "other-admin@example.test",
      password: "correct horse battery staple",
      role: "admin",
    });

    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(auth.createHumanUser).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "human_user.administration_denied",
        actor: { kind: "human", id: "human-admin" },
        details: { operation: "create", reason: "forbidden" },
      }),
    );
  });

  it("retourne audit_failed lorsque l'audit d'un refus échoue", async () => {
    const { service } = harness({
      appendAudit: async () => {
        throw new Error("audit unavailable");
      },
    });

    await expect(
      service.createHuman({
        actorUserId: "human-admin",
        actorRoles: ["admin"],
        email: "other-admin@example.test",
        password: "correct horse battery staple",
        role: "admin",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "audit_failed" });
  });

  it("détecte un email existant avant Better Auth et audite already_exists", async () => {
    const { service, auth, appendAudit } = harness();

    const result = await service.createHuman({
      ...actor,
      email: "operator@example.test",
      password: "correct horse battery staple",
      role: "viewer",
    });

    expect(result).toMatchObject({ ok: false, reason: "already_exists" });
    expect(auth.createHumanUser).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { operation: "create", reason: "already_exists" },
      }),
    );
  });

  it("mappe un refus Better Auth sans tenter de compensation", async () => {
    const { service, auth } = harness({
      createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    });

    await expect(
      service.createHuman({
        ...actor,
        email: "invalid@example.test",
        password: "correct horse battery staple",
        role: "viewer",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_input" });
    expect(auth.deleteHumanUser).not.toHaveBeenCalled();
  });

  it("compense l'identité créée lorsque la finalisation ICOS échoue", async () => {
    const { service, auth } = harness({
      finalizeHumanCreation: async () => ({
        ok: false,
        reason: "audit_failed",
        message: "audit indisponible",
      }),
    });

    const result = await service.createHuman({
      ...actor,
      email: "created@example.test",
      password: "correct horse battery staple",
      role: "viewer",
    });

    expect(result).toMatchObject({ ok: false, reason: "audit_failed" });
    expect(auth.deleteHumanUser).toHaveBeenCalledWith("human-created");
  });

  it.each(["résultat", "exception"])(
    "masque les détails lorsque la compensation échoue après un %s UoW",
    async (failureKind) => {
      const { service } = harness({
        finalizeHumanCreation:
          failureKind === "résultat"
            ? async () => ({ ok: false, reason: "audit_failed", message: "raw sql" })
            : async () => {
                throw new Error("raw sql");
              },
        deleteHumanUser: async () => {
          throw new Error("raw compensation failure");
        },
      });

      await expect(
        service.createHuman({
          ...actor,
          email: "created@example.test",
          password: "correct horse battery staple",
          role: "viewer",
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "internal_error",
        message: "administration humaine indisponible",
      });
    },
  );

  it("délègue le remplacement idempotent du rôle à l'UoW", async () => {
    const { service, uow } = harness();

    const result = await service.replaceRole({
      ...actor,
      targetUserId: "human-operator",
      role: "operator",
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(uow.replaceRole).toHaveBeenCalledOnce();
  });

  it("délègue le statut idempotent et la révocation éventuelle à l'UoW", async () => {
    const { service, uow } = harness();

    const result = await service.setStatus({
      ...actor,
      targetUserId: "human-operator",
      status: "active",
    });

    expect(result).toMatchObject({ ok: true, changed: false });
    expect(uow.setStatus).toHaveBeenCalledOnce();
  });

  it("refuse et audite une cible absente", async () => {
    const { service, uow, appendAudit } = harness();

    const result = await service.replaceRole({
      ...actor,
      targetUserId: "human-missing",
      role: "viewer",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(uow.replaceRole).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          operation: "role",
          targetUserId: "human-missing",
          reason: "not_found",
        },
      }),
    );
  });

  it("refuse et audite une cible hors hiérarchie", async () => {
    const { service, uow, appendAudit } = harness({
      findById: async () => ({
        id: "human-owner-2",
        email: "owner@example.test",
        status: "active",
        role: "owner",
      }),
    });

    const result = await service.setStatus({
      actorUserId: "human-admin",
      actorRoles: ["admin"],
      targetUserId: "human-owner-2",
      status: "disabled",
    });

    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(uow.setStatus).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          operation: "status",
          targetUserId: "human-owner-2",
          reason: "forbidden",
        },
      }),
    );
  });

  it("crée un lien seulement si la cible et l'agent existent", async () => {
    const { service, uow } = harness();

    const result = await service.createLink({
      ...actor,
      targetUserId: "human-operator",
      agentId: "agent-cto",
      relation: "supervisor",
    });

    expect(result).toEqual({ ok: true, value: link, changed: true });
    expect(uow.createAgentLink).toHaveBeenCalledWith({
      id: "link-001",
      targetUserId: "human-operator",
      agentId: "agent-cto",
      relation: "supervisor",
      actorUserId: "human-owner",
      auditId: "audit-001",
      occurredAt: "2026-07-23T10:00:00.000Z",
    });
  });

  it("refuse et audite un agent absent", async () => {
    const { service, uow, appendAudit } = harness({ getAgentById: async () => null });

    const result = await service.createLink({
      ...actor,
      targetUserId: "human-operator",
      agentId: "agent-missing",
      relation: "observer",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(uow.createAgentLink).not.toHaveBeenCalled();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          operation: "links",
          targetUserId: "human-operator",
          reason: "not_found",
        },
      }),
    );
  });

  it("propage et audite un lien dupliqué", async () => {
    const { service, appendAudit } = harness({
      createAgentLink: async () => ({
        ok: false,
        reason: "already_exists",
        message: "lien existant",
      }),
    });

    const result = await service.createLink({
      ...actor,
      targetUserId: "human-operator",
      agentId: "agent-cto",
      relation: "observer",
    });

    expect(result).toMatchObject({ ok: false, reason: "already_exists" });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          operation: "links",
          targetUserId: "human-operator",
          reason: "already_exists",
        },
      }),
    );
  });

  it("propage et audite un retrait absent", async () => {
    const { service, appendAudit } = harness({
      removeAgentLink: async () => ({
        ok: false,
        reason: "not_found",
        message: "lien absent",
      }),
    });

    const result = await service.removeLink({
      ...actor,
      targetUserId: "human-operator",
      agentId: "agent-cto",
    });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: {
          operation: "links",
          targetUserId: "human-operator",
          reason: "not_found",
        },
      }),
    );
  });
});
