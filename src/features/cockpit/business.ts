import { z } from "zod";

import { isReal, missing, real, type Truth } from "./truth";

/**
 * Executive / business READ contract. ICOS holds no client, lead, pipeline or marketing
 * records today; this is the shape the cockpit will render once a business read model
 * exists (business OS / workforce lanes). Every fact carries its provenance with the same
 * vocabulary as the workforce contract: only REAL facts are shown as values — SIMULATED
 * and NOT_CONNECTED rows are counted and flagged, never displayed as current business state.
 */
export const factSourceSchema = z.enum(["REAL", "SIMULATED", "NOT_CONNECTED"]);
const fact = { source: factSourceSchema, asOf: z.string() };

export const businessReadModelSchema = z.object({
  clients: z.array(
    z
      .object({
        clientId: z.string(),
        name: z.string(),
        status: z.enum(["prospect", "active", "at_risk", "paused", "churned"]),
        activeMissions: z.number().int().nonnegative().optional(),
        ...fact,
      })
      .passthrough(),
  ),
  leads: z.array(
    z
      .object({
        leadId: z.string(),
        clientId: z.string().nullable(),
        stage: z.string(),
        channel: z.string().optional(),
        ...fact,
      })
      .passthrough(),
  ),
  pipeline: z.array(
    z
      .object({
        stage: z.string(),
        count: z.number().int().nonnegative(),
        valueCents: z.number().int().nonnegative().optional(),
        currency: z.string().length(3).optional(),
        ...fact,
      })
      .passthrough(),
  ),
  /** Open channel set (seo, ads, email, social, … future channels need no code change). */
  marketing: z.array(
    z
      .object({
        channel: z.string(),
        metric: z.string(),
        value: z.number(),
        unit: z.string(),
        period: z.string(),
        clientId: z.string().nullable().optional(),
        ...fact,
      })
      .passthrough(),
  ),
  kpis: z.array(
    z
      .object({
        kpiId: z.string(),
        label: z.string(),
        value: z.number(),
        unit: z.string(),
        target: z.number().optional(),
        ...fact,
      })
      .passthrough(),
  ),
});
export type BusinessReadModel = z.infer<typeof businessReadModelSchema>;

export interface BusinessReadPort {
  read(): Promise<Truth<BusinessReadModel>>;
}

export const notConnectedBusiness: BusinessReadPort = {
  read: async () =>
    missing(
      "not_connected",
      "ICOS has no client / lead / pipeline / marketing read model yet; nothing is estimated.",
      "BR-30",
    ),
};

export function parseBusiness(raw: unknown): Truth<BusinessReadModel> {
  const parsed = businessReadModelSchema.safeParse(raw);
  return parsed.success
    ? real(parsed.data)
    : missing("unknown", "The business read model did not match the expected contract.");
}

/** A section of REAL rows, plus how many non-REAL rows were withheld from display. */
export interface RealSection<T> {
  rows: T[];
  withheld: number;
}

const onlyReal = <T extends { source: string }>(rows: readonly T[]): RealSection<T> => ({
  rows: rows.filter((r) => r.source === "REAL"),
  withheld: rows.filter((r) => r.source !== "REAL").length,
});

export interface BusinessView {
  clients: RealSection<BusinessReadModel["clients"][number]>;
  atRiskClients: number;
  leads: RealSection<BusinessReadModel["leads"][number]>;
  pipeline: RealSection<BusinessReadModel["pipeline"][number]>;
  marketingByChannel: Record<string, BusinessReadModel["marketing"][number][]>;
  marketingWithheld: number;
  kpis: RealSection<BusinessReadModel["kpis"][number]>;
}

export function buildBusinessView(m: BusinessReadModel): BusinessView {
  const clients = onlyReal(m.clients);
  const marketing = onlyReal(m.marketing);
  const byChannel: BusinessView["marketingByChannel"] = {};
  for (const row of marketing.rows) (byChannel[row.channel] ??= []).push(row);
  return {
    clients,
    atRiskClients: clients.rows.filter((c) => c.status === "at_risk").length,
    leads: onlyReal(m.leads),
    pipeline: onlyReal(m.pipeline),
    marketingByChannel: byChannel,
    marketingWithheld: marketing.withheld,
    kpis: onlyReal(m.kpis),
  };
}

export const businessView = (t: Truth<BusinessReadModel>): Truth<BusinessView> =>
  isReal(t) ? real(buildBusinessView(t.value)) : (t as Truth<BusinessView>);
