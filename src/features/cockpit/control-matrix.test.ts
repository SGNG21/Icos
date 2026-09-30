import { describe, expect, it, vi } from "vitest";

import {
  COMMAND_SPECS,
  CONTROL_COMMAND_TYPES,
  RUNTIME_TARGET_ID,
  confirmationPhrase,
  controlCommandRequestSchema,
  controlCommandResultSchema,
  type ControlCommandResult,
  type ControlCommandType,
  type ControlTarget,
  type RejectionCode,
} from "@/core/control/contracts";

import {
  buildRequest,
  dialogMode,
  executeCommand,
  httpControlTransport,
  needsReauth,
  proofUsable,
  reconcileCommand,
  resultTrail,
} from "./commands";

/**
 * Lifecycle matrix for all 7 commands against a fake backend that reproduces the HTTP mapping
 * of feat/control-foundation `src/server/control/http.ts` (statusForResult/statusForRejection).
 * Re-run against the real routes after merge (see INTEGRATION_MANIFEST.md).
 */
const statusForRejection = (code: RejectionCode): number =>
  ({
    INVALID_REQUEST: 422,
    TARGET_KIND_MISMATCH: 422,
    FORBIDDEN: 403,
    TARGET_NOT_FOUND: 404,
    VERSION_CONFLICT: 409,
    INVALID_TRANSITION: 409,
    IDEMPOTENCY_KEY_REUSED: 409,
    SESSION_TOO_OLD: 428,
    REAUTH_REQUIRED: 428,
    REAUTH_INVALID: 428,
    REAUTH_EXPIRED: 428,
    CONFIRMATION_REQUIRED: 428,
    CONTROL_STATE_UNAVAILABLE: 503,
  })[code];
const statusFor = (r: ControlCommandResult) =>
  r.status === "EXECUTED"
    ? 200
    : r.status === "UNKNOWN_EXECUTION_STATE"
      ? 202
      : r.status === "FAILED"
        ? 409
        : statusForRejection(r.rejection!.code);

const KEY = "3f1c2a64-8a4e-4d7b-9a51-0c2f6b1e9d11";
const CMD = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const targetOf = (type: ControlCommandType): ControlTarget =>
  COMMAND_SPECS[type].target === "mission"
    ? { kind: "mission", id: "m-1" }
    : COMMAND_SPECS[type].target === "worker"
      ? { kind: "worker", id: "5d2b9c1e-7f3a-4e8b-a1c2-3d4e5f6a7b8c" }
      : { kind: "runtime", id: RUNTIME_TARGET_ID };

function backend(type: ControlCommandType, over: Partial<ControlCommandResult>) {
  const result: ControlCommandResult = {
    commandId: CMD,
    type,
    target: targetOf(type),
    riskClass: COMMAND_SPECS[type].risk,
    status: "EXECUTED",
    reauth: needsReauth(type) ? "SATISFIED" : "NOT_REQUIRED",
    rejection: null,
    expectedVersion: 4,
    version: 5,
    auditEntryId: `ctl-${CMD}-executed`,
    replayed: false,
    createdAt: "2026-09-30T08:00:00.000Z",
    completedAt: "2026-09-30T08:00:00.000Z",
    ...over,
  };
  controlCommandResultSchema.parse(result); // fixtures must be valid backend results
  return vi.fn(
    async () =>
      new Response(JSON.stringify(result), {
        status: statusFor(result),
        headers: { "content-type": "application/json" },
      }),
  );
}

const requestFor = (type: ControlCommandType) =>
  buildRequest({
    type,
    target: targetOf(type),
    expectedVersion: 4,
    reason: "integration matrix",
    idempotencyKey: KEY,
    reauthProof: needsReauth(type) ? "p".repeat(43) : undefined,
    confirmation: confirmationPhrase(type, targetOf(type)),
  });

const reject = (code: RejectionCode) => ({
  status: "REJECTED" as const,
  rejection: { code, message: code },
  version: null,
});

