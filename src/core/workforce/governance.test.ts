import { describe, expect, it } from "vitest";

import {
  activeDescendantCount,
  authorizeAssignment,
  evaluateAgentCreation,
  evaluateAgentStatusChange,
  evaluatePolicyChange,
  isAgentTransitionAllowed,
  isAssignmentTransitionAllowed,
  memoryScopeWithin,
  namespaceAllowed,
  policyWithin,
  type Verdict,
} from "./governance";
import type { AgentPolicy } from "./contracts";
import { composeRole } from "./role-composer";
import {
  BOUNDS,
  LATER,
  NOW,
  agent,
  asAgent,
  child,
  grant,
  owner,
  policy,
  request,
  role,
  skill,
} from "./test-fixtures";

const violations = (v: Verdict | { allowed: boolean; violations?: string[] }) =>
  v.allowed ? [] : (v as { violations: string[] }).violations;

const root = agent();

const spawn = (
  candidate = child(root),
  over: Partial<Parameters<typeof evaluateAgentCreation>[0]> = {},
) =>
  evaluateAgentCreation({
    principal: asAgent(root.agentId),
    candidate,
    supervisor: root,
    role: role(),
    org: [root],
    bounds: BOUNDS,
    now: NOW,
    ...over,
  });

describe("workforce governance — Phase 11 proofs", () => {
  it("a well-formed spawn within the parent is allowed", () => {
    expect(spawn()).toEqual({ allowed: true });
  });

  describe("agent cannot self-elevate autonomy", () => {
    const target = child(root, { policy: policy({ autonomyLevel: 1 }) });
    const change = (principal = asAgent(target.agentId)) =>
      evaluatePolicyChange({
        principal,
        target,
        next: policy({ autonomyLevel: 2 }),
        supervisor: root,
        role: role(),
        now: NOW,
      });

    it("the agent itself is refused", () => {
      expect(violations(change())).toEqual(
        expect.arrayContaining(["SELF_MODIFICATION", "ACTOR_NOT_AUTHORIZED"]),
      );
    });
    it("its supervisor agent is refused too — only a human admin raises autonomy", () => {
      expect(violations(change(asAgent(root.agentId)))).toContain("ACTOR_NOT_AUTHORIZED");
    });
    it("a human WITHOUT agents.manage is refused", () => {
      expect(violations(change(owner({ permissions: ["cockpit.read"] })))).toContain(
        "ACTOR_NOT_AUTHORIZED",
      );
    });
    it("a human admin may raise it, but never above the role ceiling", () => {
      expect(change(owner())).toEqual({ allowed: true });
      const capped = evaluatePolicyChange({
        principal: owner(),
        target,
        next: policy({ autonomyLevel: 3 }),
        supervisor: root,
        role: role({ autonomyCeiling: 2 }),
        now: NOW,
      });
      expect(violations(capped)).toContain("AUTONOMY_EXCEEDS_ROLE_CEILING");
    });
    it("no agent is created above its role's autonomy ceiling, even within the parent", () => {
      const v = spawn(child(root, { policy: policy({ autonomyLevel: 2, toolGrants: [] }) }), {
        role: role({ autonomyCeiling: 1 }),
      });
      expect(violations(v)).toEqual(["AUTONOMY_EXCEEDS_ROLE_CEILING"]);
    });
    it("an agent cannot spawn a child above its own autonomy", () => {
      const low = agent({ policy: policy({ autonomyLevel: 1, toolGrants: [grant("repo_read")] }) });
      const v = spawn(child(low, { policy: policy({ autonomyLevel: 2 }) }), {
        principal: asAgent(low.agentId),
        supervisor: low,
        org: [low],
      });
      expect(violations(v)).toContain("AUTONOMY_EXCEEDS_PARENT");
    });
  });

  describe("skill does not imply permission", () => {
    const worker = child(root, { policy: policy({ toolGrants: [] }) });
    const assign = (a = worker) =>
      authorizeAssignment({
        supervisor: root,
        assignee: a,
        role: role(),
        skill: skill(),
        request: request(),
        assigneeAssignments: [],
        now: NOW,
      });
    it("holding the skill without the tool grant is refused MISSING_TOOL_GRANT", () => {
      expect(violations(assign())).toEqual(["MISSING_TOOL_GRANT"]);
    });
    it("an expired grant is no grant", () => {
      const expired = child(root, {
        policy: policy({
          toolGrants: [grant("repo_read", { delegatedBy: root.agentId, expiresAt: NOW })],
        }),
      });
      expect(violations(assign(expired))).toEqual(["MISSING_TOOL_GRANT"]);
    });
    it("a grant revoked from the supervisor after the spawn stops the child too (no policy drift)", () => {
      const narrowed = agent({
        policy: policy({ autonomyLevel: 3, toolGrants: [grant("scanners")] }),
      });
      const v = authorizeAssignment({
        supervisor: narrowed,
        assignee: child(narrowed),
        role: role(),
        skill: skill(),
        request: request(),
        assigneeAssignments: [],
        now: NOW,
      });
      expect(violations(v)).toEqual(["TOOL_NOT_HELD_BY_PARENT"]);
    });
    it("with a live grant the same assignment is allowed", () => {
      expect(assign(child(root)).allowed).toBe(true);
    });
  });

  describe("role does not imply tool access", () => {
    it("a composed role carries no tool field and a certified role grants nothing", () => {
      const result = composeRole({
        need: "AppSec",
        roleId: "APPSEC_AUDITOR",
        name: "AppSec auditor",
        capabilities: ["appsec"],
        agentKinds: ["EPHEMERAL_SPECIALIST"],
        skills: [skill()],
        existingRoles: [],
        createdBy: { kind: "agent", id: root.agentId },
      });
      expect(result.kind).toBe("DRAFT");
      if (result.kind !== "DRAFT") return;
      expect(Object.keys(result.role).some((k) => /tool|grant|permission/i.test(k))).toBe(false);
    });
  });

  describe("child cannot exceed parent policy", () => {
    it.each([
      ["AUTONOMY_EXCEEDS_PARENT", { autonomyLevel: 3 as const }, 2],
      ["BUDGET_EXCEEDS_PARENT", { budget: { computeUnits: 101, financialCents: 0 } }, 3],
      [
        "BOUNDS_EXCEED_PARENT",
        { bounds: { maxDepth: 5, maxDescendants: 10, maxConcurrentAssignments: 3 } },
        3,
      ],
      [
        "TOOL_NOT_HELD_BY_PARENT",
        { toolGrants: [grant("crm_write", { delegatedBy: "agent-root" })] },
        3,
      ],
    ] as const)("%s", (expected, over, parentAutonomy) => {
      const parent = policy({ autonomyLevel: parentAutonomy, toolGrants: [grant("repo_read")] });
      expect(policyWithin(policy(over as Partial<AgentPolicy>), parent, NOW)).toContain(expected);
    });

    it("a delegated grant naming a human who never granted the parent is refused (forged provenance)", () => {
      const forged = policy({
        toolGrants: [
          grant("repo_read", {
            delegatedBy: "agent-root",
            grantedBy: { kind: "human", id: "someone-else" },
          }),
        ],
      });
      expect(policyWithin(forged, root.policy, NOW)).toContain("TOOL_NOT_HELD_BY_PARENT");
    });

    it("a delegated grant cannot carry actions the parent does not hold", () => {
      const parent = policy({ toolGrants: [grant("repo_read", { actions: ["read"] })] });
      const wider = (actions: string[]) =>
        policy({ toolGrants: [grant("repo_read", { delegatedBy: "agent-root", actions })] });
      expect(policyWithin(wider(["read", "write"]), parent, NOW)).toContain(
        "TOOL_NOT_HELD_BY_PARENT",
      );
      expect(policyWithin(wider(["*"]), parent, NOW)).toContain("TOOL_NOT_HELD_BY_PARENT");
      expect(policyWithin(wider(["read"]), parent, NOW)).toEqual([]);
    });
    it("a delegated grant cannot outlive the parent's grant", () => {
      const parent = policy({ toolGrants: [grant("repo_read", { expiresAt: LATER })] });
      const longer = policy({
        toolGrants: [
          grant("repo_read", { delegatedBy: "agent-root", expiresAt: "2027-01-01T00:00:00.000Z" }),
        ],
      });
      expect(policyWithin(longer, parent, NOW)).toContain("TOOL_NOT_HELD_BY_PARENT");
    });

    it("a human admin cannot attribute a new grant to another human, even as a fake pass-down (root has no parent to contain it)", () => {
      const v = evaluatePolicyChange({
        principal: owner(),
        target: root,
        next: {
          ...root.policy,
          toolGrants: [
            ...root.policy.toolGrants,
            grant("crm_write", {
              grantedBy: { kind: "human", id: "someone-else" },
              delegatedBy: "agent-x",
            }),
          ],
        },
        supervisor: null,
        role: role({ autonomyCeiling: 3 }),
        now: NOW,
      });
      expect(violations(v)).toEqual(["GRANT_NOT_FROM_PRINCIPAL"]);
    });
    it("extending an existing grant's expiry counts as a new grant", () => {
      const withExpiry = child(root, {
        policy: policy({
          toolGrants: [grant("repo_read", { delegatedBy: root.agentId, expiresAt: LATER })],
        }),
      });
      const v = evaluatePolicyChange({
        principal: owner({ id: "admin-2" }),
        target: withExpiry,
        next: policy({ toolGrants: [grant("repo_read", { delegatedBy: root.agentId })] }),
        supervisor: root,
        role: role(),
        now: NOW,
      });
      expect(violations(v)).toContain("GRANT_NOT_FROM_PRINCIPAL");
    });
    it("budgets are allocations: siblings together never exceed the parent", () => {
      const sibling = child(root, {
        agentId: "agent-sibling",
        policy: policy({ toolGrants: [], budget: { computeUnits: 60, financialCents: 0 } }),
      });
      const next = child(root, {
        policy: policy({
          toolGrants: [grant("repo_read", { delegatedBy: root.agentId })],
          budget: { computeUnits: 50, financialCents: 0 },
        }),
      });
      expect(violations(spawn(next, { org: [root, sibling] }))).toEqual(["BUDGET_EXCEEDS_PARENT"]);
      expect(spawn(next, { org: [root, { ...sibling, status: "retired" }] })).toEqual({
        allowed: true,
      });
    });
    it("an agent cannot mint a grant: a spawned grant must be delegated by the spawning parent", () => {
      const minted = child(root, { policy: policy({ toolGrants: [grant("repo_read")] }) });
      expect(violations(spawn(minted))).toContain("GRANT_NOT_FROM_PRINCIPAL");
    });
  });

  describe("agent cannot escape client/project scope", () => {
    it("a child with a wider client scope is refused", () => {
      const narrow = agent({ scope: { clientIds: ["belle-intendance"], projectIds: [] } });
      const wide = child(narrow, { scope: { clientIds: ["*"], projectIds: [] } });
      expect(violations(spawn(wide, { supervisor: narrow, org: [narrow] }))).toContain(
        "SCOPE_ESCAPE",
      );
    });
    it("a child reading memory outside the parent's namespaces is refused", () => {
      const narrow = agent({
        memoryScope: { read: ["tenant/default/client/a"], write: [], maxVisibility: "private" },
      });
      const escaping = child(narrow, {
        memoryScope: { read: ["tenant/default/client/b"], write: [], maxVisibility: "private" },
        scope: narrow.scope,
      });
      expect(violations(spawn(escaping, { supervisor: narrow, org: [narrow] }))).toContain(
        "MEMORY_SCOPE_ESCAPE",
      );
    });
    it("memory: broader visibility or longer (or unbounded) retention than the parent is refused", () => {
      const parent = {
        read: ["a"],
        write: ["a"],
        maxVisibility: "restricted" as const,
        retentionDays: 30,
      };
      expect(memoryScopeWithin({ ...parent, maxVisibility: "tenant" }, parent)).toBe(false);
      expect(memoryScopeWithin({ ...parent, retentionDays: 31 }, parent)).toBe(false);
      expect(
        memoryScopeWithin({ read: ["a"], write: ["a"], maxVisibility: "private" }, parent),
      ).toBe(false);
      expect(
        memoryScopeWithin({ ...parent, maxVisibility: "private", retentionDays: 7 }, parent),
      ).toBe(true);
    });
    it("work for another client is refused", () => {
      const v = authorizeAssignment({
        supervisor: root,
        assignee: child(root),
        role: role(),
        skill: skill(),
        request: request({ scope: { clientId: "lds-renov" } }),
        assigneeAssignments: [],
        now: NOW,
      });
      expect(violations(v)).toEqual(["SCOPE_ESCAPE"]);
    });
  });

  describe("bounded spawning", () => {
    it("MAX_DESCENDANTS counts active transitive descendants", () => {
      const capped = agent({
        policy: { ...root.policy, bounds: { ...root.policy.bounds, maxDescendants: 1 } },
      });
      const existing = child(capped, { agentId: "agent-existing" });
      expect(activeDescendantCount(capped.agentId, [capped, existing], NOW)).toBe(1);
      expect(
        violations(spawn(child(capped), { supervisor: capped, org: [capped, existing] })),
      ).toContain("MAX_DESCENDANTS");
    });
    it("expired or blocked descendants do not count", () => {
      const capped = agent({
        policy: { ...root.policy, bounds: { ...root.policy.bounds, maxDescendants: 1 } },
      });
      const blocked = child(capped, { agentId: "agent-blocked", status: "blocked" });
      const expired = child(capped, { agentId: "agent-expired", expiresAt: NOW });
      const leaf = child(capped, {
        policy: policy({
          toolGrants: [grant("repo_read", { delegatedBy: capped.agentId })],
          bounds: { maxDepth: 4, maxDescendants: 0, maxConcurrentAssignments: 3 },
        }),
      });
      expect(spawn(leaf, { supervisor: capped, org: [capped, blocked, expired] })).toEqual({
        allowed: true,
      });
    });
    it("MAX_DEPTH: absolute depth is bounded by the parent policy and the organisation", () => {
      const shallow = agent({
        policy: { ...root.policy, bounds: { ...root.policy.bounds, maxDepth: 0 } },
      });
      expect(violations(spawn(child(shallow), { supervisor: shallow, org: [shallow] }))).toContain(
        "MAX_DEPTH",
      );
      expect(violations(spawn(child(root), { bounds: { ...BOUNDS, maxDepth: 0 } }))).toContain(
        "MAX_DEPTH",
      );
    });
    it("MAX_AGENTS is organisation wide", () => {
      expect(violations(spawn(child(root), { bounds: { ...BOUNDS, maxAgents: 1 } }))).toContain(
        "MAX_AGENTS",
      );
    });
    it("an EXECUTION_WORKER spawns nothing; an agent never spawns a DURABLE agent", () => {
      const worker = child(root, {
        agentId: "agent-worker",
        kind: "EXECUTION_WORKER",
        workerId: "w-1",
      });
      const grandchild = child(worker, {
        agentId: "agent-gc",
        kind: "EXECUTION_WORKER",
        workerId: "w-2",
      });
      expect(
        violations(
          spawn(grandchild, {
            principal: asAgent(worker.agentId),
            supervisor: worker,
            org: [root, worker],
          }),
        ),
      ).toContain("SPAWN_KIND_FORBIDDEN");
      const durable = child(root, {
        kind: "DURABLE_AGENT",
        expiresAt: undefined,
        missionId: undefined,
      });
      expect(violations(spawn(durable))).toContain("ACTOR_NOT_AUTHORIZED");
    });
    it("an ephemeral child cannot outlive an ephemeral parent", () => {
      const eph = child(root);
      const longer = child(eph, {
        agentId: "agent-gc",
        kind: "EXECUTION_WORKER",
        workerId: "w-1",
        expiresAt: "2027-01-01T00:00:00.000Z",
      });
      expect(
        violations(
          spawn(longer, { principal: asAgent(eph.agentId), supervisor: eph, org: [root, eph] }),
        ),
      ).toContain("EXPIRY_AFTER_PARENT");
    });
    it("only one root per tenant, created by a human", () => {
      expect(
        violations(
          evaluateAgentCreation({
            principal: owner(),
            candidate: agent({ agentId: "agent-root2" }),
            supervisor: null,
            role: role(),
            org: [root],
            bounds: BOUNDS,
            now: NOW,
          }),
        ),
      ).toContain("SPAWN_KIND_FORBIDDEN");
    });
    it("a claimed supervisor that does not exist is not the root", () => {
      const orphan = agent({ agentId: "agent-orphan", supervisorAgentId: "agent-ghost", depth: 1 });
      expect(
        violations(
          evaluateAgentCreation({
            principal: owner(),
            candidate: orphan,
            supervisor: null,
            role: role(),
            org: [],
            bounds: BOUNDS,
            now: NOW,
          }),
        ),
      ).toContain("SUPERVISOR_NOT_IN_CHAIN");
    });
  });

  describe("bounded concurrency and compute", () => {
    const worker = child(root, {
      policy: policy({
        toolGrants: [grant("repo_read", { delegatedBy: root.agentId })],
        bounds: { maxDepth: 4, maxDescendants: 0, maxConcurrentAssignments: 1 },
        budget: { computeUnits: 15, financialCents: 0 },
      }),
    });
    const open = {
      assigneeAgentId: worker.agentId,
      status: "executing" as const,
      computeUnits: 10,
    };
    const assign = (existing: object[], req = request()) =>
      authorizeAssignment({
        supervisor: root,
        assignee: worker,
        role: role(),
        skill: skill(),
        request: req,
        assigneeAssignments: existing as never,
        now: NOW,
      });
    it("CONCURRENCY_LIMIT from open assignments", () => {
      expect(violations(assign([open]))).toContain("CONCURRENCY_LIMIT");
    });
    it("COMPUTE_BUDGET_EXCEEDED from committed assignments (derived, not a counter)", () => {
      expect(violations(assign([{ ...open, status: "accepted" }]))).toEqual([
        "COMPUTE_BUDGET_EXCEEDED",
      ]);
      expect(assign([{ ...open, status: "blocked" }]).allowed).toBe(true);
    });
  });

  describe("terminal BLOCK is respected", () => {
    it("no transition leaves a blocked agent, even by a human admin", () => {
      expect(isAgentTransitionAllowed("blocked", "active")).toBe(false);
      const blocked = child(root, { status: "blocked" });
      expect(
        violations(
          evaluateAgentStatusChange({ principal: owner(), target: blocked, to: "active" }),
        ),
      ).toContain("TERMINAL_STATUS");
      expect(
        violations(
          evaluatePolicyChange({
            principal: owner(),
            target: blocked,
            next: blocked.policy,
            supervisor: root,
            role: role(),
            now: NOW,
          }),
        ),
      ).toContain("TERMINAL_STATUS");
    });
    it("no transition leaves a blocked assignment", () => {
      for (const to of ["assigned", "executing", "in_review", "accepted", "synthesized"] as const) {
        expect(isAssignmentTransitionAllowed("blocked", to)).toBe(false);
      }
    });
    it("a blocked agent receives no work", () => {
      const v = authorizeAssignment({
        supervisor: root,
        assignee: child(root, { status: "blocked" }),
        role: role(),
        skill: skill(),
        request: request(),
        assigneeAssignments: [],
        now: NOW,
      });
      expect(violations(v)).toContain("AGENT_NOT_ACTIVE");
    });
    it("an expired ephemeral receives no work", () => {
      const v = authorizeAssignment({
        supervisor: root,
        assignee: child(root, { expiresAt: NOW }),
        role: role(),
        skill: skill(),
        request: request(),
        assigneeAssignments: [],
        now: NOW,
      });
      expect(violations(v)).toContain("AGENT_EXPIRED");
    });
    it("an agent may retire itself but never re-activate itself", () => {
      const self = child(root, { status: "suspended" });
      expect(
        evaluateAgentStatusChange({
          principal: asAgent(self.agentId),
          target: self,
          to: "retired",
        }),
      ).toEqual({ allowed: true });
      expect(
        violations(
          evaluateAgentStatusChange({
            principal: asAgent(self.agentId),
            target: self,
            to: "active",
          }),
        ),
      ).toContain("ACTOR_NOT_AUTHORIZED");
    });
  });

  describe("delegation stays in the chain", () => {
    it("only the direct supervisor may assign", () => {
      const other = agent({ agentId: "agent-other" });
      const v = authorizeAssignment({
        supervisor: other,
        assignee: child(root),
        role: role(),
        skill: skill(),
        request: request(),
        assigneeAssignments: [],
        now: NOW,
      });
      expect(violations(v)).toContain("SUPERVISOR_NOT_IN_CHAIN");
    });
    it("approval is required for an action class the skill gates", () => {
      const v = authorizeAssignment({
        supervisor: root,
        assignee: child(root),
        role: role(),
        skill: skill({ approvalRequiredFor: ["destructive_remediation"] }),
        request: request({ actionClass: "destructive_remediation" }),
        assigneeAssignments: [],
        now: NOW,
      });
      expect(v).toMatchObject({ allowed: true, requiresApproval: true });
    });
  });
});

