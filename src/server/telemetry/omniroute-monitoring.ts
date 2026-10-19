import { z } from "zod";

/**
 * Lecture de la santé OmniRoute via sa route native `/api/monitoring/health`
 * (route présente dans le code d'OmniRoute, sans authentification sur la
 * boucle locale, sans aucune inférence).
 *
 * Sémantique relevée dans le code d'OmniRoute 3.8.49 : `status` vaut
 * toujours "healthy" quand le relevé interne aboutit (valeur fixe, elle ne
 * prouve rien seule) et "degraded" avec un champ `error` quand le relevé a
 * partiellement échoué (toujours en HTTP 200). La disponibilité réelle se
 * lit donc dans les disjoncteurs et les fournisseurs actifs, jamais dans le
 * seul code HTTP ni dans le seul `status`.
 *
 * Seule une LISTE BLANCHE de champs est extraite : état global, compteurs de
 * disjoncteurs, résumé des fournisseurs et, par fournisseur, son état et son
 * nombre d'échecs. Messages d'erreur (`lastFailure`), sessions, quotas,
 * identifiants et santé des credentials ne sont jamais lus ni relayés.
 */

export const OMNIROUTE_MONITORING_PATH = "/api/monitoring/health";
export const OMNIROUTE_MONITORING_MAX_BYTES = 64 * 1024;

const count = z.number().int().min(0).max(1_000_000);
const providerId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const breakerState = z.enum(["CLOSED", "HALF_OPEN", "OPEN", "DEGRADED"]);

const monitoringSchema = z.object({
  status: z.string().max(32),
  error: z.string().max(256).optional(),
  uptime: z.number().min(0).optional(),
  circuitBreakers: z
    .object({ open: count, halfOpen: count, degraded: count, closed: count, total: count })
    .optional(),
  providerSummary: z
    .object({ configuredCount: count, activeCount: count, monitoredCount: count })
    .partial()
    .optional(),
  providerHealth: z
    .record(z.string(), z.object({ state: z.string().max(32), failures: count.optional() }).loose())
    .optional(),
});

export type OmniRouteBreakerState = z.infer<typeof breakerState>;

export interface OmniRouteMonitoringSnapshot {
  /** État global annoncé par OmniRoute, normalisé. */
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  /** OmniRoute signale un relevé interne partiellement indisponible. */
  partial: boolean;
  uptimeSeconds: number | null;
  breakers: {
    open: number;
    halfOpen: number;
    degraded: number;
    closed: number;
    total: number;
  } | null;
  providers: { configured: number | null; active: number | null };
  /** État des disjoncteurs par fournisseur (identifiants contrôlés). */
  providerStates: Record<string, { state: OmniRouteBreakerState; failures: number | null }>;
}

export type OmniRouteMonitoringResult =
  | { ok: true; latencyMs: number; snapshot: OmniRouteMonitoringSnapshot }
  | {
      ok: false;
      latencyMs: number;
      error: "timeout" | "unreachable" | "http" | "too_large" | "invalid";
      httpStatus?: number;
    };

export function parseOmniRouteMonitoring(value: unknown): OmniRouteMonitoringSnapshot | null {
  const parsed = monitoringSchema.safeParse(value);
  if (!parsed.success) return null;
  const data = parsed.data;
  const status = data.status.toLowerCase();
  const providerStates: OmniRouteMonitoringSnapshot["providerStates"] = {};
  for (const [id, entry] of Object.entries(data.providerHealth ?? {}).slice(0, 64)) {
    const idOk = providerId.safeParse(id);
    const stateOk = breakerState.safeParse(entry.state);
    if (!idOk.success || !stateOk.success) continue;
    providerStates[id] = { state: stateOk.data, failures: entry.failures ?? null };
  }
  return {
    status:
      status === "healthy" || status === "ok"
        ? "healthy"
        : status === "degraded"
          ? "degraded"
          : status === "unhealthy" || status === "down" || status === "error"
            ? "unhealthy"
            : "unknown",
    partial: data.error !== undefined,
    uptimeSeconds: data.uptime ?? null,
    breakers: data.circuitBreakers ?? null,
    providers: {
      configured: data.providerSummary?.configuredCount ?? null,
      active: data.providerSummary?.activeCount ?? null,
    },
    providerStates,
  };
}

/**
 * OmniRoute rend-il son service de routage ? Exige un relevé de monitoring
 * conforme (donc du JSON d'OmniRoute, pas une page HTML) dont l'état n'est ni
 * en échec ni inconnu. Un relevé partiel reste « en service » : le processus
 * route, seul son auto-diagnostic est incomplet.
 */
export function isOmniRouteServing(result: OmniRouteMonitoringResult): boolean {
  return (
    result.ok && (result.snapshot.status === "healthy" || result.snapshot.status === "degraded")
  );
}

/** Lecture bornée en octets ; null si la limite est dépassée. */
export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Port de lecture de la santé OmniRoute consommé par les sondes de services.
 * Sur cette lignée, ICOS ne possède pas d'adaptateur OmniRoute générique
 * (`src/server/ai` n'existe pas) : le monitoring est donc un client HTTP
 * autonome, GET sans clé, corps borné, délai imposé par l'appelant.
 */
export interface OmniRouteMonitorPort {
  monitoringHealth(timeoutMs: number): Promise<OmniRouteMonitoringResult>;
}

/**
 * Lit `/api/monitoring/health`. Ne lève jamais : toute défaillance est un
 * résultat typé. Aucune clé n'est transmise (la route native n'en exige pas
 * sur la boucle locale) ; aucun appel de modèle n'est émis.
 */
export async function fetchOmniRouteMonitoring(
  baseUrl: string,
  timeoutMs: number,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<OmniRouteMonitoringResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetchFn(`${baseUrl.replace(/\/+$/, "")}${OMNIROUTE_MONITORING_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, latencyMs: elapsed(), error: "http", httpStatus: response.status };
    }
    const contentType = response.headers?.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, latencyMs: elapsed(), error: "invalid" };
    }
    const text = await readBoundedText(response, OMNIROUTE_MONITORING_MAX_BYTES);
    if (text === null) return { ok: false, latencyMs: elapsed(), error: "too_large" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, latencyMs: elapsed(), error: "invalid" };
    }
    const snapshot = parseOmniRouteMonitoring(body);
    return snapshot
      ? { ok: true, latencyMs: elapsed(), snapshot }
      : { ok: false, latencyMs: elapsed(), error: "invalid" };
  } catch {
    return { ok: false, latencyMs: elapsed(), error: signal.aborted ? "timeout" : "unreachable" };
  }
}

export function createOmniRouteMonitor(
  baseUrl: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): OmniRouteMonitorPort {
  return { monitoringHealth: (timeoutMs) => fetchOmniRouteMonitoring(baseUrl, timeoutMs, fetchFn) };
}
