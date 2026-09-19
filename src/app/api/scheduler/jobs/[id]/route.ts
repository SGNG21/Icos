import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { toScheduledJobDto } from "@/server/scheduler/scheduled-job-dto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.scheduler.jobs.read",
      permission: "scheduler.manage",
    });
    if (!access.ok) return access.response;

    const { id } = await ctx.params;
    const job = await container.scheduler.getJob(id);
    if (!job) return apiError("not_found", "job introuvable");
    return json({ job: toScheduledJobDto(job) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
