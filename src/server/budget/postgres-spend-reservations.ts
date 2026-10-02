import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { attributionKey, type Attribution } from "@/core/budget/contracts";
import { decideReservation, settleReservation } from "@/core/budget/spend";
import type {
  ReserveOutcome,
  SettlementOutcome,
  SpendEntry,
  SpendReservation,
  SpendReservationPort,
} from "./ports";
import {
  PostgresSpendLedger,
  type PostgresSpendLedgerOptions,
  type SqlExec,
} from "./postgres-spend-ledger";

/**
 * RÉSERVATION AVANT DISPATCH, SOLDE SUR LA CONSOMMATION RÉELLE (verrou P0-D).
 * Table `spend_reservations` (migration 0056).
 *
 * ── CE QUI ÉTAIT CASSÉ ──────────────────────────────────────────────────────────────────
 * `checkBudget()` est un contrôle PRÉ-vol et `record()` n'arrive qu'après la réponse du
 * fournisseur. W appelants simultanés lisent donc le même « déjà dépensé » et reçoivent W
 * autorisations : la seule borne était « au plus un appel par appelant simultané », c'est-à-dire
 * une borne qui CROÎT avec le nombre de workers. Quatre workers parallèles croyaient chacun
 * posséder tout le budget restant.
 *
 * ── CE QUE CE FICHIER AJOUTE, ET RIEN DE PLUS ───────────────────────────────────────────
 * Le terme manquant : les tokens DÉJÀ ENGAGÉS par les appels en vol. La décision reste prise
 * par `decideReservation` (couche pure), la dépense réelle reste dans `spend_ledger` repliée
 * par `accumulate`, le chiffrage reste `priceUsage`. Aucune seconde autorité : cette table ne
 * tient AUCUN cumul de dépense, seulement des engagements vivants.
 *
 * Un montant réservé est un PLAFOND déclaré par l'appelant (ce qu'il accepte au maximum de se
 * voir facturer), pas une estimation inventée : le solde le remplace par la consommation
 * mesurée. Sur-réserver coûte de la DISPONIBILITÉ (un refus), jamais un dépassement silencieux.
 *
 * ── POURQUOI UN VERROU, ET PAS UNE CONTRAINTE ───────────────────────────────────────────
 * « La SOMME d'un ensemble de lignes ne doit pas dépasser un plafond » n'est exprimable ni par
 * un CHECK ni par un UNIQUE. En READ COMMITTED, deux transactions concurrentes somment les
 * lignes OPEN sans voir l'insertion non encore validée de l'autre, et toutes deux passent
 * (write skew). `reserve()` prend donc `pg_advisory_xact_lock` sur la clé d'imputation — même
 * forme que `postgres-workforce-store.ts` et `cognitive/memory-store.ts` — et la sérialisation
 * EST la contrainte. Le verrou est par imputation : deux goals différents ne s'attendent pas.
 * Et il est en PostgreSQL, pas en mémoire : un cache par processus donnerait à chaque processus
 * sa propre fenêtre et ne bornerait plus rien du tout.
 *
 * ── EXPIRATION : UN PRÉDICAT, PAS UN BALAYEUR ───────────────────────────────────────────
 * Une réservation abandonnée (worker mort entre la réservation et le solde) cesse de compter
 * dès que son bail `lease_until` est échu, parce que la seule lecture qui compte ne somme que
 * `state = 'OPEN' and lease_until > now()`. Aucun travail de fond à déployer ni à surveiller,
 * et aucune fenêtre pendant laquelle un processus mort est cru en train de dépenser. Toutes les
 * comparaisons de temps utilisent `now()` de PostgreSQL : aucune dérive d'horloge de processus
 * ne peut allonger un bail.
 */

/**
 * Le minimum dont ce magasin a besoin d'une base : ouvrir une TRANSACTION dans laquelle on
 * peut exécuter des requêtes. Déclaré en méthode (bivariante) pour qu'un `Database` Drizzle
 * y réponde sans adaptateur, et assez étroit pour qu'un test puisse le fournir.
 */
export interface TxCapable {
  transaction<T>(fn: (tx: SqlExec) => Promise<T>): Promise<T>;
}

export interface PostgresSpendReservationsOptions extends Omit<PostgresSpendLedgerOptions, "db"> {
  readonly db: TxCapable;
  /**
   * Durée du bail d'une réservation. Au-delà, une réservation non soldée cesse d'être comptée :
   * elle doit donc majorer la durée d'un appel de complétion, sans quoi un appel lent verrait
   * son propre engagement expirer alors qu'il dépense encore.
   */
  readonly leaseMs?: number;
  readonly newId?: () => string;
}

/** Dix minutes : largement au-dessus d'une complétion, largement en-dessous d'une panne. */
export const DEFAULT_RESERVATION_LEASE_MS = 10 * 60 * 1_000;

type Row = Record<string, unknown>;

export class PostgresSpendReservations implements SpendReservationPort {
  private readonly tenantId: string;
  private readonly leaseMs: number;
  private readonly newId: () => string;

