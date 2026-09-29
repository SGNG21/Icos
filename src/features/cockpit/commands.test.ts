import { describe, expect, it, vi } from "vitest";

import type { ControlCommandResult, ControlState } from "@/core/control/contracts";

import {
  buildRequest,
  confirmationPhrase,
  executeCommand,
  httpControlTransport,
  loadVersion,
  needsReauth,
  phaseOfResult,
  reauthenticate,
  reconcileCommand,
  runtimeFlagRows,
  type ControlTransport,
} from "./commands";

const KEY = "3f1c2a64-8a4e-4d7b-9a51-0c2f6b1e9d11";
const WORKER = "5d2b9c1e-7f3a-4e8b-a1c2-3d4e5f6a7b8c";
const CMD = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const result = (over: Partial<ControlCommandResult> = {}): ControlCommandResult => ({
  commandId: CMD,
  type: "DISABLE_WORKER",
  target: { kind: "worker", id: WORKER },
  riskClass: "MEDIUM",
  status: "EXECUTED",
  reauth: "NOT_REQUIRED",
  rejection: null,
  expectedVersion: 3,
  version: 4,
  auditEntryId: `ctl-${CMD}-executed`,
  replayed: false,
  createdAt: "2026-09-29T10:00:00.000Z",
  completedAt: "2026-09-29T10:00:00.000Z",
  ...over,
});

const state: ControlState = {
  runtime: {
    stored: null,
    effective: {
      safeMode: true,
      dispatchEnabled: false,
      integrationEnabled: false,
      externalActionsEnabled: false,
    },
    version: null,
  },
  missions: [{ id: "m1", held: false, version: 2 }],
  workers: [{ id: WORKER, version: 3 }],
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const request = buildRequest({
  type: "DISABLE_WORKER",
  target: { kind: "worker", id: WORKER },
  expectedVersion: 3,
  reason: "looping on the same task",
  idempotencyKey: KEY,
});

describe("request contract (decision 0044)", () => {
  it("builds a strict backend request: no actor, no risk, no command id, no password", () => {
    expect(Object.keys(request).sort()).toEqual(
      ["expectedVersion", "idempotencyKey", "reason", "target", "type"].sort(),
    );
  });

  it("CRITICAL carries the exact confirmation phrase; HIGH/CRITICAL need re-auth", () => {
    const target = { kind: "runtime", id: "global" } as const;
    const phrase = confirmationPhrase("EXIT_SAFE_MODE", target);
    expect(phrase).toBe("EXIT_SAFE_MODE runtime:global");
    const req = buildRequest({
      type: "EXIT_SAFE_MODE",
      target,
      expectedVersion: 1,
      reason: "incident resolved",
      idempotencyKey: KEY,
      reauthProof: "p".repeat(43),
      confirmation: phrase,
    });
    expect(req.confirmation).toBe(phrase);
    expect(needsReauth("EXIT_SAFE_MODE")).toBe(true);
    expect(needsReauth("CANCEL_MISSION")).toBe(true);
    expect(needsReauth("ENTER_SAFE_MODE")).toBe(false);
    expect(needsReauth("PAUSE_MISSION")).toBe(false);
  });

  it("refuses a reason the backend would refuse", () => {
    expect(() => buildRequest({ ...request, reason: "x" })).toThrow();
  });
});

describe("HTTP transport", () => {
  it("a route missing from the deployment is NOT_CONNECTED, never success", async () => {
    const fetch = vi.fn(async () => new Response("<html>404</html>", { status: 404 }));
    const outcome = await executeCommand(httpControlTransport(fetch), request);
    expect(outcome.phase).toBe("NOT_CONNECTED");
    expect(fetch).toHaveBeenCalledWith(
      "/api/control/commands",
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("an ICOS 404 envelope is a rejection, not NOT_CONNECTED", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(404, { error: { code: "not_found", message: "command not found" } }),
    );
    const reply = await httpControlTransport(fetch).get(CMD);
    expect(reply).toMatchObject({ kind: "error", status: 404, code: "not_found" });
  });

  it("maps typed results to the UI lifecycle", async () => {
    for (const [status, body, phase] of [
      [200, result(), "SUCCEEDED"],
      [202, result({ status: "UNKNOWN_EXECUTION_STATE" }), "UNKNOWN"],
      [409, result({ status: "FAILED" }), "FAILED"],
      [
        409,
        result({ status: "REJECTED", rejection: { code: "VERSION_CONFLICT", message: "v5" } }),
        "REJECTED",
      ],
      [
        428,
        result({ status: "REJECTED", rejection: { code: "REAUTH_EXPIRED", message: "old" } }),
        "AUTH_REQUIRED",
      ],
    ] as const) {
      const fetch = vi.fn(async () => jsonResponse(status, body));
      expect((await executeCommand(httpControlTransport(fetch), request)).phase).toBe(phase);
    }
  });

  it("network failure or a 5xx after sending is UNKNOWN; 503 is UNAVAILABLE", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("network");
    });
    expect((await executeCommand(httpControlTransport(down), request)).phase).toBe("UNKNOWN");
    const crash = vi.fn(async () => jsonResponse(500, { error: { code: "internal", message: "" } }));
    expect((await executeCommand(httpControlTransport(crash), request)).phase).toBe("UNKNOWN");
    const off = vi.fn(async () =>
      jsonResponse(503, { error: { code: "persistence_unavailable", message: "x" } }),
    );
    expect((await executeCommand(httpControlTransport(off), request)).phase).toBe("UNAVAILABLE");
  });

  it("route-level refusals (401/403/422) are REJECTED: nothing executed", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(403, { error: { code: "forbidden", message: "cockpit.read" } }),
    );
    expect((await executeCommand(httpControlTransport(fetch), request)).phase).toBe("REJECTED");
  });
});

