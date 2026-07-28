import { z } from "zod";

import {
  buildMissionContext,
  CONTEXT_LIMITS,
  resolveSupervisorContext,
  type BridgeResult,
  type BuildContextResult,
  type SupervisorEnrichedContext,
} from "@/core/context";
import { tenantIdSchema } from "@/core/contracts/tenant";
import type { Mission, MissionResult, MissionStatus } from "@/core/mission";
import {
  missionContextRef,
  type MissionContextRef,
  type MissionContextRepository,
  type SaveContextResult,
} from "@/server/context/ports";
import type { MissionService } from "@/server/mission/mission-service";

export const createMissionFromUserRequestInputSchema = z
  .object({
    objective: z
      .string()
      .max(CONTEXT_LIMITS.statementMaxLength)
      .refine((value) => value.trim().length > 0, "objective vide"),
  })
  .strict();

export type CreateMissionFromUserRequestInput = z.infer<
  typeof createMissionFromUserRequestInputSchema
>;

export const trustedMissionEntryContextSchema = z
  .object({
    tenantId: tenantIdSchema,
    actorId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0, "actorId vide"),
  })
  .strict();

export type TrustedMissionEntryContext = z.infer<typeof trustedMissionEntryContextSchema>;

type ContextBuilder = (input: Parameters<typeof buildMissionContext>[0]) => BuildContextResult;
type SupervisorContextResolver = typeof resolveSupervisorContext;

export interface CreateMissionFromUserRequestDeps {
  missionService: Pick<MissionService, "createMission">;
  missionContexts: MissionContextRepository;
  buildContext?: ContextBuilder;
  resolveContext?: SupervisorContextResolver;
}

export type CreateMissionFromUserRequestFailureReason =
  | "invalid_input"
  | "invalid_trusted_context"
  | "mission_creation_failed"
  | "context_build_failed"
  | "context_persistence_failed"
  | "bridge_failed";

export type CreateMissionFromUserRequestResult =
  | {
      ok: true;
      missionId: string;
      objective: string;
      missionState: MissionStatus;
      createdAt: string;
      updatedAt: string;
      contextRef: MissionContextRef;
      supervisorContext: SupervisorEnrichedContext;
    }
  | {
      ok: false;
      reason: CreateMissionFromUserRequestFailureReason;
      message: string;
    };

/**
 * Crée une Mission D2 et son contexte descriptif, puis prépare l'enveloppe
 * consommable par le Supervisor. Ce use case ne construit aucun DAG et ne
 * déclenche aucune exécution.
 *
 * La Mission est persistée avant le contexte. Les repositories existants
 * n'exposant pas de transaction commune ni de suppression, un échec ultérieur
 * laisse honnêtement la Mission créée (et, si le bridge échoue, le contexte
 * version 0) sans simuler de rollback.
 */
export async function createMissionFromUserRequest(
  deps: CreateMissionFromUserRequestDeps,
  input: unknown,
  trustedContext: unknown,
): Promise<CreateMissionFromUserRequestResult> {
  const parsedInput = createMissionFromUserRequestInputSchema.safeParse(input);
  if (!parsedInput.success) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "La demande de mission est invalide.",
    };
  }

  const parsedTrustedContext = trustedMissionEntryContextSchema.safeParse(trustedContext);
  if (!parsedTrustedContext.success) {
    return {
      ok: false,
      reason: "invalid_trusted_context",
      message: "Le contexte serveur de la mission est invalide.",
    };
  }

  const { objective } = parsedInput.data;
  const { tenantId, actorId } = parsedTrustedContext.data;

  let missionResult: MissionResult<Mission>;
  try {
    missionResult = await deps.missionService.createMission({
      userRequest: objective,
      tenantId,
    });
  } catch {
    return {
      ok: false,
      reason: "mission_creation_failed",
      message: "La mission n'a pas pu être créée.",
    };
  }
  if (!missionResult.ok) {
    return {
      ok: false,
      reason: "mission_creation_failed",
      message: "La mission n'a pas pu être créée.",
    };
  }

  const mission = missionResult.data;
  const buildContext = deps.buildContext ?? buildMissionContext;
  let built: BuildContextResult;
  try {
    built = buildContext({
      conversation: {
        tenantId,
        turns: [
          {
            id: "user-objective",
            role: "user",
            text: objective,
            confirmed: true,
            isObjective: true,
            isOpenQuestion: false,
            conflictsWithMission: false,
            observedAt: mission.createdAt,
          },
        ],
        memoryReferences: [],
      },
      mission,
      builtByLabel: actorId,
      now: mission.createdAt,
      version: 0,
    });
  } catch {
    return {
      ok: false,
      reason: "context_build_failed",
      message: "Le contexte descriptif de la mission n'a pas pu être construit.",
    };
  }
  if (!built.ok) {
    return {
      ok: false,
      reason: "context_build_failed",
      message: "Le contexte descriptif de la mission n'a pas pu être construit.",
    };
  }

  let saved: SaveContextResult;
  try {
    saved = await deps.missionContexts.save({
      context: built.context,
      expectedVersion: null,
    });
  } catch {
    return {
      ok: false,
      reason: "context_persistence_failed",
      message: "Le contexte descriptif de la mission n'a pas pu être enregistré.",
    };
  }
  if (!saved.ok) {
    return {
      ok: false,
      reason: "context_persistence_failed",
      message: "Le contexte descriptif de la mission n'a pas pu être enregistré.",
    };
  }

  const resolveContext = deps.resolveContext ?? resolveSupervisorContext;
  let bridged: BridgeResult;
  try {
    bridged = resolveContext(saved.context, mission);
  } catch {
    return {
      ok: false,
      reason: "bridge_failed",
      message: "Le contexte de la mission n'a pas pu être préparé pour le Supervisor.",
    };
  }
  if (!bridged.ok) {
    return {
      ok: false,
      reason: "bridge_failed",
      message: "Le contexte de la mission n'a pas pu être préparé pour le Supervisor.",
    };
  }

  return {
    ok: true,
    missionId: mission.id,
    objective: mission.userRequest,
    missionState: mission.status,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    contextRef: missionContextRef(saved.context),
    supervisorContext: bridged.envelope,
  };
}
