import { getContainer } from "@/server/container";
import { apiError, json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return json({ agents: getContainer().agents.list() });
  } catch {
    return apiError("internal_error", "erreur interne");
  }
}
