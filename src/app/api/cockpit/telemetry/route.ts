import { getContainer, type Container } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { apiError, json } from "@/server/http/respond";
import { getHostTelemetrySampler } from "@/server/telemetry/host-sampler";
import { getTelemetryRateLimiter } from "@/server/telemetry/rate-limit";
import {
  getServiceProbes,
  workerCapacity,
  type FleetFacts,
} from "@/server/telemetry/service-probes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Télémétrie hôte et santé des services, en lecture seule, réservée aux
 * opérateurs. Le navigateur ne reçoit que des agrégats et des états ; aucun
 * paramètre client n'influence les fichiers lus ni les services sondés. Les
 * refus sont audités par `protectRoute` ; les lectures réussies (sondage
 * ~10 s) ne le sont pas pour ne pas saturer le journal.
 *
 * La capacité des workers vient du registre durable et du journal de dispatch
 * (décision 0031/0032), jamais d'une session ou d'un processus observé.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.cockpit.telemetry",
      // Données d'infrastructure : réservées au rôle opérationnel (operator et
      // au-dessus, par héritage), comme les mutations du cockpit.
      role: "operator",
    });
    if (!access.ok) {
      return access.response;
    }

    const decision = getTelemetryRateLimiter().check(access.session.user.id);
    if (!decision.allowed) {
      return apiError(
        "rate_limited",
        "Trop de lectures de télémétrie : réessayez plus tard.",
        undefined,
        {
          "retry-after": String(decision.retryAfterSeconds),
        },
      );
    }

    const [telemetry, probes, fleet] = await Promise.all([
      getHostTelemetrySampler().snapshot(),
      getServiceProbes(container.databaseHealth).collect(),
      readFleetFacts(container),
    ]);
    return json({
      telemetry: {
        ...telemetry,
        services: [...telemetry.services, ...probes.services],
        workers: workerCapacity(telemetry.headroom, fleet),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Lecture isolée : un registre illisible rend `null`, jamais un zéro inventé. */
async function readFleetFacts(container: Container): Promise<FleetFacts | null> {
  try {
    const [workers, activeAssignments] = await Promise.all([
      container.workerRegistryStore.list(),
      container.dispatchAttempts.listActiveWorkerAssignments(),
    ]);
    return {
      workers: workers.map((w) => ({ status: w.status, maxConcurrency: w.maxConcurrency })),
      activeAssignments,
    };
  } catch {
    return null;
  }
}
