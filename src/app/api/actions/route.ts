import { getContainer } from "@/server/container";
import { zodDetails } from "@/server/http/errors";
import { apiError, json } from "@/server/http/respond";
import { actionQuerySchema } from "@/server/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("approvalStatus");
    const parsed = actionQuerySchema.safeParse(raw === null ? {} : { approvalStatus: raw });
    if (!parsed.success) {
      return apiError("invalid_input", "filtre invalide", zodDetails(parsed.error));
    }

    return json({ actions: getContainer().actions.list(parsed.data) });
  } catch {
    return apiError("internal_error", "erreur interne");
  }
}
