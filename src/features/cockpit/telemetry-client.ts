import { z } from "zod";

import type { HostTelemetrySnapshot } from "@/core/telemetry";

/**
 * Client HTTP de la télémétrie hôte. La réponse est validée strictement : une
 * forme inattendue est rejetée plutôt qu'affichée — le cockpit ne montre
 * jamais une valeur dont il n'a pas vérifié la nature.
 */

const MAX_TEXT = 512;
const MAX_ITEMS = 256;

const ratio = z.number().min(0).max(1);
const nonNegative = z.number().min(0);
const reason = z.string().min(1).max(MAX_TEXT);

function measuredOf<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("available", [
    z.object({ available: z.literal(true), value }).strict(),
    z.object({ available: z.literal(false), reason }).strict(),
  ]);
}

const capacity = z
  .object({ total: nonNegative, used: nonNegative, available: nonNegative, ratio })
  .strict();

const tone = z.enum(["ok", "degraded", "incident", "improve"]);

const signal = z
  .object({
    key: z.enum([
      "cpu",
      "load",
      "iowait",
      "memory",
      "pressure",
      "swap",
      "disk",
      "network",
      "container",
      "extension",
    ]),
    tone,
    message: z.string().max(MAX_TEXT),
  })
  .strict();

const nullableRatio = ratio.nullable();

const serviceState = z.enum([
  "operational",
  "degraded",
  "down",
  "not_instrumented",
  "not_connected",
]);

const probeLayer = z
  .object({
    state: serviceState,
    detail: z.string().max(MAX_TEXT),
    latencyMs: z.number().min(0).max(600_000).optional(),
  })
  .strict();

const serviceHealth = z
  .object({
    key: z.string().min(1).max(64),
    label: z.string().min(1).max(128),
    state: serviceState,
    detail: z.string().max(MAX_TEXT),
    source: z.string().max(MAX_TEXT),
    process: probeLayer.nullable(),
    availability: probeLayer,
    mission: probeLayer.nullable(),
    checkedAt: z.iso.datetime().optional(),
  })
  .strict();
const nullableRate = nonNegative.nullable();

const hostSample = z
  .object({
    at: z.iso.datetime(),
    cpu: z
      .object({
        cores: z.number().int().min(0).max(1024),
        usage: measuredOf(ratio),
        perCore: measuredOf(z.array(ratio).max(1024)),
        iowait: measuredOf(ratio),
        load: measuredOf(
          z.object({ one: nonNegative, five: nonNegative, fifteen: nonNegative }).strict(),
        ),
      })
      .strict(),
    memory: measuredOf(capacity),
    swap: measuredOf(capacity),
    disks: z
      .array(
        z
          .object({ mount: z.string().min(1).max(MAX_TEXT), capacity: measuredOf(capacity) })
          .strict(),
      )
      .max(32),
    network: z
      .object({
        rxBytesPerSec: measuredOf(nonNegative),
        txBytesPerSec: measuredOf(nonNegative),
        interfaces: z
          .array(
            z
              .object({
                name: z.string().min(1).max(15),
                rxBytesPerSec: measuredOf(nonNegative),
                txBytesPerSec: measuredOf(nonNegative),
                linkSpeedBitsPerSec: measuredOf(nonNegative),
              })
              .strict(),
          )
          .max(64),
      })
      .strict(),
    uptimeSeconds: measuredOf(nonNegative),
    pressure: z
      .object({ cpu: measuredOf(ratio), memory: measuredOf(ratio), io: measuredOf(ratio) })
      .strict(),
    processes: z
      .object({
        runnable: measuredOf(nonNegative),
        total: measuredOf(nonNegative),
        icos: measuredOf(
          z
            .object({ rssBytes: nonNegative, heapUsedBytes: nonNegative, cpuRatio: nullableRatio })
            .strict(),
        ),
      })
      .strict(),
    container: z
      .object({
        inContainer: z.boolean(),
        memoryLimitBytes: measuredOf(nonNegative.nullable()),
        memoryUsedBytes: measuredOf(nonNegative),
        cpuLimitCores: measuredOf(nonNegative.nullable()),
        differsFromHost: z.boolean(),
      })
      .strict(),
  })
  .strict();

const historyPoint = z
  .object({
    at: z.iso.datetime(),
    cpu: nullableRatio,
    memory: nullableRatio,
    swap: nullableRatio,
    disk: nullableRatio,
    rxBytesPerSec: nullableRate,
    txBytesPerSec: nullableRate,
  })
  .strict();

export const telemetrySnapshotSchema = z
  .object({
    schema: z.literal(1),
    hostname: measuredOf(z.string().min(1).max(253)),
    sampleIntervalSeconds: z.number().int().min(1).max(3600),
    current: hostSample,
    history: z.array(historyPoint).max(MAX_ITEMS),
    overall: z.enum(["ok", "degraded", "incident"]),
    signals: z.array(signal).max(MAX_ITEMS),
    recommendations: z.array(signal).max(MAX_ITEMS),
    headroom: z
      .object({
        idleVcpu: measuredOf(nonNegative),
        memoryAvailableBytes: measuredOf(nonNegative),
      })
      .strict(),
    services: z.array(serviceHealth).max(64),
    workers: z
      .object({
        activeJobs: measuredOf(z.number().int().min(0)),
        jobSlots: measuredOf(z.number().int().min(0)),
        perWorkerFootprint: measuredOf(
          z
            .object({
              cpuVcpu: nonNegative,
              memoryBytes: nonNegative,
              samples: z.number().int().min(0),
            })
            .strict(),
        ),
        additionalWorkers: measuredOf(z.number().int().min(0)),
      })
      .strict(),
    extensions: z
      .object({
        latencyMs: measuredOf(z.object({ p50: nonNegative, p95: nonNegative }).strict()),
        tokensPerSecond: measuredOf(nonNegative),
        inferenceBudget: measuredOf(
          z
            .object({ spent: nonNegative, limit: nonNegative, currency: z.string().max(8) })
            .strict(),
        ),
        concurrentWorkers: measuredOf(z.object({ active: nonNegative, max: nonNegative }).strict()),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<HostTelemetrySnapshot>;

const responseSchema = z.object({ telemetry: telemetrySnapshotSchema }).strict();

export type TelemetryErrorKind = "unauthenticated" | "forbidden" | "invalid" | "network" | "http";

export class TelemetryHttpError extends Error {
  constructor(
    readonly kind: TelemetryErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TelemetryHttpError";
  }
}

export interface TelemetryClient {
  fetchSnapshot(signal: AbortSignal): Promise<HostTelemetrySnapshot>;
}

export function createTelemetryClient(
  fetchImplementation: typeof fetch = (...args) => globalThis.fetch(...args),
): TelemetryClient {
  return {
    async fetchSnapshot(signal) {
      let response: Response;
      try {
        response = await fetchImplementation("/api/cockpit/telemetry", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal,
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        throw new TelemetryHttpError("network", "Impossible de joindre l'API de télémétrie.");
      }
      if (response.status === 401) {
        throw new TelemetryHttpError("unauthenticated", "Session expirée : reconnectez-vous.");
      }
      if (response.status === 403) {
        throw new TelemetryHttpError("forbidden", "Accès réservé aux opérateurs.");
      }
      if (!response.ok) {
        throw new TelemetryHttpError("http", `Télémétrie indisponible (HTTP ${response.status}).`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new TelemetryHttpError("invalid", "Réponse de télémétrie illisible.");
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        throw new TelemetryHttpError("invalid", "Réponse de télémétrie non conforme au contrat.");
      }
      return parsed.data.telemetry;
    },
  };
}
