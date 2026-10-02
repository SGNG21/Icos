import { describe, expect, it, vi } from "vitest";

import type { Attribution, BudgetCap } from "@/core/budget/contracts";
import { decideReservation } from "@/core/budget/spend";
import { CHAT_TEMPLATE_HEADROOM_TOKENS } from "@/core/budget/request-bounds";

import { InMemorySpendLedger } from "./in-memory-spend-ledger";
import { BudgetDeniedError, meteredFetch } from "./metered-fetch";
import type {
  ReserveOutcome,
  SettleEntry,
  SettlementOutcome,
  SpendReservation,
  SpendReservationPort,
} from "./ports";

/**
 * LE DÉFAUT CRITIQUE C1, prouvé de façon ADVERSARIALE.
 *
 * « L'usage historique peut être vide, donc `checkBudget` passe avant le premier appel
 * facturé. » C'était exact : la fenêtre d'un goal neuf est vide, `decide()` l'autorisait, le
 * planificateur n'envoyait aucune limite de sortie, et le prix comme la consommation
 * n'étaient découverts qu'après la réponse du fournisseur. Le premier appel pouvait donc à
 * lui seul franchir le plafond, et il était déjà payé quand on l'apprenait.
 *
 * Les quatre preuves demandées sont ici, une par test, plus celle de la sérialisation qui ne
 * peut pas vivre ici (voir le dernier test).
 */

const G1: Attribution = { goalId: "g1" };

/** Réservation en mémoire, SÉRIALISÉE PAR LE FIL : un seul processus, un seul fil. */
class FakeReservations implements SpendReservationPort {
  readonly reserved: number[] = [];
  readonly settled: SettleEntry[] = [];
  readonly released: string[] = [];
  private held = 0;
  private spent = 0;
  private n = 0;
  readonly open = new Map<string, number>();

  constructor(private readonly cap: BudgetCap) {}

  async reserve(
    _attribution: Attribution | null,
    requestedTokens: number,
  ): Promise<ReserveOutcome> {
    const window = { ...emptyish, totalTokens: this.spent, calls: 0 };
    const decision = decideReservation(window, this.held, requestedTokens, this.cap);
    if (decision.kind === "DENY") return decision;
    this.reserved.push(requestedTokens);
    this.held += requestedTokens;
    const reservation = {
      id: `r${++this.n}`,
      ownerToken: `o${this.n}`,
      reservedTokens: requestedTokens,
    };
    this.open.set(reservation.id, requestedTokens);
    return { kind: "RESERVED", reservation };
  }

  async settle(reservation: SpendReservation, entry: SettleEntry): Promise<SettlementOutcome> {
    this.settled.push(entry);
    this.held -= this.open.get(reservation.id) ?? 0;
    this.open.delete(reservation.id);
    const actual = entry.usage.kind === "METERED" ? entry.usage.usage.totalTokens : null;
    this.spent += actual ?? 0;
    return {
      reservedTokens: reservation.reservedTokens,
      actualTokens: actual,
      releasedTokens: Math.max(0, reservation.reservedTokens - (actual ?? 0)),
      overrunTokens: Math.max(0, (actual ?? 0) - reservation.reservedTokens),
      closed: true,
      attributedTo: G1,
      unauthenticated: false,
    };
  }

  async renew(): Promise<boolean> {
    return true;
  }

  async release(reservation: SpendReservation): Promise<boolean> {
    this.released.push(reservation.id);
    this.held -= this.open.get(reservation.id) ?? 0;
    return this.open.delete(reservation.id);
  }
}

const emptyish = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  currency: "EUR" as const,
  amount: 0,
  pricedCalls: 0,
  unpricedCalls: 0,
  unmeteredCalls: 0,
  saturated: false,
};

const URL_ = "https://provider.test/v1/chat/completions";

/** Fournisseur qui enregistre le corps RÉELLEMENT émis. Rien d'autre ne compte ici. */
function provider(totalTokens = 10) {
  const bodies: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        model: "m",
        usage: { prompt_tokens: 1, completion_tokens: totalTokens - 1, total_tokens: totalTokens },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl, bodies };
}

