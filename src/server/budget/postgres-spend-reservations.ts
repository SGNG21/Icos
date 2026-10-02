import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { attributionFromKey, attributionKey, type Attribution } from "@/core/budget/contracts";
import { decideReservation, settleReservation } from "@/core/budget/spend";
import type {
  ReserveOutcome,
  SettleEntry,
  SettlementOutcome,
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
        await this.lock(tx, key);

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
   * LE point de sérialisation, pris par CHACUNE des quatre opérations (verrou C2).
   *
   * Sans lui dans `reserve`, deux transactions somment les mêmes lignes OPEN, aucune ne voit
   * l'insertion de l'autre, et les deux sont accordées (write skew).
   *
   * Et sans lui dans `settle`, c'est pire et c'était le défaut : `reserve` lit la dépense
   * (journal) PUIS les engagements (réservations), en READ COMMITTED, donc en deux instantanés
   * différents. Un `settle` qui s'intercale entre les deux lectures a déjà ajouté sa ligne au
   * journal — mais APRÈS la première lecture — et a déjà retiré son engagement — AVANT la
   * seconde. La dépense disparaît des deux côtés et la réservation suivante se croit seule.
   * Mesuré sur un plafond de 1 000 : 1 900 engagés. Le verrou rend la paire de lectures
   * atomique vis-à-vis de tout solde, ce qu'aucune contrainte SQL ne sait exprimer.
   *
   * `renew` et `release` le prennent aussi : une opération du même domaine qui n'entrerait pas
   * dans la même sérialisation serait précisément le trou qu'on vient de fermer, à retrouver
   * plus tard.
   *
   * ponytail: `hashtext` rend un int4, donc deux imputations peuvent collisionner et s'attendre
   * pour rien — un coût de DÉBIT, jamais de justesse. Passer à `hashtextextended` (int8, comme
   * `dispatch-attempt-repository.ts`) si la contention devient mesurable.
   */
  private async lock(tx: SqlExec, key: string): Promise<void> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`icos.budget:${this.tenantId}|${key}`}))`,
    );
  }

  /**
   * UNE transaction, SOUS LE VERROU, et dans cet ordre : authentifier, puis écrire.
   *
   * ── CE QUI ÉTAIT CASSÉ (verrou C2) ──────────────────────────────────────────────────────
   * L'observation était écrite au journal AVANT que la réservation soit authentifiée, avec
   * l'imputation FOURNIE PAR L'APPELANT. Réserver sur le goal A puis solder en déclarant le
   * goal B imputait donc la dépense à B : le plafond de A ne bougeait pas, et A pouvait
   * réserver indéfiniment. L'imputation d'un solde vient désormais de la LIGNE DE RÉSERVATION,
   * relue ici sous le verrou ; le type `SettleEntry` rend l'autre inexprimable.
   *
   * ── CE QUI N'A PAS CHANGÉ, ET POURQUOI ──────────────────────────────────────────────────
   * L'écriture au journal n'est PAS conditionnée à la clôture : une réservation dont le bail a
   * expiré pendant l'appel a quand même coûté de vrais tokens, et les taire serait précisément
   * le blanchiment que ce lot interdit. `closed: false` le dit au lieu de le cacher.
   *
   * Une réservation dont l'ID est INCONNU ne fait pas non plus disparaître la dépense : elle
   * est enregistrée NON IMPUTÉE. On ne peut ni deviner son budget, ni l'offrir à celui que
   * l'appelant désigne — c'est exactement la redirection qu'on ferme. `unauthenticated: true`
   * le rend observable. Un id CONNU présenté avec un mauvais jeton, lui, est bien imputé à son
   * goal (la dépense est réelle) mais n'est PAS clos : voir {@link locate}.
   */
  async settle(reservation: SpendReservation, entry: SettleEntry): Promise<SettlementOutcome> {
    return this.options.db.transaction(async (tx) => {
      /*
       * On ne connaît pas encore la clé : on authentifie d'abord pour l'apprendre, puis on
       * verrouille, puis on RELIT sous le verrou. Deux allers-retours, parce que la clé de
       * verrou est précisément ce que la ligne porte. La première lecture ne décide de rien.
       */
      const probe = await this.locate(tx, reservation.id);
      if (probe !== null) await this.lock(tx, probe.key);
      const row = probe === null ? null : await this.locate(tx, reservation.id);

      const attribution = row === null ? null : attributionFromKey(row.key);
      await this.ledgerOn(tx).record({ ...entry, attribution });

      const closed =
        row === null
          ? []
          : ((await tx.execute(sql`
              update spend_reservations
                 set state = 'SETTLED', closed_at = now()
               where id = ${reservation.id}
                 and tenant_id = ${this.tenantId}
                 and owner_token = ${reservation.ownerToken}
                 and state = 'OPEN'
              returning id
            `)) as unknown as Row[]);

      return {
        ...settleReservation(reservation.reservedTokens, entry.usage),
        closed: closed.length === 1,
        attributedTo: attribution,
        unauthenticated: row === null,
      };
    });
  }

  /**
   * La ligne de CETTE réservation dans CE tenant, quel que soit son état et QUEL QUE SOIT le
   * jeton présenté.
   *
   * Pourquoi le jeton de fencing n'est PAS un prédicat ici. Deux questions distinctes ont été
   * confondues par le défaut d'origine :
   *
   *   « à QUEL BUDGET cette dépense revient-elle ? »  -> la LIGNE, par son id. Jamais
   *     l'appelant : c'est exactement la redirection que C2 ferme. Et jamais le jeton non
   *     plus — un porteur dont le jeton a tourné a quand même dépensé sur SON goal, et
   *     enregistrer cette dépense en NON IMPUTÉE ferait silencieusement sous-compter ce goal,
   *     c'est-à-dire rouvrirait un trou de budget en croyant en fermer un.
   *
   *   « a-t-il le droit de CLORE cet engagement ? »   -> le JETON, prédicat de l'UPDATE, donc
   *     appliqué par PostgreSQL et jamais en mémoire. Un mauvais jeton ne clôt rien.
   *
   * Un id INCONNU reste non imputable : il n'y a aucune ligne d'où lire le budget, et on n'en
   * invente pas une.
   */
  private async locate(tx: SqlExec, id: string): Promise<{ key: string } | null> {
    const rows = (await tx.execute(sql`
      select attribution_key
        from spend_reservations
       where id = ${id}
         and tenant_id = ${this.tenantId}
    `)) as unknown as Row[];
    const row = rows[0];
    return row === undefined ? null : { key: String(row.attribution_key) };
  }

  /**
   * PROLONGE un bail VIVANT (verrou C3). `lease_until > now()` est la condition qui compte :
   * un bail déjà échu n'est pas prolongé mais REFUSÉ, parce que le budget qu'il tenait a pu
   * être réattribué à une autre réservation entre-temps. Le ressusciter ferait exister deux
   * fois la même allocation — exactement la double-allocation que C3 interdit — alors que le
   * refus la rend visible à l'appelant, qui peut abandonner son appel.
   *
   * Toutes les comparaisons de temps sont celles de PostgreSQL : aucune horloge de processus
   * ne peut allonger un bail.
   */
  async renew(reservation: SpendReservation): Promise<boolean> {
    return this.options.db.transaction(async (tx) => {
      const probe = await this.locate(tx, reservation.id);
      if (probe === null) return false;
      await this.lock(tx, probe.key);
      const rows = (await tx.execute(sql`
        update spend_reservations
           set lease_until = now() + (${this.leaseMs} * interval '1 millisecond')
         where id = ${reservation.id}
           and tenant_id = ${this.tenantId}
           and owner_token = ${reservation.ownerToken}
           and state = 'OPEN'
           and lease_until > now()
        returning id
      `)) as unknown as Row[];
      return rows.length === 1;
    });
  }

  /**
   * REND un engagement sans dépense (verrou C3). N'écrit RIEN au journal : il n'y a pas eu de
   * dépense. Sans cette opération, une erreur réseau immobiliserait le budget jusqu'à
   * l'échéance du bail, et une rafale d'erreurs gèlerait le goal entier sans avoir rien
   * dépensé — un refus de service produit par le mécanisme censé protéger la dépense.
   *
   * L'état choisi est 'EXPIRED' et non 'SETTLED' : aucune ligne de journal ne lui correspond,
   * et prétendre le contraire fausserait toute réconciliation ultérieure.
   */
  async release(reservation: SpendReservation): Promise<boolean> {
    return this.options.db.transaction(async (tx) => {
      const probe = await this.locate(tx, reservation.id);
      if (probe === null) return false;
      await this.lock(tx, probe.key);
      const rows = (await tx.execute(sql`
        update spend_reservations
           set state = 'EXPIRED', closed_at = now()
         where id = ${reservation.id}
           and tenant_id = ${this.tenantId}
           and owner_token = ${reservation.ownerToken}
           and state = 'OPEN'
        returning id
      `)) as unknown as Row[];
      return rows.length === 1;
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