describe("namespace containment refuses traversal", () => {
  const scope = (read: string[], write: string[] = read) => ({
    read,
    write,
    maxVisibility: "private" as const,
  });

  it("refuses a `..` segment that only LOOKS contained by prefix", () => {
    // `tenant/a/../escape` commence par `tenant/a/` mais en sort : la comparaison étant
    // préfixielle, sans garde ce namespace passerait pour un descendant légitime.
    expect(memoryScopeWithin(scope(["tenant/a/../escape"]), scope(["tenant/a"]))).toBe(false);
  });

  it("refuses traversal on the write side too", () => {
    expect(
      memoryScopeWithin(scope(["tenant/a"], ["tenant/a/../escape"]), scope(["tenant/a"])),
    ).toBe(false);
  });

  it("refuses traversal even when the parent holds everything", () => {
    expect(memoryScopeWithin(scope(["tenant/a/../escape"]), scope(["*"]))).toBe(false);
  });

  it.each([
    ["nested traversal", "a/b/../../x"],
    ["trailing traversal", "a/b/.."],
    ["lower-case percent encoding", "a/b/%2e%2e/x"],
    ["upper-case percent encoding", "a/b/%2E%2E/x"],
    ["an encoded separator", "a/b/%2e%2e%2fescape"],
    ["double encoding", "a/b/%252e%252e/escape"],
    ["backslash separators", "a\\b\\..\\escape"],
  ])("refuses %s", (_case, namespace) => {
    expect(memoryScopeWithin(scope([namespace]), scope(["a/b"]))).toBe(false);
  });

  it.each([
    ["an empty namespace", ""],
    ["a whitespace-only namespace", " \t "],
    ["an empty interior segment", "a//b"],
    ["a whitespace-only interior segment", "a/ \t /b"],
  ])("refuses %s", (_case, namespace) => {
    expect(namespaceAllowed(namespace, ["a"])).toBe(false);
  });

  it("normalizes `.` segments on both sides of the comparison", () => {
    expect(namespaceAllowed("a/./b", ["a/b"])).toBe(true);
    expect(namespaceAllowed("a/b", ["a/./b"])).toBe(true);
  });

  it("normalizes leading and trailing separators on both sides", () => {
    expect(namespaceAllowed("/a/b/", ["a/b"])).toBe(true);
    expect(namespaceAllowed("a/b", ["/a/b/"])).toBe(true);
  });

  it("fails closed when a parent pattern cannot be canonicalized", () => {
    expect(namespaceAllowed("a/b", ["a/../b"])).toBe(false);
    expect(namespaceAllowed("a/b", ["*", "a//b"])).toBe(false);
  });

  it("still allows a genuine descendant and an exact match", () => {
    expect(memoryScopeWithin(scope(["tenant/a/b"]), scope(["tenant/a"]))).toBe(true);
    expect(memoryScopeWithin(scope(["tenant/a"]), scope(["tenant/a"]))).toBe(true);
  });

  it("still lets `*` hold every canonical namespace", () => {
    expect(namespaceAllowed("outside/anywhere", ["*"])).toBe(true);
  });

  it("does not mistake a sibling whose name merely starts with the parent", () => {
    expect(memoryScopeWithin(scope(["tenant/abc"]), scope(["tenant/ab"]))).toBe(false);
  });

  it("gates encoded traversal during agent creation", () => {
    const narrow = agent({ memoryScope: scope(["tenant/a"]) });
    const escaping = child(narrow, {
      memoryScope: scope(["tenant/a/%252e%252e/escape"]),
      scope: narrow.scope,
    });
    expect(violations(spawn(escaping, { supervisor: narrow, org: [narrow] }))).toContain(
      "MEMORY_SCOPE_ESCAPE",
    );
  });
});
