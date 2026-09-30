import { beforeEach, describe, expect, it } from "vitest";

import { WorkforceDeniedError, WorkforceService } from "./workforce-service";
import {
  as,
  bootstrap,
  buildOrg,
  certifier,
  execute,
  head,
  makeService,
  owner,
  policyOf,
  req,
  sessionOf,
  specialist,
} from "./test-support";

/**
 * Business examples (Phase 10) and governance proofs (Phase 11) through the governed service.
 * The flows are DATA over a generic engine — nothing here is a hardcoded workflow. Execution
 * facts are SIMULATED: no worker runs in a unit test, and the records say so.
 */

const denial = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(WorkforceDeniedError);

describe("digital workforce — business examples (Phase 10)", () => {
  let service: WorkforceService;
  beforeEach(() => {
    ({ service } = makeService());
  });

  it("A. Audit ICOS cybersecurity: Central → Security Lead → AppSec + Secrets/IAM → independent review → consolidated result", async () => {
    await buildOrg(service, ["CYBER_SECURITY_LEAD", "APPSEC_SPECIALIST", "SECRETS_IAM_AUDITOR"]);
    await head(
      service,
      "security-lead",
      "CYBER_SECURITY_LEAD",
      "security",
      ["repo_read", "scanners", "logs"],
      ["icos"],
    );

    const top = await service.delegate(as("icos-central"), {
      requests: [req("mission-sec", "security-audit", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    expect(top.gaps).toEqual([]);
    const leadTask = top.assignments[0];
    expect(leadTask).toMatchObject({
      assigneeAgentId: "security-lead",
      skillId: "CYBER_SECURITY_AUDIT",
    });
    await service.start(as("security-lead"), leadTask.assignmentId);

    await specialist(
      service,
      "security-lead",
      "appsec-1",
      "APPSEC_SPECIALIST",
      ["repo_read", "scanners"],
      ["icos"],
    );
    await specialist(
      service,
      "security-lead",
      "secrets-iam-1",
      "SECRETS_IAM_AUDITOR",
      ["repo_read", "logs"],
      ["icos"],
    );

    const sub = await service.delegate(as("security-lead"), {
      requests: [
        req("mission-sec", "appsec-review", ["appsec", "code_security"], "icos"),
        req("mission-sec", "secrets-iam-review", ["secrets_audit", "iam_review"], "icos"),
      ],
      parentAssignmentId: leadTask.assignmentId,
    });
    expect(sub.assignments.map((a) => [a.taskId, a.assigneeAgentId, a.parentAssignmentId])).toEqual(
      [
        ["appsec-review", "appsec-1", leadTask.assignmentId],
        ["secrets-iam-review", "secrets-iam-1", leadTask.assignmentId],
      ],
    );

    // The Security Lead holds INDEPENDENT_REVIEW and is not the assignee of either child.
    for (const a of sub.assignments) await execute(service, a, "security-lead");
    await service.synthesize(as("security-lead"), {
      missionId: "mission-sec",
      parentAssignmentId: leadTask.assignmentId,
      summary: "2 domains audited",
    });
    await service.recordExecution(as("security-lead"), leadTask.assignmentId, {
      workerId: "hermes-security-lead",
      result: "succeeded",
      source: "SIMULATED",
      startedAt: "2026-09-29T10:00:00.000Z",
      finishedAt: "2026-09-29T10:10:00.000Z",
      evidence: sub.assignments.map((a) => `assignment://${a.assignmentId}`),
    });
    // The consolidated result is reviewed OUTSIDE the lead's subtree.
    await denial(service.review(as("security-lead"), leadTask.assignmentId, "APPROVE"));
    await service.review(as("central-reviewer"), leadTask.assignmentId, "APPROVE");
    await service.synthesize(as("icos-central"), {
      missionId: "mission-sec",
      parentAssignmentId: null,
      summary: "ICOS security audit consolidated",
    });

    const all = await service.listAssignments(owner);
    expect(all.every((a) => a.status === "synthesized")).toBe(true);
    expect(all.every((a) => a.execution?.workerId && a.review?.reviewerAgentId)).toBe(true);
    const types = (await service.listEvents(owner)).map((e) => e.type);
    expect(types.filter((t) => t === "agent.spawned")).toHaveLength(2);
    expect(types.filter((t) => t === "observation.recorded")).toHaveLength(3);
    expect(await service.performance(owner, { includeNonReal: true })).toMatchObject({
      count: 3,
      successRate: 1,
    });
    expect(await service.performance(owner)).toMatchObject({ count: 0, successRate: null });
  });

  it("B. Premium identity for Belle Intendance: Art Director → strategist, UI/UX, copywriter, visual → review; publication gated; client scope held", async () => {
    await buildOrg(service, [
      "ART_DIRECTOR",
      "BRAND_STRATEGIST",
      "UX_DESIGNER",
      "COPYWRITER",
      "VISUAL_DESIGNER",
    ]);
    const client = ["belle-intendance"];
    await head(
      service,
      "art-director",
      "ART_DIRECTOR",
      "marketing-brand",
      [
        "design_read",
        "web_research",
        "design_write",
        "docs_write",
        "image_generation",
        "repo_read",
      ],
      client,
    );
    const top = await service.delegate(as("icos-central"), {
      requests: [req("mission-bi", "identity", ["brand_identity"], "belle-intendance")],
      parentAssignmentId: null,
    });
    await service.start(as("art-director"), top.assignments[0].assignmentId);

    await specialist(
      service,
      "art-director",
      "strategist-1",
      "BRAND_STRATEGIST",
      ["web_research"],
      client,
    );
    await specialist(service, "art-director", "ux-1", "UX_DESIGNER", ["design_write"], client);
    await specialist(service, "art-director", "copy-1", "COPYWRITER", ["docs_write"], client);
    await specialist(
      service,
      "art-director",
      "visual-1",
      "VISUAL_DESIGNER",
      ["image_generation"],
      client,
      "EXECUTION_WORKER",
    );

    const parentAssignmentId = top.assignments[0].assignmentId;
    const sub = await service.delegate(as("art-director"), {
      requests: [
        req("mission-bi", "positioning", ["brand_strategy"], "belle-intendance"),
        req("mission-bi", "ui", ["ui_design", "ux_design"], "belle-intendance"),
        req("mission-bi", "copy", ["copywriting"], "belle-intendance"),
        req("mission-bi", "visuals", ["visual_design"], "belle-intendance", "external_publication"),
        req("mission-bi", "other-client", ["copywriting"], "lds-renov"),
      ],
      parentAssignmentId,
    });
    // The work for another client has no eligible report: the scope is held.
    expect(
      sub.gaps.map((g) => [g.request.taskId, g.rejected.flatMap((r) => r.violations)]),
    ).toEqual([["other-client", expect.arrayContaining(["SCOPE_ESCAPE"])]]);
    const visuals = sub.assignments.find((a) => a.taskId === "visuals")!;
    expect(visuals.approval).toMatchObject({ required: true });
    await denial(service.start(as("visual-1"), visuals.assignmentId));
    await denial(service.approve(as("art-director"), visuals.assignmentId));
    await service.approve(owner, visuals.assignmentId);

    for (const a of sub.assignments) await execute(service, a, "art-director");
    const done = await service.synthesize(as("art-director"), {
      missionId: "mission-bi",
      parentAssignmentId,
      summary: "Identity system delivered",
    });
    expect(done.parent?.synthesis?.childAssignmentIds).toHaveLength(4);
  });

  it("C. 50 qualified opportunities: Sales Director → researcher, SDR, CRM operator, copywriter → analytics review; spawning is bounded", async () => {
    await buildOrg(service, [
      "SALES_DIRECTOR",
      "RESEARCHER",
      "SDR",
      "CRM_OPERATOR",
      "COPYWRITER",
      "ANALYTICS_REVIEWER",
    ]);
    const clients = ["*"];
    await head(
      service,
      "sales-director",
      "SALES_DIRECTOR",
      "sales",
      [
        "crm_read",
        "web_research",
        "email_draft",
        "crm_write",
        "docs_write",
        "analytics_read",
        "repo_read",
      ],
      clients,
      5,
    );
    const top = await service.delegate(as("icos-central"), {
      requests: [req("mission-sales", "opportunities-50", ["pipeline_management"], "holding")],
      parentAssignmentId: null,
    });
    await service.start(as("sales-director"), top.assignments[0].assignmentId);

    await specialist(
      service,
      "sales-director",
      "researcher-1",
      "RESEARCHER",
      ["web_research"],
      clients,
    );
    await specialist(
      service,
      "sales-director",
      "sdr-1",
      "SDR",
      ["crm_read", "email_draft"],
      clients,
    );
    await specialist(
      service,
      "sales-director",
      "crm-1",
      "CRM_OPERATOR",
      ["crm_write"],
      clients,
      "EXECUTION_WORKER",
    );
    await specialist(service, "sales-director", "copy-1", "COPYWRITER", ["docs_write"], clients);
    await specialist(
      service,
      "sales-director",
      "analytics-1",
      "ANALYTICS_REVIEWER",
      ["crm_read", "analytics_read", "repo_read"],
      clients,
    );
    // maxDescendants = 5: a sixth concurrent specialist is refused and the refusal is durable.
    await denial(specialist(service, "sales-director", "sdr-2", "SDR", ["crm_read"], clients));
    const denied = (await service.listEvents(owner)).filter(
      (e) => e.type === "governance.denied" && e.subjectId === "sdr-2",
    );
    expect(denied[0]?.details).toMatchObject({
      action: "agent.create",
      violations: ["MAX_DESCENDANTS"],
    });

    const parentAssignmentId = top.assignments[0].assignmentId;
    const sub = await service.delegate(as("sales-director"), {
      requests: [
        req("mission-sales", "research-accounts", ["lead_research"], "holding"),
        req(
          "mission-sales",
          "qualify-leads",
          ["lead_qualification", "outreach"],
          "holding",
          "external_outreach",
        ),
        req("mission-sales", "record-crm", ["crm_data_entry"], "holding", "bulk_crm_update"),
        req("mission-sales", "outreach-copy", ["copywriting"], "holding"),
      ],
      parentAssignmentId,
    });
    expect(sub.gaps).toEqual([]);
    for (const a of sub.assignments) {
      if (a.approval.required) await service.approve(owner, a.assignmentId);
      // The analytics reviewer verifies the qualification work; the director reviews the rest.
      await execute(service, a, a.taskId === "qualify-leads" ? "analytics-1" : "sales-director");
    }
    expect(sub.assignments.filter((a) => a.approval.required).map((a) => a.taskId)).toEqual([
      "qualify-leads",
      "record-crm",
    ]);
    await service.synthesize(as("sales-director"), {
      missionId: "mission-sales",
      parentAssignmentId,
      summary: "Pipeline built",
    });
    const perf = await service.performance(owner, { agentId: "sdr-1", includeNonReal: true });
    expect(perf).toMatchObject({ count: 1, successRate: 1, observationIds: [expect.any(String)] });
  });

  it("dynamic role: 'Create an expert in French BTP tenders' — gap, new skills, draft, certification, activation, no grant implied", async () => {
    await buildOrg(service, []);
    const need = {
      need: "Create an expert in French BTP tenders",
      roleId: "FRENCH_BTP_TENDER_EXPERT",
      name: "French BTP tender expert",
      capabilities: ["public_procurement_fr", "tender_analysis", "btp_costing", "copywriting"],
      agentKinds: ["EPHEMERAL_SPECIALIST" as const],
    };
    expect(await service.proposeRole(as("icos-central"), need)).toMatchObject({
      kind: "INCOMPLETE",
      uncoveredCapabilities: ["btp_costing", "public_procurement_fr", "tender_analysis"],
    });

    await denial(service.registerSkill(as("icos-central"), bootstrap.skills[0]));
    const base = {
      version: "1.0.0",
      inputs: [],
      outputs: [],
      requiredPermissions: [],
      approvalRequiredFor: [],
      evidenceRequirements: ["dce_analysis"],
      qualityGates: ["independent_review"],
      compatibleAgentKinds: ["EPHEMERAL_SPECIALIST" as const],
      compute: { reasoning: "deep" as const, workerCapabilities: [], modelHints: [] },
      implementedBy: [],
      status: "active" as const,
    };
    await service.registerSkill(owner, {
      ...base,
      skillId: "FRENCH_PUBLIC_PROCUREMENT",
      name: "French public procurement",
      description: "Code de la commande publique, DCE analysis",
      capabilities: ["public_procurement_fr", "tender_analysis"],
      requiredTools: ["web_research"],
      risk: "MEDIUM",
      tests: ["skill.fpp.dce_fixture"],
    });
    await service.registerSkill(owner, {
      ...base,
      skillId: "BTP_COSTING",
      name: "BTP costing",
      description: "Construction cost estimation (DPGF/BPU)",
      capabilities: ["btp_costing"],
      requiredTools: ["finance_read"],
      risk: "HIGH",
      tests: ["skill.btp.costing_fixture"],
    });

    const draft = await service.proposeRole(as("icos-central"), need);
    expect(draft).toMatchObject({ kind: "DRAFT", role: { status: "draft", autonomyCeiling: 2 } });
    await denial(
      service.certifyRole(as("icos-central"), need.roleId, "1.0.0", [
        "skill.fpp.dce_fixture",
        "skill.btp.costing_fixture",
        "skill.copywriting.fixture",
      ]),
    );
    await denial(service.certifyRole(certifier, need.roleId, "1.0.0", ["skill.fpp.dce_fixture"]));
    await service.certifyRole(certifier, need.roleId, "1.0.0", [
      "skill.btp.costing_fixture",
      "skill.copywriting.fixture",
      "skill.fpp.dce_fixture",
    ]);
    await service.activateRole(owner, need.roleId, "1.0.0");

    // Registered, spawnable — and holding nothing it was not given.
    const expert = await service.createAgent(as("icos-central"), {
      agentId: "btp-expert-1",
      kind: "EPHEMERAL_SPECIALIST",
      roleId: need.roleId,
      roleVersion: "1.0.0",
      displayName: "BTP tender expert",
      supervisorAgentId: "icos-central",
      scope: { clientIds: ["lds-renov"], projectIds: ["*"] },
      memoryScope: { read: ["tenant/default/client/lds-renov"], write: [] },
      missionId: "mission-btp",
      expiresAt: "2026-09-30T10:00:00.000Z",
      policy: policyOf({
        autonomyLevel: 1,
        tools: ["web_research"],
        delegatedBy: "icos-central",
        bounds: { maxDepth: 3, maxDescendants: 0, maxConcurrentAssignments: 2 },
      }),
    });
    expect(expert.policy.toolGrants.map((g) => g.toolId)).toEqual(["web_research"]);
    const plan = await service.delegate(as("icos-central"), {
      requests: [
        req("mission-btp", "dce", ["tender_analysis"], "lds-renov"),
        req("mission-btp", "costing", ["btp_costing"], "lds-renov"),
      ],
      parentAssignmentId: null,
    });
    expect(plan.assignments.map((a) => a.taskId)).toEqual(["dce"]);
    expect(plan.gaps[0].rejected.find((r) => r.agentId === "btp-expert-1")?.violations).toEqual([
      "MISSING_TOOL_GRANT",
    ]);
  });
});

describe("digital workforce — governance through the service (Phase 11)", () => {
  let service: WorkforceService;
  beforeEach(async () => {
    ({ service } = makeService());
    await buildOrg(service, ["CYBER_SECURITY_LEAD", "APPSEC_SPECIALIST"]);
    await head(
      service,
      "security-lead",
      "CYBER_SECURITY_LEAD",
      "security",
      ["repo_read", "scanners", "logs"],
      ["icos"],
    );
  });

  it("an agent cannot raise its own autonomy; the refusal is durable and nothing changes", async () => {
    const before = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await denial(
      service.changePolicy(as("security-lead"), "security-lead", {
        ...before.policy,
        autonomyLevel: 3,
      }),
    );
    const after = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    expect(after).toEqual(before);
    const events = await service.listEvents(owner);
    expect(events.at(-1)).toMatchObject({
      type: "governance.denied",
      actor: { kind: "agent", id: "security-lead" },
      details: { violations: expect.arrayContaining(["SELF_MODIFICATION"]) },
    });
  });

  it("a human admin cannot exceed the role ceiling or the supervisor", async () => {
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await denial(
      service.changePolicy(owner, "security-lead", { ...lead.policy, autonomyLevel: 3 }),
    );
    await denial(
      service.changePolicy(owner, "security-lead", {
        ...lead.policy,
        budget: { computeUnits: 10_000_000, financialCents: 0 },
      }),
    );
  });

  it("an admin cannot stamp a grant in another human's name", async () => {
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    const forged = {
      toolId: "logs",
      grantedBy: { kind: "human" as const, id: "someone-else" },
      actions: ["*"],
      grantedAt: "2026-09-29T09:00:00.000Z",
    };
    await denial(
      service.changePolicy(owner, "security-lead", {
        ...lead.policy,
        toolGrants: [...lead.policy.toolGrants, forged],
      }),
    );
  });

  it("BLOCK is terminal: a blocked agent is never re-activated and receives no work", async () => {
    await service.changeStatus(owner, "security-lead", "blocked");
    await denial(service.changeStatus(owner, "security-lead", "active"));
    const plan = await service.delegate(as("icos-central"), {
      requests: [req("m", "t", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    expect(plan.assignments).toEqual([]);
    expect(plan.gaps[0].rejected.find((r) => r.agentId === "security-lead")?.violations).toEqual([
      "AGENT_NOT_ACTIVE",
    ]);
  });

  it("a blocked agent cannot start work it was given before the block", async () => {
    const plan = await service.delegate(as("icos-central"), {
      requests: [req("m", "t", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.changeStatus(owner, "security-lead", "blocked");
    await denial(service.start(as("security-lead"), plan.assignments[0].assignmentId));
  });

  it("authority is re-checked at start: a grant revoked after assignment stops the work", async () => {
    const plan = await service.delegate(as("icos-central"), {
      requests: [req("m", "t", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", {
      ...lead.policy,
      toolGrants: lead.policy.toolGrants.filter((g) => g.toolId !== "logs"),
    });
    await denial(service.start(as("security-lead"), plan.assignments[0].assignmentId));
    const last = (await service.listEvents(owner)).at(-1);
    expect(last?.details).toMatchObject({ violations: ["MISSING_TOOL_GRANT"] });
  });

  it("child work stays in its parent's mission lineage", async () => {
    const plan = await service.delegate(as("icos-central"), {
      requests: [req("mission-a", "t", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.start(as("security-lead"), plan.assignments[0].assignmentId);
    await denial(
      service.delegate(as("security-lead"), {
        requests: [req("mission-b", "t2", ["appsec"], "icos")],
        parentAssignmentId: plan.assignments[0].assignmentId,
      }),
    );
  });

  it("revoking a supervisor's grant stops its spawned children from receiving tool work", async () => {
    await specialist(
      service,
      "security-lead",
      "appsec-1",
      "APPSEC_SPECIALIST",
      ["repo_read", "scanners"],
      ["icos"],
    );
    const top = await service.delegate(as("icos-central"), {
      requests: [req("m", "audit", ["threat_modeling"], "icos")],
      parentAssignmentId: null,
    });
    await service.start(as("security-lead"), top.assignments[0].assignmentId);
    const lead = (await service.listAgents(owner)).find((a) => a.agentId === "security-lead")!;
    await service.changePolicy(owner, "security-lead", {
      ...lead.policy,
      toolGrants: lead.policy.toolGrants.filter((g) => g.toolId !== "scanners"),
    });
    const plan = await service.delegate(as("security-lead"), {
      requests: [req("m", "appsec", ["appsec"], "icos")],
      parentAssignmentId: top.assignments[0].assignmentId,
    });
    expect(plan.assignments).toEqual([]);
    expect(plan.gaps[0].rejected).toEqual([
      { agentId: "appsec-1", violations: ["TOOL_NOT_HELD_BY_PARENT"] },
    ]);
  });

  it("a delegation cannot be driven by someone who is not the supervisor agent", async () => {
    await denial(
      service.delegate(owner, {
        requests: [req("m", "t", ["threat_modeling"], "icos")],
        parentAssignmentId: null,
      }),
    );
  });

  it("a human without cockpit.read cannot read the workforce", async () => {
    await denial(service.listAgents(sessionOf("no-role-user", [])));
  });

  it("the event journal records every accepted change with its actor", async () => {
    const events = await service.listEvents(owner);
    expect(
      events.filter((e) => e.type === "agent.created").map((e) => [e.subjectId, e.actor.id]),
    ).toEqual([
      ["icos-central", "owner-1"],
      ["central-reviewer", "owner-1"],
      ["security-lead", "owner-1"],
    ]);
  });
});
