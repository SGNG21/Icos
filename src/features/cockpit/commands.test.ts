import { describe, expect, it, vi } from "vitest";

import {
  canSubmit,
  confirmationPolicy,
  createCommand,
  mayResubmit,
  notWiredTransport,
  reconcileCommand,
  submitCommand,
  type CommandTransport,
  type ControlCommand,
} from "./commands";

const target = { kind: "worker", id: "w1", label: "hermes-01" } as const;
const none = { acknowledged: false, typed: "", reauthenticated: false };

describe("ControlCommand", () => {
  it("carries id, idempotency key, risk and version; no client-asserted actor", () => {
    const cmd = createCommand({ action: "worker.stop", target, expectedStateVersion: "v7" }, new Date("2026-09-28T00:00:00Z"));
    expect(cmd).toMatchObject({ riskClass: "MEDIUM", expectedStateVersion: "v7", issuedAt: "2026-09-28T00:00:00.000Z" });
    expect(cmd.commandId).not.toBe(cmd.idempotencyKey);
    expect(cmd).not.toHaveProperty("actor");
  });
});

describe("dangerous-action confirmation", () => {
  it("maps risk to confirmation policy", () => {
    expect(confirmationPolicy("LOW").kind).toBe("single");
    expect(confirmationPolicy("MEDIUM").kind).toBe("explicit");
    expect(confirmationPolicy("HIGH").kind).toBe("typed_reauth");
    expect(confirmationPolicy("CRITICAL").kind).toBe("escalation");
  });

  it("requires acknowledgement for MEDIUM", () => {
    const cmd = createCommand({ action: "mission.stop", target: { kind: "mission", id: "m", label: "M" } });
    expect(canSubmit(cmd, none)).toBe(false);
    expect(canSubmit(cmd, { ...none, acknowledged: true })).toBe(true);
  });

  it("requires the typed target AND re-auth for HIGH", () => {
    const cmd = createCommand({ action: "system.stop_external_workers", target: { kind: "system", id: "icos", label: "ICOS" } });
    expect(canSubmit(cmd, { acknowledged: true, typed: "ICOS", reauthenticated: false })).toBe(false);
    expect(canSubmit(cmd, { acknowledged: true, typed: "icos", reauthenticated: true })).toBe(false);
    expect(canSubmit(cmd, { acknowledged: true, typed: "ICOS", reauthenticated: true })).toBe(true);
  });

  it("never lets CRITICAL execute from the UI", () => {
    const cmd = { ...createCommand({ action: "worker.stop", target }), riskClass: "CRITICAL" } as ControlCommand;
    expect(canSubmit(cmd, { acknowledged: true, typed: target.label, reauthenticated: true })).toBe(false);
  });
});

describe("idempotent submission", () => {
  it("reports NOT YET WIRED instead of success while the bus is missing", async () => {
    const out = await submitCommand(notWiredTransport, createCommand({ action: "worker.pause", target }));
    expect(out.status).toBe("not_wired");
  });

  it("turns a dropped request into UNKNOWN_EXECUTION_STATE and forbids blind retry", async () => {
    const transport: CommandTransport = { submit: vi.fn().mockRejectedValue(new Error("offline")), status: vi.fn() };
    const out = await submitCommand(transport, createCommand({ action: "worker.stop", target }));
    expect(out.status).toBe("unknown_execution_state");
    expect(mayResubmit(out)).toBe(false);
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it("allows resubmission of the SAME command only after the server proves it never received it", async () => {
    const cmd = createCommand({ action: "worker.stop", target });
    const status = vi.fn().mockResolvedValueOnce("not_found").mockResolvedValueOnce({ status: "executed" });
    const transport: CommandTransport = { submit: vi.fn(), status };
    const first = await reconcileCommand(transport, cmd);
    expect(first.status).toBe("not_received");
    expect(mayResubmit(first)).toBe(true);
    expect(status).toHaveBeenCalledWith(cmd.commandId);

    const second = await reconcileCommand(transport, cmd);
    expect(second.status).toBe("executed");
    expect(mayResubmit(second)).toBe(false);
  });

  it("stays UNKNOWN when reconciliation itself fails", async () => {
    const transport: CommandTransport = { submit: vi.fn(), status: vi.fn().mockRejectedValue(new Error("x")) };
    expect((await reconcileCommand(transport, createCommand({ action: "worker.stop", target }))).status).toBe(
      "unknown_execution_state",
    );
  });
});