describe.each(CONTROL_COMMAND_TYPES)("%s lifecycle", (type) => {
  const run = async (over: Partial<ControlCommandResult>) =>
    executeCommand(httpControlTransport(backend(type, over)), requestFor(type));

  it("builds a request the backend schema accepts (risk fixed server-side)", () => {
    const req = requestFor(type);
    expect(controlCommandRequestSchema.parse(req)).toEqual(req); // strict backend schema
    expect(req.type).toBe(type);
    expect("riskClass" in req).toBe(false);
    expect(Boolean(req.reauthProof)).toBe(needsReauth(type));
    expect(req.confirmation !== undefined).toBe(COMMAND_SPECS[type].risk === "CRITICAL");
  });

  it("EXECUTED → SUCCEEDED with version and audit trail", async () => {
    const o = await run({});
    expect(o.phase).toBe("SUCCEEDED");
    expect(resultTrail(o.result!).join(" ")).toMatch(/Version 4 → 5.*Audit ctl-/);
  });

  it("replayed EXECUTED is displayed as a replay, not a second execution", async () => {
    const o = await run({ replayed: true });
    expect(o.phase).toBe("SUCCEEDED");
    expect(resultTrail(o.result!)[0]).toContain("nothing ran a second time");
  });

  it("FAILED (409) and UNKNOWN_EXECUTION_STATE (202) stay distinct from REJECTED", async () => {
    expect((await run({ status: "FAILED" })).phase).toBe("FAILED");
    const unknown = await run({ status: "UNKNOWN_EXECUTION_STATE", completedAt: null });
    expect(unknown.phase).toBe("UNKNOWN");
    expect(dialogMode(unknown.phase, true, unknown)).toBe("reconcile");
  });

  it("typed rejections are REJECTED with guidance; re-auth rejections restart", async () => {
    for (const code of [
      "VERSION_CONFLICT",
      "INVALID_TRANSITION",
      "FORBIDDEN",
      "SESSION_TOO_OLD",
    ] as const) {
      const o = await run(reject(code));
      expect(o.phase, code).toBe("REJECTED");
      expect(dialogMode(o.phase, true, o), code).toBe("restart");
    }
    expect((await run(reject("SESSION_TOO_OLD"))).detail).toContain("sign in again");
    for (const code of ["REAUTH_REQUIRED", "REAUTH_INVALID", "REAUTH_EXPIRED"] as const) {
      const o = await run(reject(code));
      expect(o.phase, code).toBe("AUTH_REQUIRED");
      expect(dialogMode(o.phase, true, o), code).toBe("restart"); // key spent → fresh key
    }
  });

  it("route absent → NOT_CONNECTED; reconcile of UNKNOWN reads the stored result", async () => {
    const missing = vi.fn(async () => new Response("<html>404</html>", { status: 404 }));
    expect((await executeCommand(httpControlTransport(missing), requestFor(type))).phase).toBe(
      "NOT_CONNECTED",
    );
    const stored = backend(type, {});
    const o = await reconcileCommand(httpControlTransport(stored), requestFor(type), {
      ...(JSON.parse(await (await backend(type, {})()).text()) as ControlCommandResult),
      status: "UNKNOWN_EXECUTION_STATE",
    });
    expect(stored).toHaveBeenCalledWith(`/api/control/commands/${CMD}`, expect.anything());
    expect(o.phase).toBe("SUCCEEDED");
  });
});

describe("re-auth proof window", () => {
  it("an expired or about-to-expire proof is not sent (the key stays unspent)", () => {
    const now = Date.parse("2026-09-30T08:00:00Z");
    expect(proofUsable("2026-09-30T08:04:00Z", now)).toBe(true);
    expect(proofUsable("2026-09-30T08:00:03Z", now)).toBe(false);
    expect(proofUsable("2026-09-30T07:59:00Z", now)).toBe(false);
    expect(proofUsable(null, now)).toBe(false);
  });
});
