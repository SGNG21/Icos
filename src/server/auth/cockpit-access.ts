import type { AuthenticatedSession } from "@/core/identity";
import type { Container } from "@/server/container";

import { AuthGuardError, type AuthFailureCode } from "./errors";
import { requirePermission } from "./guards";

export type CockpitAccess =
  | { kind: "allowed"; session: AuthenticatedSession }
  | {
      kind: "redirect";
      code: Extract<AuthFailureCode, "unauthenticated" | "session_expired">;
    }
  | {
      kind: "forbidden";
      code: Extract<AuthFailureCode, "forbidden" | "account_disabled">;
    };

/** Classe le refus avant toute lecture métier du cockpit. */
export async function resolveCockpitAccess(
  container: Pick<Container, "auth">,
  headers: Headers,
): Promise<CockpitAccess> {
  try {
    const session = await requirePermission(container, headers, "cockpit.read");
    return { kind: "allowed", session };
  } catch (error) {
    if (!(error instanceof AuthGuardError)) {
      throw error;
    }

    if (error.code === "unauthenticated" || error.code === "session_expired") {
      return { kind: "redirect", code: error.code };
    }

    return { kind: "forbidden", code: error.code };
  }
}