  constructor(private readonly options: PostgresSpendReservationsOptions) {
    /* Pas de contexte tenant -> pas d'opération tenant. Refus à la construction. */
    const tenantId = options.tenantId.trim();
    if (tenantId.length === 0) {
      throw new Error("PostgresSpendReservations: tenantId requis (pas de tenant, pas de budget)");
    }
    this.tenantId = tenantId;
    this.leaseMs = options.leaseMs ?? DEFAULT_RESERVATION_LEASE_MS;
    if (!(Number.isFinite(this.leaseMs) && this.leaseMs > 0)) {
      throw new Error("PostgresSpendReservations: leaseMs doit être > 0");
    }
    this.newId = options.newId ?? randomUUID;
  }

  /** Le journal lié à CETTE connexion : même autorité d'accumulation, même table de prix. */
  private ledgerOn(exec: PostgresSpendLedgerOptions["db"]): PostgresSpendLedger {
    return new PostgresSpendLedger({ ...this.options, db: exec });
  }

  async reserve(attribution: Attribution | null, requestedTokens: number): Promise<ReserveOutcome> {
    const key = attributionKey(attribution);
    try {
      return await this.options.db.transaction(async (tx) => {
        /*
         * LE point de sérialisation. Sans lui, deux transactions somment les mêmes lignes
         * OPEN, aucune ne voit l'insertion de l'autre, et les deux sont accordées.
         * ponytail: `hashtext` rend un int4, donc deux imputations peuvent collisionner et
         * s'attendre pour rien — un coût de DÉBIT, jamais de justesse. Passer à
         * `hashtextextended` (int8, comme `dispatch-attempt-repository.ts`) si la contention
         * devient mesurable.
         */
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`icos.budget:${this.tenantId}|${key}`}))`,
        );

        /* Dépense RÉELLE : relue depuis le journal et repliée par l'autorité unique. */
        const window = await this.ledgerOn(tx).windowFor(attribution);

        /* Engagements VIVANTS : un bail échu ne compte plus, sans aucun balayeur. */
        const held = (await tx.execute(sql`
          select coalesce(sum(reserved_tokens), 0)::bigint as held
            from spend_reservations
           where tenant_id = ${this.tenantId}
             and attribution_key = ${key}
             and state = 'OPEN'
             and lease_until > now()
        `)) as unknown as Row[];

        const decision = decideReservation(
          window,
          Number(held[0]?.held ?? Number.NaN),
          requestedTokens,
          await this.options.caps(attribution),
        );
        if (decision.kind === "DENY") return decision;

        const reservation: SpendReservation = {
          id: this.newId(),
          ownerToken: this.newId(),
          reservedTokens: requestedTokens,
        };
        await tx.execute(sql`
          insert into spend_reservations (
            id, tenant_id, attribution_key, goal_id, reserved_tokens, owner_token, lease_until
          ) values (
            ${reservation.id},
            ${this.tenantId},
            ${key},
            ${attribution?.goalId ?? null},
            ${reservation.reservedTokens},
            ${reservation.ownerToken},
            now() + (${this.leaseMs} * interval '1 millisecond')
          )
        `);
        return { kind: "RESERVED", reservation };
      });
    } catch (cause) {
      /* Budget invérifiable = refus, jamais une autorisation par défaut. */
      return {
        kind: "DENY",
        reason: "UNUSABLE_WINDOW",
        detail: `réservation impossible : ${cause instanceof Error ? cause.message : "cause inconnue"}`,
      };
    }
  }

  /**
   * UNE transaction : l'observation RÉELLE est écrite au journal et la réservation est close
   * ensemble. Si la transaction échoue, rien n'a eu lieu et le bail expirera de lui-même —
   * l'issue sûre, puisqu'un engagement encore compté ne fait que RESTREINDRE la dépense.
   *
   * L'écriture au journal n'est PAS conditionnée à la clôture : une réservation dont le bail a
   * expiré pendant l'appel a quand même coûté de vrais tokens, et les taire serait précisément
   * le blanchiment que ce lot interdit. `closed: false` le dit au lieu de le cacher.
   */
  async settle(reservation: SpendReservation, entry: SpendEntry): Promise<SettlementOutcome> {
    return this.options.db.transaction(async (tx) => {
      await this.ledgerOn(tx).record(entry);
      const closed = (await tx.execute(sql`
        update spend_reservations
           set state = 'SETTLED', closed_at = now()
         where id = ${reservation.id}
           and tenant_id = ${this.tenantId}
           and owner_token = ${reservation.ownerToken}
           and state = 'OPEN'
        returning id
      `)) as unknown as Row[];

      return {
        ...settleReservation(reservation.reservedTokens, entry.usage),
        closed: closed.length === 1,
      };
    });
  }

  /**
   * Marque EXPIRÉES les réservations dont le bail est échu. Purement cosmétique : la lecture de
   * `reserve()` les ignore déjà. C'est de l'hygiène de rapport, jamais une condition de la
   * borne — aucune exécution de cette méthode n'est nécessaire pour que le plafond tienne.
   */
  async expireStale(): Promise<number> {
    const rows = (await this.options.db.transaction((tx) =>
      tx.execute(sql`
        update spend_reservations
           set state = 'EXPIRED', closed_at = now()
         where tenant_id = ${this.tenantId}
           and state = 'OPEN'
           and lease_until <= now()
        returning id
      `),
    )) as unknown as Row[];
    return rows.length;
  }
}
