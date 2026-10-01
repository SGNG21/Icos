"use client";

import { useCallback, useReducer, useRef, useState } from "react";

import {
  ASK_MAX_LENGTH,
  ENGINE_NOT_CONNECTED,
  failureCode,
  httpCognitiveTransport,
  PROPOSAL_AWAITING,
  submitPhase,
  turnText,
  type Reply,
  type SubmitPhase,
  type TurnResult,
} from "@/features/cockpit/ask";
import {
  canReplay,
  bodyFits,
  canRetry,
  canSend,
  canType,
  commandReducer,
  describeFailure,
  initialCommand,
  keyFor,
  latestConversation,
  linkFor,
  needsProbe,
  proposalRows,
  type CommandLink,
} from "@/features/mobile/command";

import styles from "./home.module.css";

/**
 * Mobile command bar — the ONLY conversational write path of the Mobile Home.
 *
 * "Que voulez-vous faire ?" goes to the Cognitive Runtime and nowhere else:
 *
 *   Mobile Home → POST /api/cognitive/conversations/:id/turns → durable Turn
 *   → intent / context / reasoning → an answer, or a PROPOSAL the owner decides
 *   → canonical goal intake (never a mission started from this screen).
 *
 * It never submits work to CORE3, the scheduler, the Workforce or the Tool Gateway, and
 * it never calls the runtime's `resume` route: that route is a recovery operation, not a
 * read.
 *
 * ARRIVING ON THE PAGE CALLS THE RUNTIME ZERO TIMES. Listing conversations is a read of
 * the conversation store, but entering the runtime's HTTP surface at all composes the
 * runtime, and composing it relaunches the tenant's interrupted goal launches once a
 * minute (`cognitiveRuntimeFor` -> `recoverLaunches`). On the root page that would make a
 * page view enqueue `start_mission` jobs. So the link is probed when the owner first
 * touches the field, never on mount — see `needsProbe`.
 *
 * All decisions live in `@/features/mobile/command`; this file is wiring.
 */

const transport = httpCognitiveTransport();

const LINK_TEXT: Record<Exclude<CommandLink, "ready">, string> = {
  idle: "",
  loading: "Connexion au runtime cognitif…",
  not_connected: "NON CONNECTÉ — le runtime cognitif n'est pas déployé avec ce build.",
  unavailable:
    "INDISPONIBLE — le runtime cognitif a répondu mais ne peut pas servir (PostgreSQL requis).",
  error: "INCONNU — le runtime cognitif n'a pas répondu comme prévu.",
};

const PHASE_TEXT: Record<SubmitPhase, string> = {
  submitting: "Envoyé — ICOS traite ce tour",
  accepted: "Tour terminé",
  replayed: "Résultat déjà enregistré pour cet envoi (rejoué, pas réexécuté)",
  processing: "Envoi enregistré — le tour est encore en cours",
  failed: "Tour échoué — aucune réponse produite",
  cancelled: "Tour annulé",
  busy: "Refusé — un tour est déjà en cours dans cette conversation (envoyé ailleurs, il n'est pas affiché ici)",
  unknown: "INCONNU — la réponse n'est pas revenue",
  rejected: "Refusé — rien n'a été créé",
};

export interface CommandBarProps {
  /** `tasks.write`: without it the runtime refuses a turn, so nothing is offered. */
  canConverse: boolean;
  /** `missions.write`: without it a proposal is shown but cannot be decided here. */
  canDecideProposals: boolean;
}

