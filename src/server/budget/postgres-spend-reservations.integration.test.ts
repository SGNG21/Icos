import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MICROS_PER_EUR, UNMETERED, type Attribution } from "@/core/budget/contracts";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { PostgresSpendLedger } from "./postgres-spend-ledger";
import {
  PostgresSpendReservations,
  type PostgresSpendReservationsOptions,
} from "./postgres-spend-reservations";
import type { BudgetCapResolver, ReserveOutcome, SettleEntry, SpendReservation } from "./ports";

/**
 * LA PREUVE DU VERROU P0-D, contre une vraie base PostgreSQL (migration 0056).
 *
 * Ce que ce fichier doit établir et qu'aucun test unitaire ne peut établir : QUATRE WORKERS
 * SIMULTANÉS NE DÉPASSENT JAMAIS LE PLAFOND DU GOAL. La simultanéité est réelle — les
 * promesses sont créées SANS `await` puis résolues ensemble par `Promise.all`, chacune sur sa
 * propre connexion du pool — et non « séquentielle avec un commentaire ».
 *
 * Avant ce lot, la borne était « au plus un appel par appelant simultané » : elle CROISSAIT
 * avec le nombre de workers. Le test de l'ancienne borne vit toujours dans
 * `postgres-spend-ledger.integration.test.ts` (« W contrôles simultanés passent ») : les deux
 * fichiers côte à côte disent exactement ce qui a changé.
 *
 * VÉRIFICATION PAR MUTATION (faite à la main, à refaire si ce fichier change) : retirer la
 * ligne `pg_advisory_xact_lock` de `postgres-spend-reservations.ts` fait PASSER les quatre
 * réservations et casse « exactement 3 accordées » — le résultat est consigné dans le rapport
 * du lot. Une borne annoncée sans test qui échoue quand on la casse ne prouve rien.
 *
 * `pnpm test` n'exécute PAS ce fichier (exclu par vitest.config.ts) : il est destiné à la passe
 * sérielle du coordinateur, seul propriétaire de la base de test partagée.
 *
 * HARNESS : la base de test LOCALE (`ICOS_TEST_DATABASE_URL`), jamais
 * `describe.skipIf(!dockerAvailable)` + Testcontainers — ce motif-là s'est sauté en silence
 * pendant une session entière et la suite déclarait un succès en ne prouvant rien.
 */

const TENANT = "default";
const OTHER_TENANT = "autre-tenant";
const G1: Attribution = { goalId: "g1" };
const CAP = 1_000;

/** Table de prix VIDE : la seule configuration honnête aujourd'hui, donc plafond en tokens. */
const tokenCap: BudgetCapResolver = async () => ({ kind: "CAPPED", maxTotalTokens: CAP });

/* AUCUNE `attribution` : `SettleEntry` la retire du type (verrou C2). Un solde ne DÉSIGNE
   plus son budget, il hérite de celui de sa réservation. */
const entry = (total: number): SettleEntry => ({
  modelId: "test/model",
  usage: {
    kind: "METERED",
    usage: { promptTokens: total, completionTokens: 0, totalTokens: total },
  },
  at: "2026-10-02T00:00:00.000Z",
});