describe("version", () => {
  const transport = (reply: Awaited<ReturnType<ControlTransport["state"]>>): ControlTransport => ({
    state: async () => reply,
    reauth: vi.fn(),
    submit: vi.fn(),
    get: vi.fn(),
  });

  it("reads the target version from the control plane", async () => {
    expect(
      await loadVersion(transport({ kind: "ok", status: 200, value: state }), {
        kind: "worker",
        id: WORKER,
      }),
    ).toEqual({ ok: true, version: 3 });
  });

  it("an unreadable runtime version (fail-closed flags) blocks the command", async () => {
    const r = await loadVersion(transport({ kind: "ok", status: 200, value: state }), {
      kind: "runtime",
      id: "global",
    });
    expect(r).toMatchObject({ ok: false, outcome: { phase: "UNAVAILABLE" } });
  });

  it("a mission absent from the scoped state is not sendable", async () => {
    const r = await loadVersion(transport({ kind: "ok", status: 200, value: state }), {
      kind: "mission",
      id: "not-mine",
    });
    expect(r.ok).toBe(false);
  });

  it("missing control API is NOT_CONNECTED", async () => {
    const r = await loadVersion(transport({ kind: "not_connected" }), {
      kind: "mission",
      id: "m1",
    });
    expect(r).toMatchObject({ ok: false, outcome: { phase: "NOT_CONNECTED" } });
  });
});

describe("reconciliation never double-executes", () => {
  it("without a command id it resends the IDENTICAL request (server dedupes on the key)", async () => {
    const submit = vi.fn(async () => ({
      kind: "ok" as const,
      status: 200,
      value: result({ replayed: true }),
    }));
    const t: ControlTransport = { state: vi.fn(), reauth: vi.fn(), submit, get: vi.fn() };
    const outcome = await reconcileCommand(t, request);
    expect(submit).toHaveBeenCalledWith(request);
    expect(outcome.result?.replayed).toBe(true);
  });

  it("with a command id it only reads the stored result", async () => {
    const get = vi.fn(async () => ({ kind: "ok" as const, status: 200, value: result() }));
    const submit = vi.fn();
    const t: ControlTransport = { state: vi.fn(), reauth: vi.fn(), submit, get };
    const outcome = await reconcileCommand(
      t,
      request,
      result({ status: "UNKNOWN_EXECUTION_STATE" }),
    );
    expect(get).toHaveBeenCalledWith(CMD);
    expect(submit).not.toHaveBeenCalled();
    expect(outcome.phase).toBe("SUCCEEDED");
  });
});

describe("re-authentication", () => {
  it("returns the server proof; a wrong password stays AUTH_REQUIRED", async () => {
    const ok = vi.fn(async () =>
      jsonResponse(200, { proof: "x".repeat(43), expiresAt: "2026-09-29T10:05:00Z" }),
    );
    expect(await reauthenticate(httpControlTransport(ok), "pw")).toMatchObject({ ok: true });
    expect(ok).toHaveBeenCalledWith(
      "/api/control/reauth",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "pw" }) }),
    );
    const bad = vi.fn(async () =>
      jsonResponse(401, { error: { code: "unauthenticated", message: "re-authentication failed" } }),
    );
    expect(await reauthenticate(httpControlTransport(bad), "no")).toMatchObject({
      ok: false,
      outcome: { phase: "AUTH_REQUIRED" },
    });
  });

  it("phaseOfResult: only EXECUTED is success", () => {
    expect(phaseOfResult(result({ status: "UNKNOWN_EXECUTION_STATE" }))).not.toBe("SUCCEEDED");
    expect(phaseOfResult(result({ status: "FAILED" }))).not.toBe("SUCCEEDED");
  });
});

describe("runtime flags view", () => {
  it("an unreadable flag row is fail-closed and never shown healthy", () => {
    const rows = runtimeFlagRows(state);
    expect(rows.find((r) => r.key === "safeMode")).toMatchObject({ effective: true, tone: "critical" });
    expect(rows.every((r) => r.stored === null)).toBe(true);
    expect(rows.some((r) => r.tone === "ok")).toBe(false);
  });

  it("healthy only when stored and effective agree and work is flowing", () => {
    const on = { safeMode: false, dispatchEnabled: true, integrationEnabled: true, externalActionsEnabled: true };
    const rows = runtimeFlagRows({ ...state, runtime: { stored: on, effective: on, version: 7 } });
    expect(rows.every((r) => r.tone === "ok")).toBe(true);
  });
});