export function CommandBar({ canConverse, canDecideProposals }: CommandBarProps) {
  const [state, dispatch] = useReducer(commandReducer, initialCommand);
  const [draft, setDraft] = useState("");
  /** Closed before the first await: two taps inside one latency window send once. */
  const inFlight = useRef(false);
  const deciding = useRef(false);
  /**
   * The link is probed at most once per mount. This latch is the real guard — not a state
   * check, which a callback closure could read stale — so a settled failure is never
   * re-dressed as "connecting" and repeated focus events cost exactly one call.
   */
  const probing = useRef(false);

  const fail = useCallback((reply: Exclude<Reply<unknown>, { kind: "ok" }>) => {
    dispatch({
      type: "link",
      link: linkFor(reply),
      message: `Runtime cognitif : ${describeFailure(reply)}`,
    });
  }, []);

  /**
   * Probe the link. Called from the owner's first gesture, NOT from a mount effect: see
   * the note above on what entering the runtime's HTTP surface sets off. `probing` is a
   * no-op unless the link is still idle, so repeated focus events cost one call.
   */
  const probe = useCallback(async (): Promise<{ conversationId: string | null } | null> => {
    if (probing.current || !canConverse) return null;
    probing.current = true;
    dispatch({ type: "probing" });
    const r = await transport.list().catch(() => null);
    if (!r) {
      dispatch({ type: "link", link: "error" });
      return null;
    }
    if (r.kind !== "ok") {
      fail(r);
      return null;
    }
    const conversationId = latestConversation(r.value.conversations)?.id ?? null;
    dispatch({ type: "listed", engine: r.value.engine, conversationId });
    return { conversationId };
  }, [canConverse, fail]);

  const send = async (resend = false) => {
    if (inFlight.current) return;
    const body = resend && state.pending ? state.pending.text : draft.trim();
    /**
     * The owner's first gesture. Arrival probes nothing, so the link is still `idle` here
     * by design and the readiness half of `canSend` cannot be checked yet — only the body
     * is. The probe below settles the link inside this same gesture.
     */
    const firstGesture = !resend && needsProbe(state);
    // A replay is gated differently from a new question: it may — and must — proceed while
    // the turn it is asking about is still open, or a `processing` turn can never settle.
    if (!canConverse) return;
    if (resend ? !canReplay(state) : !(firstGesture ? bodyFits(body) : canSend(state, body)))
      return;
    inFlight.current = true;
    try {
      let probed: { conversationId: string | null } | null = null;
      if (firstGesture) {
        probed = await probe();
        // A failed probe stops here: its own notice says why, and nothing is sent blind.
        // ponytail: this also stops when a focus-triggered probe is still on the wire, so a
        // cold start can cost a second tap. Deliberate — the alternative is queueing a send
        // behind an unsettled link, and "never send blind" is the safer corner to keep.
        if (!probed) return;
      }
      // The key is settled before anything durable is created, so a non-secure context
      // fails without leaving an empty conversation behind.
      let key: string;
      try {
        key = keyFor(state, body, () => crypto.randomUUID());
      } catch {
        dispatch({ type: "message", message: "Contexte non sécurisé : rien n'a été envoyé." });
        return;
      }
      let id = probed ? probed.conversationId : state.conversationId;
      if (!id) {
        const created = await transport.create().catch(() => null);
        if (!created) {
          dispatch({ type: "message", message: "Impossible d'ouvrir une conversation." });
          return;
        }
        if (created.kind !== "ok") return fail(created);
        id = created.value.conversation.id;
        dispatch({ type: "conversation", id });
      }
      dispatch({ type: "sending", text: body, idempotencyKey: key });
      let reply: Reply<TurnResult>;
      try {
        reply = await transport.submit(id, { text: body, idempotencyKey: key });
      } catch {
        reply = { kind: "error", status: 0, code: "network", message: "", typed: false };
      }
      const phase = submitPhase(reply);
      if (phase === "not_connected") return dispatch({ type: "link", link: "not_connected" });
      if (reply.kind === "ok") {
        dispatch({ type: "settled", result: reply.value, ...phase });
        if (["accepted", "replayed", "processing"].includes(phase.phase)) setDraft("");
      } else {
        dispatch({ type: "failed", ...phase });
      }
    } finally {
      inFlight.current = false;
    }
  };

  const decide = async (refId: string, decision: "approve" | "reject") => {
    if (!state.conversationId || deciding.current) return;
    deciding.current = true;
    try {
      const r = await transport.decide(state.conversationId, refId, decision).catch(() => null);
      if (!r) return dispatch({ type: "message", message: "La décision n'a pas atteint ICOS." });
      if (r.kind !== "ok")
        return dispatch({
          type: "message",
          message: `Décision refusée : ${describeFailure(r)}`,
        });
      dispatch({ type: "proposal", proposal: r.value.proposal });
    } finally {
      deciding.current = false;
    }
  };

  /**
   * Typable covers both idle and ready, because the field is what triggers the probe. The
   * send button adds a non-empty draft; `canSend` (link + nothing in flight) is re-checked
   * inside `send` itself, so a stale render can never let a submission through.
   */
  const typable = canType(state) && canConverse;
  // Only the tail: the phone renders the current exchange, not a transcript.
  const shown = state.turns.slice(-4);

  return (
    <div className={styles.commandConversation}>
      {/* A permission the server already settled: stated before, and instead of, any
          link state — the runtime's availability is irrelevant if nothing may be sent. */}
      {!canConverse ? (
        <p className={styles.commandNotice} data-state="UNAVAILABLE" role="status">
          <strong>LECTURE SEULE</strong>
          <span className={styles.muted}>
            Converser avec ICOS demande le rôle habilité (tasks.write).
          </span>
        </p>
      ) : (
        state.link !== "ready" &&
        state.link !== "idle" && (
          <p className={styles.commandNotice} data-state={state.link.toUpperCase()} role="status">
            <strong>{LINK_TEXT[state.link]}</strong>
            {state.link === "not_connected" && (
              <span className={styles.muted}>
                Rien n&apos;a été envoyé à un modèle. Aucune réponse n&apos;est affichée car aucune
                n&apos;existe.
              </span>
            )}
          </p>
        )
      )}

      {canConverse && state.link === "ready" && state.engine === ENGINE_NOT_CONNECTED && (
        <p className={styles.commandNotice} data-state="NOT_CONNECTED" role="status">
          <strong>MOTEUR COGNITIF : NON CONNECTÉ</strong>
          <span className={styles.muted}>
            Le runtime enregistre vos tours mais aucun modèle n&apos;est configuré : les réponses
            sont l&apos;avis « non connecté » du runtime, pas une analyse d&apos;ICOS.
          </span>
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className={styles.textCommandForm}
      >
        <input
          type="text"
          value={draft}
          maxLength={ASK_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Tapez une commande…"
          className={styles.textCommandInput}
          aria-label="Commande textuelle"
          onFocus={() => void probe()}
          disabled={!typable}
        />
        <button
          type="submit"
          className={styles.textCommandSubmit}
          disabled={!typable || draft.trim().length === 0}
          aria-label="Envoyer à ICOS"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </form>

      {state.pending && (
        <p
          className={styles.commandNotice}
          data-state={state.pending.phase.toUpperCase()}
          role="status"
          aria-live="polite"
        >
          <strong>{PHASE_TEXT[state.pending.phase]}</strong>
          {state.pending.detail && <span className={styles.muted}>{state.pending.detail}</span>}
          {canRetry(state) && (
            <>
              <button type="button" className={styles.commandRetry} onClick={() => void send(true)}>
                Vérifier à nouveau
              </button>
              <span className={styles.muted}>
                Le même envoi est renvoyé avec sa clé d&apos;origine : ICOS renvoie le tour
                enregistré au lieu de le réexécuter.
              </span>
            </>
          )}
        </p>
      )}

      {state.message && (
        <p className={styles.muted} role="status">
          {state.message}
        </p>
      )}

      {/* EMPTY is not "nothing exists": this screen only holds the exchanges made from
          this device, and `list()` already told us a durable conversation is there. */}
      {canConverse && state.link === "ready" && state.conversationId && shown.length === 0 && (
        <p className={styles.muted} role="status">
          Une conversation ICOS existe déjà. Cet écran n&apos;affiche que les échanges envoyés
          depuis cet appareil ; l&apos;historique complet est dans le cockpit.
        </p>
      )}

      {shown.length > 0 && (
        <p className={styles.muted}>
          Seuls les échanges envoyés depuis cet appareil sont affichés. ICOS conserve le contexte
          complet de la conversation et s&apos;en sert pour répondre ; l&apos;historique est dans le
          cockpit.
        </p>
      )}

      {shown.length > 0 && (
        <ol className={styles.commandTurns} aria-label="Échanges de cette session">
          {shown.map((t) => (
            <li key={t.id} className={styles.commandTurn} data-role={t.role}>
              <span className={styles.commandTurnMeta}>
                {t.role === "user" ? "Vous" : "ICOS"} · {t.status}
                {t.outcome ? ` · ${t.outcome}` : ""}
              </span>
              <p className={styles.commandTurnText}>{turnText(t)}</p>
              {t.failureReason && <span className={styles.muted}>Échec : {failureCode(t)}</span>}
            </li>
          ))}
        </ol>
      )}

      {state.proposals.map((p) => (
        <div key={p.id} className={styles.commandNotice} data-state={p.status.toUpperCase()}>
          <strong>
            {p.kind === "goal_proposal" ? "Proposition d'objectif" : "Demande d'action"} ·{" "}
            {p.status.replaceAll("_", " ")}
          </strong>
          <dl className={styles.proposalFacts}>
            {proposalRows(p).map((row) => (
              <div key={row.label} className={styles.proposalFact}>
                <dt>{row.label}</dt>
                <dd>{row.value ?? <span className={styles.muted}>non fourni</span>}</dd>
              </div>
            ))}
          </dl>
          {/*
            Canonical launch identity: what ICOS actually filed, by its real id.

            This text used to claim the launch "reste une étape opérateur" and that "une
            conversation ne lance jamais de workers". Both are false. Approving enqueues a
            `start_mission` job (`mission-gateway.ts`), whose handler calls
            `igniteAutonomousMission` -> `startAutonomousMission`: the runner plans and the
            supervisor DISPATCHES ready tasks through the durable dispatch ledger, with no
            further human step. The goal carries `humanApprovalPolicy: "always"`, but that
            is read by `GoalPlanner` for the stored PREVIEW only — it never reaches the
            autonomous runner, which receives `{id,title,objective,goalId}` and ignores
            goalId for gating. A consent surface must state what the tap actually commits
            to, so it now says so.
          */}
          {(p.goalId || p.missionId || p.externalId) && (
            <span className={styles.muted}>
              Déposée comme objectif <code>{p.goalId ?? p.externalId}</code>
              {p.missionId && (
                <>
                  {" "}
                  et mission <code>{p.missionId}</code>
                </>
              )}
              . <strong>La mission démarre d&apos;elle-même</strong> : ICOS planifie puis
              dispatche les tâches prêtes aux workers sans autre étape humaine. Suivez-la dans
              « Mission active ».
            </span>
          )}
          {p.status === "launching" && (
            <span className={styles.muted}>
              Lancement en cours côté ICOS. Tant qu&apos;il n&apos;est pas confirmé, rien
              n&apos;affirme que la mission a démarré — ni qu&apos;elle n&apos;a pas démarré.
            </span>
          )}
          {p.status === "failed" && p.failureReason && (
            <span className={styles.muted}>Échec : {p.failureReason}</span>
          )}
          {p.status === "not_connected" && (
            <span className={styles.muted}>
              Approuvée, mais les actions n&apos;ont pas encore de backend conversationnel (NON
              CONNECTÉ).
            </span>
          )}
          {/* Said BEFORE the tap, not only after it: approving is what starts the work. */}
          {PROPOSAL_AWAITING.includes(p.status) && p.kind === "goal_proposal" && (
            <span className={styles.muted}>
              Approuver crée la mission <strong>et la démarre</strong> : ICOS planifie et
              dispatche les tâches aux workers sans autre validation.
            </span>
          )}
          {PROPOSAL_AWAITING.includes(p.status) &&
            (canDecideProposals ? (
              <span className={styles.commandActions}>
                <button
                  type="button"
                  className={`${styles.approvalBtn} ${styles.approve}`}
                  onClick={() => void decide(p.id, "approve")}
                >
                  Approuver
                </button>
                <button
                  type="button"
                  className={`${styles.approvalBtn} ${styles.reject}`}
                  onClick={() => void decide(p.id, "reject")}
                >
                  Rejeter
                </button>
              </span>
            ) : (
              <span className={styles.muted}>
                Décision réservée au rôle habilité (missions.write).
              </span>
            ))}
        </div>
      ))}
    </div>
  );
}
