import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { zodDetails } from "@/server/http/errors";
import { apiError, json } from "@/server/http/respond";
import { auditQuerySchema } from "@/server/http/schemas";
import type { AuditQuery } from "@/server/audit/in-memory-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const authError = await protectRoute({
      container,
      request,
      route: "api.audit",
      permission: "audit.read.full",
    });
    if (authError) {
      return authError;
    }

    const url = new URL(request.url);
    const candidate = {
      eventType: url.searchParams.get("eventType") ?? undefined,
      actorId: url.searchParams.get("actorId") ?? undefined,
      taskId: url.searchParams.get("taskId") ?? undefined,
      actionId: url.searchParams.get("actionId") ?? undefined,
    };

    const parsed = auditQuerySchema.safeParse(candidate);
    if (!parsed.success) {
      return apiError("invalid_input", "filtre invalide", zodDetails(parsed.error));
    }

    const filter: AuditQuery = parsed.data;
    return json({ entries: await container.audit.query(filter) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