const seam = (cap: BudgetCap, inner: typeof fetch, maxOutputTokens?: number) => {
  const reservations = new FakeReservations(cap);
  const fetchImpl = meteredFetch(inner, {
    ledger: new InMemorySpendLedger({ caps: async () => cap }),
    attribution: G1,
    reservations,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
  return { fetchImpl, reservations };
};

describe("C1 — le PREMIER appel est borné et réservé avant le fournisseur", () => {
  it("journal VIDE + plafond de 1 000 tokens : une complétion SANS borne ne part pas", async () => {
    const { fetchImpl: inner } = provider();
    /* Le corps exact du planificateur : aucune limite de sortie déclarée. */
    const plannerBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] });
    const { fetchImpl } = seam({ kind: "CAPPED", maxTotalTokens: 1_000 }, inner);

    await expect(fetchImpl(URL_, { method: "POST", body: plannerBody })).rejects.toMatchObject({
      name: "BudgetDeniedError",
      /* La sortie imposée par défaut (2 048) ne tient pas dans 1 000 : refusé EN ENTIER. */
      reason: "RESERVATION_EXCEEDS_CAP",
    });
    /* LA propriété : le fournisseur n'a jamais été appelé. Rien n'a été payé. */
    expect(inner).not.toHaveBeenCalled();
  });

  it("la sortie émise ne peut pas dépasser la réservation obtenue", async () => {
    const { fetchImpl: inner, bodies } = provider();
    const { fetchImpl, reservations } = seam(
      { kind: "CAPPED", maxTotalTokens: 5_000 },
      inner,
      300, // plafond de sortie de cette couture
    );

    /* L'appelant en demande 99 999. Il n'en obtiendra pas plus que le plafond. */
    await fetchImpl(URL_, {
      method: "POST",
      body: JSON.stringify({ model: "m", max_tokens: 99_999 }),
    });

    const emitted = JSON.parse(bodies[0] ?? "{}") as { max_tokens: number };
    expect(emitted.max_tokens).toBe(300);
    /* Et la réservation couvre bien cette sortie PLUS une majoration de l'entrée. */
    const reserved = reservations.reserved[0] ?? 0;
    expect(reserved).toBeGreaterThanOrEqual(300 + CHAT_TEMPLATE_HEADROOM_TOKENS);
    expect(emitted.max_tokens).toBeLessThanOrEqual(reserved);
  });

  it("la réservation est prise AVANT le réseau, et soldée sur la consommation RÉELLE", async () => {
    const order: string[] = [];
    const inner = vi.fn<typeof fetch>(async () => {
      order.push("réseau");
      return new Response(
        JSON.stringify({
          model: "m",
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const { fetchImpl, reservations } = seam({ kind: "CAPPED", maxTotalTokens: 50_000 }, inner);
    const spy = vi.spyOn(reservations, "reserve");
    spy.mockImplementation(async function (this: void, a, t) {
      order.push("réservation");
      return FakeReservations.prototype.reserve.call(reservations, a, t);
    });

    await fetchImpl(URL_, { method: "POST", body: JSON.stringify({ model: "m" }) });

    expect(order).toEqual(["réservation", "réseau"]);
    /* Le solde remplace la majoration par la consommation mesurée : 7, pas 2 048. */
    expect(reservations.settled[0]?.usage).toEqual({
      kind: "METERED",
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
    });
  });

  it("UNKNOWN_PRICE sous un plafond MONÉTAIRE ferme : aucun appel, pas même le premier", async () => {
    const { fetchImpl: inner } = provider();
    const { fetchImpl } = seam({ kind: "CAPPED", maxCostMicros: 5_000_000 }, inner);

    await expect(
      fetchImpl(URL_, { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 10 }) }),
    ).rejects.toMatchObject({ name: "BudgetDeniedError", reason: "UNPRICED_RESERVATION" });
    expect(inner).not.toHaveBeenCalled();
  });

  it("une requête dont la sortie n'est pas bornable est REFUSÉE, pas émise", async () => {
    const { fetchImpl: inner } = provider();
    const { fetchImpl } = seam({ kind: "CAPPED", maxTotalTokens: 50_000 }, inner);

    /* Pas de corps du tout : impossible d'y écrire une limite sans inventer la requête. */
    await expect(fetchImpl(URL_, { method: "POST" })).rejects.toMatchObject({
      name: "BudgetDeniedError",
      reason: "UNBOUNDED_REQUEST",
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it("REND l'engagement quand l'appel échoue : une panne ne gèle pas le budget du goal", async () => {
    const inner = vi.fn<typeof fetch>(async () => {
      throw new Error("réseau coupé");
    });
    const { fetchImpl, reservations } = seam({ kind: "CAPPED", maxTotalTokens: 5_000 }, inner);

    await expect(
      fetchImpl(URL_, { method: "POST", body: JSON.stringify({ model: "m", max_tokens: 10 }) }),
    ).rejects.toThrow("réseau coupé");
    expect(reservations.released).toEqual(["r1"]);

    /* Et le budget est effectivement redevenu disponible, pas immobilisé jusqu'au bail. */
    expect(await reservations.reserve(G1, 4_900)).toMatchObject({ kind: "RESERVED" });
  });

  it("REND l'engagement sur une réponse non 2xx : un 429 ne consomme pas le plafond", async () => {
    const inner = vi.fn<typeof fetch>(async () => new Response("slow down", { status: 429 }));
    const { fetchImpl, reservations } = seam({ kind: "CAPPED", maxTotalTokens: 5_000 }, inner);

    const response = await fetchImpl(URL_, {
      method: "POST",
      body: JSON.stringify({ model: "m", max_tokens: 10 }),
    });
    expect(response.status).toBe(429);
    expect(reservations.released).toEqual(["r1"]);
    expect(reservations.settled).toEqual([]);
  });

  it("DEUX premiers appels simultanés ne s'accordent pas chacun le budget entier", async () => {
    /*
     * Le cas « journal vide, W appelants ». Ici la sérialisation est celle du fil JavaScript,
     * donc ce test prouve l'ARITHMÉTIQUE (le terme « déjà engagé » est bien compté), pas
     * l'atomicité. L'atomicité est une propriété de PostgreSQL et se prouve contre une vraie
     * base : `postgres-spend-reservations.integration.test.ts`. Un test de concurrence contre
     * un faux magasin ne prouverait que la fidélité du faux.
     */
    const { fetchImpl: inner } = provider();
    const { fetchImpl, reservations } = seam({ kind: "CAPPED", maxTotalTokens: 3_000 }, inner);
    const body = JSON.stringify({ model: "m", max_tokens: 1_000 });

    const outcomes = await Promise.allSettled([
      fetchImpl(URL_, { method: "POST", body }),
      fetchImpl(URL_, { method: "POST", body }),
      fetchImpl(URL_, { method: "POST", body }),
    ]);

    /* Chaque appel engage ~1 300 : trois ne tiennent pas dans 3 000, le troisième est refusé. */
    const denied = outcomes.filter(
      (o) => o.status === "rejected" && o.reason instanceof BudgetDeniedError,
    );
    expect(denied).toHaveLength(1);
    expect(reservations.reserved.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3_000);
  });
});
