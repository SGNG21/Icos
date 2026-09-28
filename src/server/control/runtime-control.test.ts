import { describe, expect, it, vi } from "vitest";

import type { RuntimeFlags } from "@/core/control/contracts";
import { effectiveFlags } from "@/core/control/policy";

import {
  ControlGatedDispatcher,
  ControlHeldError,
  RuntimeControlGuard,
  assertExternalActionAllowed,
} from "./runtime-control";

const flags = (over: Partial<RuntimeFlags> = {}): RuntimeFlags => ({
  safeMode: false,
  dispatchEnabled: true,
  integrationEnabled: true,
  externalActionsEnabled: true,
  ...over,
});
const guardOver = (f: RuntimeFlags | Error, held: boolean | Error = false) =>
  new RuntimeControlGuard({
    readFlags: async () => {
      if (f instanceof Error) throw f;
      return f;
    },
    isHeld: async () => {
      if (held instanceof Error) throw held;
      return held;
    },
  });

describe("effective flags", () => {
  it("safe mode forces dispatch, integration and external actions off", () => {
    expect(effectiveFlags(flags({ safeMode: true }))).toEqual({
      safeMode: true,
      dispatchEnabled: false,
      integrationEnabled: false,
      externalActionsEnabled: false,
    });
  });

  it("an unreadable flags row turns everything off", () => {
    expect(effectiveFlags(null)).toMatchObject({
      dispatchEnabled: false,
      integrationEnabled: false,
      externalActionsEnabled: false,
    });
  });

  it("does not collapse integration and external actions", async () => {
    const g = guardOver(flags({ integrationEnabled: false }));
    expect(await g.integration()).toEqual({ allowed: false, reason: "INTEGRATION_DISABLED" });
    expect(await g.externalAction()).toEqual({ allowed: true });
  });
});

describe("RuntimeControlGuard", () => {
  it("allows normal operation", async () => {
    const g = guardOver(flags());
    expect(await g.dispatch("m1")).toEqual({ allowed: true });
    expect(await g.integration()).toEqual({ allowed: true });
    expect(await g.externalAction()).toEqual({ allowed: true });
  });

  it("safe mode blocks dispatch, integration and external actions", async () => {
    const g = guardOver(flags({ safeMode: true }));
    for (const d of [await g.dispatch("m1"), await g.integration(), await g.externalAction()]) {
      expect(d).toEqual({ allowed: false, reason: "SAFE_MODE" });
    }
  });

  it("a held mission does not dispatch, others do", async () => {
    expect(await guardOver(flags(), true).dispatch("m1")).toEqual({
      allowed: false,
      reason: "MISSION_HELD",
    });
    expect(await guardOver(flags(), true).dispatch()).toEqual({ allowed: true });
  });

  it("fails closed when flags or holds cannot be read", async () => {
    const down = guardOver(new Error("db down"));
    for (const d of [
      await down.dispatch(),
      await down.integration(),
      await down.externalAction(),
    ]) {
      expect(d).toEqual({ allowed: false, reason: "CONTROL_STATE_UNAVAILABLE" });
    }
    expect(await guardOver(flags(), new Error("db down")).dispatch("m1")).toEqual({
      allowed: false,
      reason: "CONTROL_STATE_UNAVAILABLE",
    });
  });
});

describe("canonical external-action guard", () => {
  it("throws CONTROL_HELD when external actions are off", async () => {
    await expect(
      assertExternalActionAllowed(guardOver(flags({ externalActionsEnabled: false })), "publish"),
    ).rejects.toMatchObject({
      code: "CONTROL_HELD",
      reason: "EXTERNAL_ACTIONS_DISABLED",
    });
    await expect(
      assertExternalActionAllowed(guardOver(flags()), "publish"),
    ).resolves.toBeUndefined();
  });
});

describe("dispatcher backstop", () => {
  it("refuses instead of dispatching when a path missed its admission guard", async () => {
    const inner = { dispatch: vi.fn().mockResolvedValue({ workflowId: "wf" }) };
    const gated = new ControlGatedDispatcher(inner, guardOver(flags({ safeMode: true })));
    await expect(
      gated.dispatch({ taskId: "t", prompt: "p", missionId: "m1" }),
    ).rejects.toBeInstanceOf(ControlHeldError);
    expect(inner.dispatch).not.toHaveBeenCalled();
  });

  it("passes through when allowed", async () => {
    const inner = { dispatch: vi.fn().mockResolvedValue({ workflowId: "wf" }) };
    const gated = new ControlGatedDispatcher(inner, guardOver(flags()));
    await expect(gated.dispatch({ taskId: "t", prompt: "p" }, "/facade")).resolves.toEqual({
      workflowId: "wf",
    });
    expect(inner.dispatch).toHaveBeenCalledWith({ taskId: "t", prompt: "p" }, "/facade");
  });
});
