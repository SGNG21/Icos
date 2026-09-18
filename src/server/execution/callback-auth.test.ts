import { describe, expect, it } from "vitest";

import { EXECUTION_CALLBACK_HEADER, verifyExecutionCallback } from "./callback-auth";

const VALID = "a".repeat(32);

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/internal/executions/started", {
    method: "POST",
    headers,
  });
}

describe("verifyExecutionCallback", () => {
  it("refuse si le secret n'est pas configuré", () => {
    const result = verifyExecutionCallback(req({ [EXECUTION_CALLBACK_HEADER]: VALID }), undefined);
    expect(result).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("refuse un secret trop court côté serveur (défense en profondeur)", () => {
    const result = verifyExecutionCallback(req({ [EXECUTION_CALLBACK_HEADER]: "short" }), "short");
    expect(result).toEqual({ ok: false, reason: "unconfigured" });
  });

  it("refuse en l'absence d'en-tête", () => {
    const result = verifyExecutionCallback(req(), VALID);
    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("refuse un secret différent (même longueur)", () => {
    const wrong = "b".repeat(32);
    const result = verifyExecutionCallback(req({ [EXECUTION_CALLBACK_HEADER]: wrong }), VALID);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuse un secret plus long (protège la comparaison timing-safe)", () => {
    const result = verifyExecutionCallback(
      req({ [EXECUTION_CALLBACK_HEADER]: VALID + "x" }),
      VALID,
    );
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("accepte le secret exact", () => {
    const result = verifyExecutionCallback(req({ [EXECUTION_CALLBACK_HEADER]: VALID }), VALID);
    expect(result).toEqual({ ok: true });
  });
});
