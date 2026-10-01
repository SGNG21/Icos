import { getContainer } from "@/server/container";
import { protectRoute } from "@/server/http/protect-route";

/**
 * Why the voice socket was refused.
 *
 * The browser WebSocket API hides the upgrade's HTTP status, so after a refused
 * upgrade the phone sees the same 1006 as a lost network and can only ask over
 * HTTP. This probe therefore carries EXACTLY the socket's permission
 * (`tasks.write`, see `composeVoiceHost`), so its answer IS the socket's answer:
 *   401 → signed out, go to /login;
 *   403 → this account may not use voice (honest, final);
 *   204 → the refusal is not about this account, so keep reconnecting.
 *
 * It must stay in step with `compose.ts`. Probing a DIFFERENT gate is what made
 * a 403'd socket look like a flaky network and reconnect in silence forever.
 *
 * No `sameOrigin`: a browser sends no `Origin` on a same-origin GET, and this
 * answers nothing but "your own account may use voice" — it discloses no
 * provider, session or conversation state.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const access = await protectRoute({
    container: await getContainer(),
    request,
    route: "api.voice.status",
    permission: "tasks.write",
  });
  return access.ok ? new Response(null, { status: 204 }) : access.response;
}
