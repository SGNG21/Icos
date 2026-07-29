import { z } from "zod";

import { getCockpitRuntime } from "@/server/cockpit/runtime";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cockpitJobIdSchema = z
  .string()
  .regex(
    /^cockpit-job-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.cockpit.jobs.detail",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const { id } = await context.params;
    const jobId = cockpitJobIdSchema.safeParse(id);
    if (!jobId.success) {
      return apiError("invalid_input", "identifiant de job invalide");
    }

    const tenant = await container.tenantResolver.resolve({
      session: { userId: access.session.user.id },
      headers: request.headers,
    });
    if (!tenant.ok) {
      return apiError("forbidden", "Accès interdit.");
    }

    const job = getCockpitRuntime().getJob(tenant.context.tenantId, jobId.data);
    if (!job) {
      return apiError("not_found", "job introuvable");
    }

    return json({ job });
  } catch (error) {
    return toErrorResponse(error);
  }
}
