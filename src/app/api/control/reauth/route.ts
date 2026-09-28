import { z } from "zod";

import { getContainer } from "@/server/container";
import { appendSecurityAudit } from "@/server/auth/security-audit";
import { resolveActor } from "@/server/control/http";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json, readJson } from "@/server/http/respond";

/**
 * POST /api/control/reauth — BR-18 fresh authentication.
 *
 * Verifies the password of the CURRENT session's user server-side and returns
 * a single-use proof valid 5 minutes, bound to this user and session. The
 * password is never stored or logged; only the proof's SHA-256 is persisted.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ password: z.string().min(1).max(1024) }).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.control.reauth",
      permission: "cockpit.read",
      sameOrigin: true,
    });
    if (!access.ok) return access.response;

    const actor = await resolveActor(container, request.headers, access.session);
    if (!actor.ok) return actor.response;

    const body = await readJson(request);
    const parsed = body.ok ? bodySchema.safeParse(body.value) : null;
    if (!parsed?.success) return apiError("invalid_input", "password is required");

    const issued = await container.control!.reauth.issue({
      headers: request.headers,
      userId: access.session.user.id,
      sessionId: actor.actor.sessionId,
      password: parsed.data.password,
    });
    if (!issued.ok) {
      await appendSecurityAudit(container.audit, {
        eventType: "auth.login.rejected",
        reason: "invalid_credentials",
        userId: access.session.user.id,
      }).catch(() => {});
      return apiError("unauthenticated", "re-authentication failed");
    }
    return json({ proof: issued.proof, expiresAt: issued.expiresAt });
  } catch (error) {
    return toErrorResponse(error);
  }
}
