import { z } from "zod";

import type { CockpitHttpClient, CockpitJobProjection } from "@/features/cockpit/clients";

const JOB_ID_PATTERN =
  /^cockpit-job-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OBJECTIVE_LENGTH = 2_000;
const MAX_TEXT_LENGTH = 512;
const MAX_ITEMS = 100;

const cockpitJobStatusSchema = z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED"]);

const cockpitJobSchema = z
  .object({
    jobId: z.string().regex(JOB_ID_PATTERN),
    missionId: z.string().min(1).max(128).optional(),
    objective: z.string().max(MAX_OBJECTIVE_LENGTH),
    status: cockpitJobStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    requestKind: z.enum(["CONVERSATION", "MISSION"]).optional(),
    missionState: z.string().max(64).optional(),
    planLabel: z.string().max(MAX_TEXT_LENGTH).optional(),
    tasks: z
      .array(
        z
          .object({
            taskId: z.string().max(128),
            label: z.string().max(MAX_TEXT_LENGTH),
            status: cockpitJobStatusSchema,
          })
          .strict(),
      )
      .max(MAX_ITEMS),
    workers: z.array(z.string().max(MAX_TEXT_LENGTH)).max(MAX_ITEMS),
    blockers: z.array(z.string().max(MAX_TEXT_LENGTH)).max(MAX_ITEMS),
    evidence: z.array(z.string().max(MAX_TEXT_LENGTH)).max(MAX_ITEMS),
    sanitizedError: z
      .object({
        code: z.string().max(64),
        message: z.string().max(MAX_TEXT_LENGTH),
      })
      .strict()
      .optional(),
    finalResult: z.string().max(MAX_TEXT_LENGTH).optional(),
    mergePerformed: z.literal(false),
    productionDeploymentPerformed: z.literal(false),
  })
  .strict();

const cockpitJobResponseSchema = z.object({ job: cockpitJobSchema }).strict();

export class CockpitHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CockpitHttpError";
  }
}

async function readJobResponse(
  response: Response,
  expectedStatus: 200 | 202,
): Promise<CockpitJobProjection> {
  if (!response.ok || response.status !== expectedStatus) {
    throw new CockpitHttpError(`La requête Cockpit a échoué (HTTP ${response.status}).`);
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new CockpitHttpError("La réponse Cockpit reçue est invalide.");
  }

  const parsed = cockpitJobResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new CockpitHttpError("La réponse Cockpit reçue est invalide.");
  }
  return parsed.data.job;
}

async function safeFetch(
  fetchImplementation: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImplementation(input, init);
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new CockpitHttpError("Impossible de contacter le service Cockpit.");
  }
}

export function createCockpitHttpClient(
  fetchImplementation: typeof fetch = globalThis.fetch,
): CockpitHttpClient {
  return {
    async submitJob(objective, idempotencyKey, signal) {
      const response = await safeFetch(fetchImplementation, "/api/cockpit/jobs", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({ objective }),
        signal,
      });
      return readJobResponse(response, 202);
    },

    async getJob(jobId, signal) {
      const response = await safeFetch(
        fetchImplementation,
        `/api/cockpit/jobs/${encodeURIComponent(jobId)}`,
        {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal,
        },
      );
      return readJobResponse(response, 200);
    },
  };
}
