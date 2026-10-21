import { z } from "zod";

export const OMNIROUTE_COCKPIT_SCHEMA = 1 as const;

const missingCode = z.enum([
  "NOT_CONNECTED",
  "FORBIDDEN_SCOPE",
  "READ_FAILED",
  "PROBE_MISSING",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_UNREACHABLE",
  "UPSTREAM_HTTP",
  "UPSTREAM_TOO_LARGE",
  "UPSTREAM_INVALID",
]);

function available<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("available", [
    z.object({ available: z.literal(true), value }).strict(),
    z.object({ available: z.literal(false), code: missingCode }).strict(),
  ]);
}

const provider = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    state: z.enum(["healthy", "degraded", "down", "unknown"]),
    failures: z.number().int().min(0).nullable(),
  })
  .strict();

const health = z
  .object({
    state: z.enum(["operational", "degraded", "down", "not_instrumented", "not_connected"]),
    detail: z.string().min(1).max(512),
    checkedAt: z.iso.datetime().nullable(),
    latencyMs: z.number().min(0).max(600_000).nullable(),
  })
  .strict();

const providerSummary = z
  .object({
    configured: z.number().int().min(0).nullable(),
    active: z.number().int().min(0).nullable(),
    openBreakers: z.number().int().min(0).nullable(),
    degradedBreakers: z.number().int().min(0).nullable(),
    providers: z.array(provider).max(64),
  })
  .strict();

const models = z
  .object({
    listed: z.number().int().min(0),
    byProvider: z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), z.number().int().min(0)),
  })
  .strict();

const usage = z
  .object({
    window: z.literal("24h"),
    calls: z.number().int().min(0),
    meteredCalls: z.number().int().min(0),
    unmeteredCalls: z.number().int().min(0),
    tokens: z.number().int().min(0),
    tokensUnknownCalls: z.number().int().min(0),
    lastObservedAt: z.iso.datetime().nullable(),
  })
  .strict();

const cost = z
  .object({
    window: z.literal("24h"),
    status: z.enum(["PRICED", "FREE_TIER", "UNPRICED", "MIXED_CURRENCY", "NO_TRAFFIC"]),
    amount: z.number().min(0).nullable(),
    currency: z.string().min(1).max(8).nullable(),
    pricedCalls: z.number().int().min(0),
    freeTierCalls: z.number().int().min(0),
    unpricedCalls: z.number().int().min(0),
  })
  .strict();

const errors = z
  .object({
    window: z.literal("24h"),
    available: z.literal(false),
    code: z.literal("NOT_INSTRUMENTED"),
  })
  .strict();

const latency = z
  .object({
    window: z.literal("24h"),
    available: z.literal(false),
    code: z.literal("NOT_INSTRUMENTED"),
  })
  .strict();

export const omniRouteCockpitResponseSchema = z
  .object({
    schema: z.literal(OMNIROUTE_COCKPIT_SCHEMA),
    generatedAt: z.iso.datetime(),
    readOnly: z.literal(true),
    health: available(health),
    providers: available(providerSummary),
    models: available(models),
    usage: available(usage),
    cost: available(cost),
    errors,
    latency,
  })
  .strict();

export type OmniRouteCockpitResponse = z.infer<typeof omniRouteCockpitResponseSchema>;
