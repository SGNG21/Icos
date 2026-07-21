import { getContainer } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { apiError, json } from "@/server/http/respond";
import { auditQuerySchema } from "@/server/http/schemas";
import type { AuditQuery } from "@/server/audit/in-memory-audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  try {
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
    return json({ entries: getContainer().auditLog.query(filter) });
  } catch {
    return apiError("internal_error", "erreur interne");
  }
}
