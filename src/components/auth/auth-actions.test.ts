import { describe, expect, it, vi } from "vitest";

import { createLoginSubmission, createLogoutSubmission, LOGIN_ERROR_MESSAGE } from "./auth-actions";

function deferredResponse() {
  let resolve!: (response: Pick<Response, "ok" | "status">) => void;
  const promise = new Promise<Pick<Response, "ok" | "status">>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createLoginSubmission", () => {
  it("poste uniquement l’email et le mot de passe puis utilise la destination locale", async () => {
    const request = vi.fn(async () => ({ ok: true, status: 200 }));
    const replace = vi.fn();
    const submit = createLoginSubmission({ request, replace });

    await expect(
      submit({ email: "human@icos.test", password: "correct-password" }, "/tasks?status=pending"),
    ).resolves.toEqual({ status: "succeeded" });

    expect(request).toHaveBeenCalledWith("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "human@icos.test",
        password: "correct-password",
      }),
    });
    expect(replace).toHaveBeenCalledWith("/tasks?status=pending");
  });

  it("n’attend ni ne lit aucun token dans la réponse", async () => {
    const response = {
      ok: true,
      status: 200,
      json: vi.fn(() => {
        throw new Error("response body must not be read");
      }),
    };
    const submit = createLoginSubmission({
      request: vi.fn(async () => response),
      replace: vi.fn(),
    });

    await expect(
      submit({ email: "human@icos.test", password: "correct-password" }, "/"),
    ).resolves.toEqual({ status: "succeeded" });
    expect(response.json).not.toHaveBeenCalled();
  });

  it("affiche le même refus contrôlé pour des identifiants rejetés", async () => {
    const submit = createLoginSubmission({
      request: vi.fn(async () => ({ ok: false, status: 401 })),
      replace: vi.fn(),
    });

    await expect(
      submit({ email: "unknown@icos.test", password: "wrong-password" }, "/"),
    ).resolves.toEqual({ status: "rejected", message: LOGIN_ERROR_MESSAGE });
  });

  it("ignore une seconde soumission pendant la première", async () => {
    const response = deferredResponse();
    const request = vi.fn(() => response.promise);
    const submit = createLoginSubmission({ request, replace: vi.fn() });

    const first = submit({ email: "human@icos.test", password: "correct-password" }, "/");
    await expect(
      submit({ email: "human@icos.test", password: "correct-password" }, "/"),
    ).resolves.toEqual({ status: "ignored" });
    expect(request).toHaveBeenCalledTimes(1);

    response.resolve({ ok: true, status: 200 });
    await first;
  });

  it("remplace une destination externe par la racine", async () => {
    const replace = vi.fn();
    const submit = createLoginSubmission({
      request: vi.fn(async () => ({ ok: true, status: 200 })),
      replace,
    });

    await submit({ email: "human@icos.test", password: "correct-password" }, "//evil.test");

    expect(replace).toHaveBeenCalledWith("/");
  });
});

describe("createLogoutSubmission", () => {
  it("révoque la session puis remplace l’historique par la connexion", async () => {
    const request = vi.fn(async () => ({ ok: true, status: 200 }));
    const replace = vi.fn();
    const submit = createLogoutSubmission({ request, replace });

    await expect(submit()).resolves.toEqual({ status: "succeeded" });

    expect(request).toHaveBeenCalledWith("/api/auth/sign-out", { method: "POST" });
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
