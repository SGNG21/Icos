import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const container = await getContainer();
    return json({ agents: await container.agents.list() });
  } catch (error) {
    return toErrorResponse(error);
  }
}
