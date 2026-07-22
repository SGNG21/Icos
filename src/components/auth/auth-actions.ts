import { safeNextPath } from "@/auth-navigation";

type RequestResult = Pick<Response, "ok" | "status">;

type AuthActionDependencies = {
  request: (input: string, init: RequestInit) => Promise<RequestResult>;
  replace: (path: string) => void;
};

type LoginCredentials = {
  email: string;
  password: string;
};

export type AuthActionResult =
  { status: "succeeded" } | { status: "rejected"; message: string } | { status: "ignored" };

export const LOGIN_ERROR_MESSAGE =
  "Connexion impossible. Vérifiez vos identifiants ou contactez un propriétaire ICOS.";

export const LOGOUT_ERROR_MESSAGE = "Déconnexion impossible. Réessayez dans quelques instants.";

export function createLoginSubmission({
  request,
  replace,
}: AuthActionDependencies): (
  credentials: LoginCredentials,
  nextPath: string,
) => Promise<AuthActionResult> {
  let pending = false;

  return async (credentials, nextPath) => {
    if (pending) {
      return { status: "ignored" };
    }

    pending = true;
    try {
      const response = await request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });

      if (!response.ok) {
        return { status: "rejected", message: LOGIN_ERROR_MESSAGE };
      }

      replace(safeNextPath(nextPath));
      return { status: "succeeded" };
    } catch {
      return { status: "rejected", message: LOGIN_ERROR_MESSAGE };
    } finally {
      pending = false;
    }
  };
}

export function createLogoutSubmission({
  request,
  replace,
}: AuthActionDependencies): () => Promise<AuthActionResult> {
  let pending = false;

  return async () => {
    if (pending) {
      return { status: "ignored" };
    }

    pending = true;
    try {
      const response = await request("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) {
        return { status: "rejected", message: LOGOUT_ERROR_MESSAGE };
      }

      replace("/login");
      return { status: "succeeded" };
    } catch {
      return { status: "rejected", message: LOGOUT_ERROR_MESSAGE };
    } finally {
      pending = false;
    }
  };
}
