import { httpStatusFor, type ApiErrorBody, type ApiErrorCode } from "./errors";

/**
 * En-têtes anti-cache : les lectures reflètent un état mutable en mémoire et ne
 * doivent jamais être servies depuis un cache qui masquerait une mutation
 * récente.
 */
const NO_STORE_HEADERS: Record<string, string> = {
  "cache-control": "no-store, no-cache, must-revalidate",
};

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...NO_STORE_HEADERS,
      ...init?.headers,
    },
  });
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
  headers?: Record<string, string>,
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return json(body, { status: httpStatusFor(code), headers });
}

/** Lit et parse le corps JSON d'une requête ; renvoie une erreur typée sinon. */
export async function readJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return { ok: false };
  }
}
