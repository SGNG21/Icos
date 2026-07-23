import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { zodDetails } from "@/server/http/errors";
import { apiError, json } from "@/server/http/respond";
import { actionQuerySchema } from "@/server/http/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.actions",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const url = new URL(request.url);
    const raw = url.searchParams.get("approvalStatus");
    const parsed = actionQuerySchema.safeParse(raw === null ? {} : { approvalStatus: raw });
    if (!parsed.success) {
      return apiError("invalid_input", "filtre invalide", zodDetails(parsed.error));
    }

    return json({ actions: await container.actions.list(parsed.data) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
