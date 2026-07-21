import { getContainer } from "@/server/container";
import { apiError, json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const container = await getContainer();
    return json({ agents: await container.agents.list() });
  } catch {
    return apiError("internal_error", "erreur interne");
  }
}
