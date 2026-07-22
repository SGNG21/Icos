import { isAPIError } from "better-auth/api";
import { applySetCookies, splitSetCookieHeader } from "better-auth/cookies";
import { z } from "zod";

import { AuthGuardError } from "@/server/auth/errors";
import { appendSecurityAudit } from "@/server/auth/security-audit";
import { getContainer, type Container } from "@/server/container";
import { authErrorResponse } from "@/server/http/auth-response";
import { toErrorResponse } from "@/server/http/map-error";
import { isSameOriginMutation } from "@/server/http/origin";
import { apiError, readJson } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const signInBodySchema = z
  .object({
    email: z.email(),
    password: z.string().min(12),
  })
  .strict();

type RouteContext = {
  params: Promise<{
    all: string[];
  }>;
};

function routeName(path: string): string {
  return `auth.${path.replaceAll("/", ".")}`;
}

function setCookieValues(headers: Headers): string[] {
  const value = headers.get("set-cookie");
  return value ? splitSetCookieHeader(value) : [];
}

function authSuccess(headers: Headers): Response {
  const responseHeaders = new Headers({
    "cache-control": "no-store, no-cache, must-revalidate",
    "content-type": "application/json; charset=utf-8",
  });

  for (const value of setCookieValues(headers)) {
    responseHeaders.append("set-cookie", value);
  }

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: responseHeaders,
  });
}

async function auditCrossOrigin(
  container: Container,
  request: Request,
  path: string,
): Promise<void> {
  await appendSecurityAudit(container.audit, {
    eventType: "auth.access.denied",
    method: request.method,
    route: routeName(path),
    reason: "cross_origin",
  }).catch(() => {});
}

async function requireAuthOrigin(
  container: Container,
  request: Request,
  path: string,
): Promise<Response | null> {
  if (isSameOriginMutation(request)) {
    return null;
  }

  await auditCrossOrigin(container, request, path);
  return authErrorResponse(new AuthGuardError("forbidden"));
}

async function rejectDisabledAccount(container: Container, userId: string): Promise<Response> {
  await container.auth?.revokeUserSessions(userId).catch(() => {});
  await appendSecurityAudit(container.audit, {
    eventType: "auth.login.rejected",
    reason: "account_disabled",
    userId,
  }).catch(() => {});
  return authErrorResponse(new AuthGuardError("account_disabled"));
}

async function signIn(container: Container, request: Request): Promise<Response> {
  const originError = await requireAuthOrigin(container, request, "sign-in/email");
  if (originError) {
    return originError;
  }

  const body = await readJson(request);
  if (!body.ok) {
    return apiError("invalid_input", "corps JSON invalide");
  }

  const parsed = signInBodySchema.safeParse(body.value);
  if (!parsed.success) {
    return apiError("invalid_input", "paramètres invalides");
  }

  if (!container.auth || !container.authHttp) {
    return apiError("internal_error", "erreur interne");
  }

  try {
    const result = await container.authHttp.signIn({
      ...parsed.data,
      headers: request.headers,
    });
    const user = await container.auth.readHumanUser(result.userId);

    if (!user || user.status !== "active") {
      return rejectDisabledAccount(container, result.userId);
    }

    const authoritativeHeaders = new Headers(request.headers);
    applySetCookies(authoritativeHeaders, setCookieValues(result.headers));
    let session;
    try {
      session = await container.auth.readSession(authoritativeHeaders);
    } catch (error) {
      if (error instanceof AuthGuardError && error.code === "account_disabled") {
        return rejectDisabledAccount(container, result.userId);
      }
      throw error;
    }

    if (!session || session.user.id !== result.userId || session.user.status !== "active") {
      return rejectDisabledAccount(container, result.userId);
    }

    try {
      await appendSecurityAudit(container.audit, {
        eventType: "auth.login.succeeded",
        userId: result.userId,
      });
    } catch (error) {
      await container.auth.revokeSession(authoritativeHeaders);
      throw error;
    }

    return authSuccess(result.headers);
  } catch (error) {
    if (isAPIError(error) && (error.status === "UNAUTHORIZED" || error.statusCode === 401)) {
      await appendSecurityAudit(container.audit, {
        eventType: "auth.login.rejected",
        reason: "invalid_credentials",
      }).catch(() => {});
      return authErrorResponse(new AuthGuardError("unauthenticated"));
    }

    return toErrorResponse(error);
  }
}

async function signOut(container: Container, request: Request): Promise<Response> {
  const originError = await requireAuthOrigin(container, request, "sign-out");
  if (originError) {
    return originError;
  }

  if (!container.auth || !container.authHttp) {
    return apiError("internal_error", "erreur interne");
  }

  try {
    let userId: string | undefined;
    try {
      const session = await container.auth.readSession(request.headers);
      userId = session?.user.id;
    } catch (error) {
      if (!(error instanceof AuthGuardError) || error.code !== "account_disabled") {
        throw error;
      }
      userId = error.userId;
    }

    const result = await container.authHttp.signOut(request.headers);

    if (!result.success) {
      return apiError("internal_error", "erreur interne");
    }

    if (userId) {
      await appendSecurityAudit(container.audit, {
        eventType: "auth.logout.succeeded",
        userId,
      }).catch(() => {});
    }

    return authSuccess(result.headers);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const path = (await context.params).all.join("/");

  if (path !== "sign-in/email" && path !== "sign-out") {
    return apiError("not_found", "route introuvable");
  }

  try {
    const container = await getContainer();
    return path === "sign-in/email"
      ? await signIn(container, request)
      : await signOut(container, request);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function GET(): Promise<Response> {
  return apiError("not_found", "route introuvable");
}
