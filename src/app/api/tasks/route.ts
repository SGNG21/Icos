import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
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

    return json({ tasks: await container.tasks.list() });
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
