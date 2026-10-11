import { describe, expect, it } from "vitest";

import {
  checkScopeAgreement,
  executionScopeFromGoal,
  scopeAuditDetails,
  scopeOfMetadata,
  scopePayloadFields,
} from "./execution-scope";

describe("ExecutionScope (decision 0063 amendment A)", () => {
  const lds = { clientId: "lds-renov", projectId: null };

  it("is read from the goal's metadata, with tenant, ids and data level", () => {
    expect(
      executionScopeFromGoal({
        missionId: "m-1",
        taskId: "t-1",
        goalId: "g-1",
        metadata: { clientId: "lds-renov", tenantId: "default", source: "cognitive_conversation" },
      }),
    ).toEqual({
      tenantId: "default",
      clientId: "lds-renov",
      projectId: null,
      missionId: "m-1",
      taskId: "t-1",
      goalId: "g-1",
      policyContext: { source: "cognitive_conversation" },
      allowedDataScope: "client",
    });
  });

  it("a goal with no client is unscoped work at tenant level, never a guessed client", () => {
    const s = executionScopeFromGoal({ missionId: "m", goalId: null, metadata: null });
    expect(s).toMatchObject({ clientId: null, projectId: null, allowedDataScope: "tenant" });
  });

  it("a project without its client is never carried alone", () => {
    expect(scopeOfMetadata({ projectId: "p" })).toEqual({ clientId: null, projectId: "p" });
    const s = executionScopeFromGoal({ missionId: "m", goalId: "g", metadata: { projectId: "p" } });
    expect(s).toMatchObject({ clientId: null, projectId: null, allowedDataScope: "tenant" });
    expect(
      executionScopeFromGoal({
        missionId: "m",
        goalId: "g",
        metadata: { clientId: "c", projectId: "p" },
      }).allowedDataScope,
    ).toBe("project");
  });

  it("payload fields omit absent values (no present-and-null jsonb keys)", () => {
    expect(scopePayloadFields({ clientId: "lds-renov" })).toEqual({ clientId: "lds-renov" });
    expect(scopePayloadFields({})).toEqual({});
    expect(scopePayloadFields({ clientId: "" })).toEqual({});
  });

  it("FAIL_CLOSED: a presented scope must equal the canonical one", () => {
    expect(checkScopeAgreement(lds, { clientId: "lds-renov" })).toEqual({ ok: true });
    // Absent = the pre-carriage shape: the canonical value applies.
    expect(checkScopeAgreement(lds, {})).toEqual({ ok: true });
    expect(checkScopeAgreement(lds, { clientId: "editions-du-mecene" })).toEqual({
      ok: false,
      reason: "EXECUTION_SCOPE_MISMATCH",
      field: "clientId",
    });
    // Unscoped work may never be relabelled as a client's.
    expect(
      checkScopeAgreement({ clientId: null, projectId: null }, { clientId: "lds-renov" }).ok,
    ).toBe(false);
    expect(checkScopeAgreement(lds, { projectId: "other" }).ok).toBe(false);
  });

  it("audit details carry ids only, and nothing for unscoped work", () => {
    expect(scopeAuditDetails({ clientId: "lds-renov", projectId: null })).toEqual({
      clientId: "lds-renov",
    });
    expect(scopeAuditDetails({ clientId: null, projectId: null })).toEqual({});
    expect(scopeAuditDetails(null)).toEqual({});
  });
});
