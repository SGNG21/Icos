import { canCreateTaskInScope } from "@/server/administration/operational-access-service";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { resolveOperationalScope } from "@/server/administration/mission-scope";
import { apiError, json, readJson } from "@/server/http/respond";
import { zodDetails } from "@/server/http/errors";
import { createTaskBodySchema } from "@/server/http/schemas";
import { createTask } from "@/server/usecases/create-task";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tasks",
      permission: "cockpit.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const scope = await resolveOperationalScope(container, access.session);

    return json({ tasks: await container.tasks.listForScope(scope) });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.tasks",
      permission: "tasks.write",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = createTaskBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    const scope = await resolveOperationalScope(container, access.session);

    if (!canCreateTaskInScope({ scope, assignedAgentId: parsed.data.assignedAgentId })) {
      return apiError("forbidden", "agent hors portée");
    }

    const result = await createTask(
      { tasks: container.tasks, agents: container.agents },
      parsed.data,
    );
    if (!result.ok) {
      return apiError(result.reason, result.message);
    }

    return json({ task: result.task }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