describe("spend_reservations — réservation atomique par goal (migration 0056)", () => {
  let ctx: { handle: DatabaseHandle };

  beforeAll(() => {
    /* Au moins autant de connexions que de workers simultanés, sinon la preuve est bridée. */
    ctx = { handle: createDatabase(TEST_DATABASE_URL, { max: 10 }) };
  });
  afterAll(async () => {
    await ctx.handle.close();
  });

  beforeEach(async () => {
    await ctx.handle.db.execute(sql`TRUNCATE TABLE spend_reservations`);
    await ctx.handle.db.execute(sql`TRUNCATE TABLE spend_ledger`);
    await ctx.handle.db.execute(sql`DELETE FROM goals`);
  });

  const reservations = (over: Partial<PostgresSpendReservationsOptions> = {}) =>
    new PostgresSpendReservations({
      db: ctx.handle.db,
      tenantId: TENANT,
      caps: tokenCap,
      priceTable: {},
      ...over,
    });

  const ledger = (tenantId = TENANT) =>
    new PostgresSpendLedger({
      db: ctx.handle.db,
      tenantId,
      caps: tokenCap,
      priceTable: {},
    });

  const openTokens = async (key = "goal=g1") => {
    const rows = (await ctx.handle.db.execute(sql`
      select coalesce(sum(reserved_tokens), 0)::bigint as held
        from spend_reservations
       where tenant_id = ${TENANT} and attribution_key = ${key}
         and state = 'OPEN' and lease_until > now()
    `)) as unknown as { held: string }[];
    return Number(rows[0].held);
  };

  const granted = (outcomes: readonly ReserveOutcome[]): SpendReservation[] =>
    outcomes.flatMap((o) => (o.kind === "RESERVED" ? [o.reservation] : []));

  describe("LA PREUVE : 4 workers simultanés sur UN SEUL goal", () => {
    it("n'accorde jamais plus que le plafond, réservations ET soldes confondus", async () => {
      const store = reservations();
      const PER_WORKER = 300; // 4 x 300 = 1200 > 1000 : le plafond doit trancher.

      /* Quatre promesses créées SANS await, résolues ensemble : la course est réelle. */
      const inFlight = [
        store.reserve(G1, PER_WORKER),
        store.reserve(G1, PER_WORKER),
        store.reserve(G1, PER_WORKER),
        store.reserve(G1, PER_WORKER),
      ];
      const outcomes = await Promise.all(inFlight);

      const ok = granted(outcomes);
      /* 3 x 300 = 900 tient ; la quatrième ferait 1200. Exactement trois passent. */
      expect(ok).toHaveLength(3);
      expect(outcomes.filter((o) => o.kind === "DENY")).toHaveLength(1);
      expect(outcomes.find((o) => o.kind === "DENY")).toMatchObject({
        reason: "RESERVATION_EXCEEDS_CAP",
      });

      /* L'INVARIANT, dit directement : le total engagé ne dépasse pas le plafond autorisé. */
      const committed = ok.reduce((sum, r) => sum + r.reservedTokens, 0);
      expect(committed).toBeLessThanOrEqual(CAP);
      expect(await openTokens()).toBe(committed);

      /* Puis les trois soldent leur consommation réelle, elle aussi simultanément. */
      await Promise.all(ok.map((r) => store.settle(r, entry(PER_WORKER))));
      const window = await ledger().windowFor(G1);
      expect(window.totalTokens).toBe(committed);
      expect(window.totalTokens).toBeLessThanOrEqual(CAP);
      expect(await openTokens()).toBe(0);
    });

    it("multiplier les workers ne multiplie PAS le budget (16 simultanés)", async () => {
      const store = reservations();
      const outcomes = await Promise.all(Array.from({ length: 16 }, () => store.reserve(G1, 100)));
      const ok = granted(outcomes);
      /* Exactement 10 x 100 = 1000. Pas 16 x 100, qui était l'ancien comportement. */
      expect(ok).toHaveLength(10);
      expect(ok.reduce((s, r) => s + r.reservedTokens, 0)).toBe(CAP);
    });

    it("la borne tient ENTRE PROCESSUS : des instances neuves ne rouvrent pas le budget", async () => {
      /* Un cache par processus donnerait à chacun sa propre fenêtre et ne bornerait rien. */
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, () => reservations().reserve(G1, 300)),
      );
      expect(granted(outcomes)).toHaveLength(3);
    });

    it("une connexion NEUVE voit les mêmes engagements (aucun état en mémoire)", async () => {
      await reservations().reserve(G1, 900);
      const fresh = createDatabase(TEST_DATABASE_URL, { max: 2 });
      try {
        const outcome = await new PostgresSpendReservations({
          db: fresh.db,
          tenantId: TENANT,
          caps: tokenCap,
          priceTable: {},
        }).reserve(G1, 200);
        expect(outcome).toMatchObject({ kind: "DENY", reason: "RESERVATION_EXCEEDS_CAP" });
      } finally {
        await fresh.close();
      }
    });
  });

  describe("UN SEUL budget pour tout l'arbre du goal (P0-B)", () => {
    it("deux missions du MÊME goal réservent sur la MÊME enveloppe", async () => {
      const store = reservations();
      const outcomes = await Promise.all([
        store.reserve({ goalId: "g1", missionId: "m1" }, 600),
        store.reserve({ goalId: "g1", missionId: "m2" }, 600),
      ]);
      /* Si la clé incluait la mission, les deux passeraient : chaque mission aurait son budget. */
      expect(granted(outcomes)).toHaveLength(1);
      expect(await openTokens()).toBe(600);
    });

    it("deux goals distincts ne se gênent pas", async () => {
      const store = reservations();
      const outcomes = await Promise.all([
        store.reserve({ goalId: "g1" }, 1_000),
        store.reserve({ goalId: "g2" }, 1_000),
      ]);
      expect(granted(outcomes)).toHaveLength(2);
      expect(await openTokens("goal=g1")).toBe(1_000);
      expect(await openTokens("goal=g2")).toBe(1_000);
    });

    it("isole les tenants : l'engagement d'un tenant n'engage pas l'autre", async () => {
      await reservations().reserve(G1, 1_000);
      expect(await reservations({ tenantId: OTHER_TENANT }).reserve(G1, 1_000)).toMatchObject({
        kind: "RESERVED",
      });
    });
  });

  describe("solde sur la consommation RÉELLE", () => {
    it("rend le reliquat : le goal peut réserver de nouveau ce qu'il n'a pas consommé", async () => {
      const store = reservations();
      const first = await store.reserve(G1, 900);
      if (first.kind !== "RESERVED") throw new Error("attendu RESERVED");

      /* Tant que la réservation vit, les 900 sont engagés. */
      expect(await store.reserve(G1, 200)).toMatchObject({ kind: "DENY" });

      const settlement = await store.settle(first.reservation, entry(100));
      expect(settlement).toMatchObject({
        reservedTokens: 900,
        actualTokens: 100,
        releasedTokens: 800,
        overrunTokens: 0,
        closed: true,
      });
      /* 100 réellement dépensés : les 800 rendus sont réservables de nouveau. */
      expect(await store.reserve(G1, 800)).toMatchObject({ kind: "RESERVED" });
    });

    it("DIT le dépassement et le compte : le journal porte la consommation réelle", async () => {
      const store = reservations();
      const r = await store.reserve(G1, 100);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");

      const settlement = await store.settle(r.reservation, entry(950));
      expect(settlement).toMatchObject({ actualTokens: 950, overrunTokens: 850, closed: true });
      /* Le dépassement n'est pas rogné à 100 : la fenêtre dit 950, et elle referme le goal. */
      expect((await ledger().windowFor(G1)).totalTokens).toBe(950);
      expect(await store.reserve(G1, 100)).toMatchObject({
        kind: "DENY",
        reason: "RESERVATION_EXCEEDS_CAP",
      });
    });

    it("une consommation NON MESURÉE referme le goal au lieu de libérer", async () => {
      const store = reservations();
      const r = await store.reserve(G1, 500);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      const settlement = await store.settle(r.reservation, {
        ...entry(0),
        usage: { kind: UNMETERED, reason: "USAGE_ABSENT" },
      });
      expect(settlement).toMatchObject({ actualTokens: null, releasedTokens: 0 });
      expect(await store.reserve(G1, 1)).toMatchObject({
        kind: "DENY",
        reason: "UNMETERED_USAGE_IN_WINDOW",
      });
    });

    it("un JETON DE FENCING étranger ne peut pas clore, mais la dépense est enregistrée", async () => {
      const store = reservations();
      const r = await store.reserve(G1, 500);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");

      const usurped: SpendReservation = { ...r.reservation, ownerToken: "jeton-étranger" };
      const settlement = await store.settle(usurped, entry(50));
      expect(settlement.closed).toBe(false);
      /*
       * La dépense réelle est au journal, ET SUR LE BON GOAL. Le jeton gouverne la CLÔTURE,
       * pas l'IMPUTATION : imputer cette ligne en NON IMPUTÉE ferait sous-compter g1, c'est-
       * à-dire rouvrirait un trou de budget en croyant en fermer un.
       */
      expect((await ledger().windowFor(G1)).totalTokens).toBe(50);
      expect(settlement.attributedTo).toEqual(G1);
      expect(settlement.unauthenticated).toBe(false);
      /* Et la réservation reste engagée : seul son porteur légitime peut la rendre. */
      expect(await openTokens()).toBe(500);
    });

    it("ne solde pas deux fois la même réservation", async () => {
      const store = reservations();
      const r = await store.reserve(G1, 500);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      expect((await store.settle(r.reservation, entry(10))).closed).toBe(true);
      expect((await store.settle(r.reservation, entry(10))).closed).toBe(false);
    });
  });

  describe("un porteur disparu ne garde pas le budget en otage", () => {
    it("une réservation dont le BAIL est échu cesse de compter, sans aucun balayeur", async () => {
      /* Bail de 1 ms : le worker « meurt » juste après avoir réservé. */
      const abandoned = reservations({ leaseMs: 1 });
      expect(await abandoned.reserve(G1, 1_000)).toMatchObject({ kind: "RESERVED" });
      await new Promise((resolve) => setTimeout(resolve, 30));

      /* Aucune tâche de fond n'a tourné : le prédicat `lease_until > now()` suffit. */
      expect(await openTokens()).toBe(0);
      expect(await reservations().reserve(G1, 1_000)).toMatchObject({ kind: "RESERVED" });
    });

    it("un bail VIVANT garde bien le budget engagé", async () => {
      expect(await reservations({ leaseMs: 60_000 }).reserve(G1, 1_000)).toMatchObject({
        kind: "RESERVED",
      });
      expect(await reservations().reserve(G1, 1)).toMatchObject({
        kind: "DENY",
        reason: "RESERVATION_EXCEEDS_CAP",
      });
    });

    it("expireStale marque les lignes échues sans changer la décision", async () => {
      await reservations({ leaseMs: 1 }).reserve(G1, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(await reservations().expireStale()).toBe(1);
      /* Idempotent, et l'autorisation était déjà acquise avant son passage. */
      expect(await reservations().expireStale()).toBe(0);
      expect(await reservations().reserve(G1, 1_000)).toMatchObject({ kind: "RESERVED" });
    });
  });

  /**
   * VERROU C2 — RÉSERVE ET SOLDE DANS UN SEUL DOMAINE DE SÉRIALISATION.
   *
   * Le défaut : `settle()` ne prenait AUCUN verrou. `reserve()` lit la dépense (journal) PUIS
   * les engagements (réservations) — deux instantanés distincts en READ COMMITTED. Un solde
   * qui s'intercale entre les deux a déjà ajouté sa ligne au journal (après la 1re lecture)
   * et déjà retiré son engagement (avant la 2de) : la dépense DISPARAÎT des deux côtés et la
   * réservation suivante se croit seule sur un budget vide.
   */
  describe("C2 — réserve et solde partagent UN domaine de sérialisation", () => {
    it("un solde ne peut pas faire DISPARAÎTRE la dépense entre les deux lectures de reserve", async () => {
      /*
       * On met la course sous pression plutôt que de l'espérer : des cycles
       * réserver -> solder tournent EN MÊME TEMPS que des réservations, en boucle. Si la
       * fenêtre de disparition existe, elle finit par s'ouvrir, et l'invariant la révèle.
       * Mutation vérifiée : en retirant `this.lock` de `settle`, ce test échoue.
       */
      const store = reservations({ leaseMs: 60_000 });
      const CYCLES = 24;

      const churn = async () => {
        for (let i = 0; i < CYCLES; i += 1) {
          const r = await store.reserve(G1, 50);
          if (r.kind !== "RESERVED") continue;
          await store.settle(r.reservation, entry(50));
        }
      };
      /* Quatre fils de churn, tous sur LE MÊME goal, donc tous sur le même plafond. */
      await Promise.all([churn(), churn(), churn(), churn()]);

      /*
       * L'INVARIANT : la dépense committée ne dépasse jamais le plafond. Chaque cycle solde
       * exactement ce qu'il a réservé, donc dès que le total atteint 1 000 plus aucune
       * réservation ne peut être accordée. Sans verrou partagé, des réservations passent sur
       * une fenêtre qui a « perdu » des soldes, et le total le dépasse.
       */
      const window = await ledger().windowFor(G1);
      expect(window.totalTokens).toBeLessThanOrEqual(CAP);
    });

    it("le solde impute à la RÉSERVATION, et un ID inconnu n'impute à personne", async () => {
      const store = reservations();
      const r = await store.reserve(G1, 100);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");

      const good = await store.settle(r.reservation, entry(10));
      expect(good.attributedTo).toEqual(G1);
      expect((await ledger().windowFor(G1)).totalTokens).toBe(10);

      /* Réservation FORGÉE : aucune ligne, donc aucun budget à désigner. */
      const forged = await store.settle(
        { id: "jamais-réservé", ownerToken: "inventé", reservedTokens: 999 },
        entry(777),
      );
      expect(forged).toMatchObject({ unauthenticated: true, closed: false, attributedTo: null });
      /* La dépense existe — mais g1 n'a pas payé pour elle. */
      expect((await ledger().windowFor(G1)).totalTokens).toBe(10);
      expect((await ledger().windowFor(null)).totalTokens).toBe(777);
    });

    it("réserver sur g1 et solder NE PEUT PAS charger g2 : c'est inexprimable", async () => {
      const store = reservations();
      const r = await store.reserve(G1, 100);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      await store.settle(r.reservation, entry(60));

      /* Le budget de g2 est intact : rien n'a pu y être redirigé. */
      expect((await ledger().windowFor({ goalId: "g2" })).totalTokens).toBe(0);
      expect((await ledger().windowFor(G1)).totalTokens).toBe(60);
    });
  });

  /**
   * VERROU C3 — LE BAIL SE PROLONGE TANT QUE L'APPEL VIT, ET SE REND QUAND IL MEURT.
   *
   * Le défaut : l'expiration libérait le budget alors que l'appel pouvait encore tourner, sans
   * aucun moyen de prolonger. Un plafond nominal de 1 000 pouvait donc en autoriser 2 000.
   */
  describe("C3 — prolongation, reddition et fencing du bail", () => {
    it("PROLONGE un bail vivant : l'appel qui dure garde son engagement", async () => {
      /* 120 ms : assez court pour expirer pendant le test, assez long pour être prolongé. */
      const store = reservations({ leaseMs: 120 });
      const r = await store.reserve(G1, 1_000);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");

      for (let i = 0; i < 3; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(await store.renew(r.reservation)).toBe(true);
      }

      /* 180 ms après la réservation, bien au-delà du bail initial : toujours engagé. */
      expect(await openTokens()).toBe(1_000);
      expect(await reservations().reserve(G1, 1)).toMatchObject({
        kind: "DENY",
        reason: "RESERVATION_EXCEEDS_CAP",
      });
    });

    it("ne RESSUSCITE pas un bail échu : le budget a pu être réattribué", async () => {
      const store = reservations({ leaseMs: 20 });
      const r = await store.reserve(G1, 1_000);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      await new Promise((resolve) => setTimeout(resolve, 60));

      /* Un autre porteur a pu prendre tout le budget entre-temps : c'est le cas qu'on simule. */
      expect(await reservations().reserve(G1, 1_000)).toMatchObject({ kind: "RESERVED" });
      expect(await store.renew(r.reservation)).toBe(false);
      /* Pas de double allocation : le total engagé reste au plafond, pas à deux fois. */
      expect(await openTokens()).toBe(1_000);
    });

    it("un JETON DE FENCING étranger ne prolonge ni ne rend", async () => {
      const store = reservations({ leaseMs: 60_000 });
      const r = await store.reserve(G1, 500);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      const usurped: SpendReservation = { ...r.reservation, ownerToken: "étranger" };

      expect(await store.renew(usurped)).toBe(false);
      expect(await store.release(usurped)).toBe(false);
      expect(await openTokens()).toBe(500);
      /* Le porteur légitime, lui, peut toujours les deux. */
      expect(await store.renew(r.reservation)).toBe(true);
      expect(await store.release(r.reservation)).toBe(true);
    });

    it("REND l'engagement sans écrire la moindre dépense, et le budget redevient réservable", async () => {
      const store = reservations({ leaseMs: 60_000 });
      const r = await store.reserve(G1, 1_000);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      expect(await reservations().reserve(G1, 1)).toMatchObject({ kind: "DENY" });

      expect(await store.release(r.reservation)).toBe(true);
      /* Aucune ligne de journal : il n'y a pas eu de dépense. */
      expect((await ledger().windowFor(G1)).calls).toBe(0);
      expect(await openTokens()).toBe(0);
      expect(await reservations().reserve(G1, 1_000)).toMatchObject({ kind: "RESERVED" });
    });

    it("rendre deux fois, ou rendre ce qui est déjà soldé, ne rend rien de plus", async () => {
      const store = reservations({ leaseMs: 60_000 });
      const r = await store.reserve(G1, 100);
      if (r.kind !== "RESERVED") throw new Error("attendu RESERVED");
      expect(await store.release(r.reservation)).toBe(true);
      expect(await store.release(r.reservation)).toBe(false);

      const r2 = await store.reserve(G1, 100);
      if (r2.kind !== "RESERVED") throw new Error("attendu RESERVED");
      await store.settle(r2.reservation, entry(10));
      expect(await store.release(r2.reservation)).toBe(false);
    });
  });

  describe("fermé par défaut", () => {
    it("refuse une imputation sans goal : aucun budget de propriétaire à engager", async () => {
      const store = new PostgresSpendReservations({
        db: ctx.handle.db,
        tenantId: TENANT,
        /* Le vrai résolveur, qui refuse délibérément le trafic non imputé. */
        caps: async (attribution) =>
          attribution?.goalId ? { kind: "CAPPED", maxTotalTokens: CAP } : { kind: "CAPPED" },
        priceTable: {},
      });
      expect(await store.reserve(null, 10)).toMatchObject({
        kind: "DENY",
        reason: "NO_ENFORCEABLE_CAP",
      });
      expect(await openTokens("UNATTRIBUTED")).toBe(0);
    });

    it("refuse un plafond MONÉTAIRE sans prix au lieu d'inventer un prix", async () => {
      const store = reservations({
        caps: async () => ({ kind: "CAPPED", maxCostMicros: 10 * MICROS_PER_EUR }),
      });
      expect(await store.reserve(G1, 10)).toMatchObject({
        kind: "DENY",
        reason: "UNPRICED_RESERVATION",
      });
    });

    it.each([0, -1, 1.5, Number.NaN])("refuse un montant demandé invalide (%s)", async (tokens) => {
      expect(await reservations().reserve(G1, tokens)).toMatchObject({
        kind: "DENY",
        reason: "INVALID_RESERVATION",
      });
      expect(await openTokens()).toBe(0);
    });

    it("la base impose elle-même un engagement strictement positif", async () => {
      /* Même en contournant le code, la contrainte SQL refuse : la borne n'est pas qu'en TS. */
      await expect(
        ctx.handle.db.execute(sql`
          insert into spend_reservations
            (id, tenant_id, attribution_key, reserved_tokens, owner_token, lease_until)
          values ('x', ${TENANT}, 'goal=g1', 0, 'o', now() + interval '1 minute')
        `),
      ).rejects.toThrow();
    });

    it("la base refuse une ligne OPEN déjà close, et une ligne close sans date", async () => {
      const bad = (state: string, closedAt: string) =>
        ctx.handle.db.execute(sql`
          insert into spend_reservations
            (id, tenant_id, attribution_key, reserved_tokens, owner_token, lease_until,
             state, closed_at)
          values (${`x-${state}`}, ${TENANT}, 'goal=g1', 1, 'o', now(),
                  ${state}, ${sql.raw(closedAt)})
        `);
      await expect(bad("OPEN", "now()")).rejects.toThrow();
      await expect(bad("SETTLED", "null")).rejects.toThrow();
    });
  });
});
