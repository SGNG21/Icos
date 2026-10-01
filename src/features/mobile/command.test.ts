import { describe, expect, it } from "vitest";

import { REF_STATUSES, type TurnReference } from "@/core/cognitive/contracts";
import {
  PROPOSAL_AWAITING,
  turnResultSchema,
  type AskProposal,
  type AskTurn,
  type Reply,
  type TurnResult,
} from "@/features/cockpit/ask";

import {
  bodyFits,
  canReplay,
  canRetry,
  canSend,
  canType,
  commandReducer,
  initialCommand,
  isBusy,
  keyFor,
  latestConversation,
  linkFor,
  needsProbe,
  openTurn,
  proposalRows,
  type CommandState,
} from "./command";

/**
 * These are the hazards of the phone's only conversational write path. Every one of them
 * is a way to create a duplicate durable turn or to show the owner a state that is not
 * true, so each has a test here rather than a comment claiming it cannot happen.
 */

const turn = (over: Partial<AskTurn> = {}): AskTurn =>
  ({
    id: "turn-1",
    conversationId: "c1",
    seq: 1,
    role: "user",
    content: { parts: [{ kind: "text", text: "Parle-moi de LDS" }] },
    status: "completed",
    outcome: "ANSWER_ONLY",
    replyToTurnId: null,
    failureReason: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    ...over,
  }) as AskTurn;

const result = (over: Partial<TurnResult> = {}): TurnResult => ({
  turn: turn(),
  reply: turn({ id: "turn-2", seq: 2, role: "assistant" }),
  proposal: null,
  replayed: false,
  ...over,
});

const ready = (over: Partial<CommandState> = {}): CommandState => ({
  ...initialCommand,
  link: "ready",
  conversationId: "c1",
  ...over,
});

describe("one submission at a time", () => {
  it("refuses a second send while one is on the wire", () => {
    const sending = commandReducer(ready(), {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    expect(sending.sending).toBe(true);
    expect(isBusy(sending)).toBe(true);
    expect(canSend(sending, "autre question")).toBe(false);
  });

  it("refuses a send while ICOS has not settled the previous turn", () => {
    const state = ready({ turns: [turn({ status: "processing" })] });
    expect(openTurn(state)?.status).toBe("processing");
    expect(canSend(state, "autre question")).toBe(false);
  });

  it("refuses an empty, blank or oversized question", () => {
    expect(canSend(ready(), "")).toBe(false);
    expect(canSend(ready(), "   ")).toBe(false);
    expect(canSend(ready(), "x".repeat(20_001))).toBe(false);
  });

  it("refuses to send at all while the runtime link is not ready", () => {
    for (const link of ["loading", "not_connected", "unavailable", "error"] as const) {
      expect(canSend({ ...ready(), link }, "Parle-moi de LDS")).toBe(false);
    }
    expect(canSend(ready(), "Parle-moi de LDS")).toBe(true);
  });
});

describe("idempotency key", () => {
  it("reuses the key of an UNKNOWN submission so a retry never duplicates the turn", () => {
    let state = commandReducer(ready(), {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, { type: "failed", phase: "unknown", detail: "HTTP 500" });
    // Whichever button sends it, the same unresolved question keeps its key.
    expect(keyFor(state, "Parle-moi de LDS", () => "FRESH")).toBe("k1");
    expect(keyFor(state, " Parle-moi de LDS ", () => "FRESH")).toBe("k1");
  });

  it("reuses the key even when the owner re-sends from the input instead of the retry", () => {
    let state = commandReducer(ready(), {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, { type: "failed", phase: "unknown" });
    // This is the H-2 path: the input still holds the text and the field is re-enabled.
    expect(keyFor(state, "Parle-moi de LDS", () => "FRESH")).toBe("k1");
  });

  it("gives a different question a fresh key", () => {
    let state = commandReducer(ready(), {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, { type: "failed", phase: "unknown" });
    expect(keyFor(state, "Et en priorité ?", () => "FRESH")).toBe("FRESH");
  });

  it("gives a fresh key once the previous submission is settled", () => {
    let state = commandReducer(ready(), {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, { type: "settled", result: result(), phase: "accepted" });
    expect(keyFor(state, "Parle-moi de LDS", () => "FRESH")).toBe("FRESH");
  });

  it("keeps the key of a still-processing submission", () => {
    let state = commandReducer(ready(), {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, {
      type: "settled",
      result: result({ turn: turn({ status: "processing" }), reply: null }),
      phase: "processing",
    });
    expect(keyFor(state, "Parle-moi de LDS", () => "FRESH")).toBe("k1");
  });
});

describe("retry is only offered when it can do something", () => {
  it("offers the retry for an UNKNOWN submission with nothing in flight", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    state = commandReducer(state, { type: "failed", phase: "unknown" });
    expect(canRetry(state)).toBe(true);
  });

  it("still offers the replay while the turn it asks about is open — it cannot duplicate it", () => {
    let state = commandReducer(ready({ turns: [turn({ status: "processing" })] }), {
      type: "sending",
      text: "q",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, { type: "failed", phase: "unknown" });
    // Withholding this is what deadlocks the screen: nothing else can settle the turn.
    expect(canRetry(state)).toBe(true);
    expect(canReplay(state)).toBe(true);
  });

  it("offers the replay for a submission ICOS reported as still processing", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    state = commandReducer(state, {
      type: "settled",
      result: result({ turn: turn({ status: "processing" }), reply: null }),
      phase: "processing",
    });
    expect(canRetry(state)).toBe(true);
  });

  it("withholds the replay while the request itself is on the wire", () => {
    const state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    expect(canReplay(state)).toBe(false);
  });

  it("withholds the replay when the runtime link is not ready", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    state = commandReducer(state, { type: "failed", phase: "unknown" });
    expect(canReplay({ ...state, link: "error" })).toBe(false);
  });

  it("withholds the retry for any settled phase", () => {
    for (const phase of ["accepted", "replayed", "failed", "cancelled", "rejected"] as const) {
      let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k" });
      state = commandReducer(state, { type: "failed", phase });
      expect(canRetry(state)).toBe(false);
    }
  });
});

describe("only stored turns are rendered", () => {
  it("renders the submitted turn and the stored reply, in seq order", () => {
    const state = commandReducer(ready(), {
      type: "settled",
      result: result(),
      phase: "accepted",
    });
    expect(state.turns.map((t) => t.id)).toEqual(["turn-1", "turn-2"]);
    expect(state.sending).toBe(false);
  });

  it("does not render a reply that does not exist", () => {
    const state = commandReducer(ready(), {
      type: "settled",
      result: result({ reply: null }),
      phase: "processing",
    });
    expect(state.turns.map((t) => t.id)).toEqual(["turn-1"]);
  });

  it("replaces a turn rather than duplicating it when the same id comes back", () => {
    let state = commandReducer(ready(), { type: "settled", result: result(), phase: "accepted" });
    state = commandReducer(state, {
      type: "settled",
      result: result({ turn: turn({ status: "failed" }) }),
      phase: "failed",
    });
    expect(state.turns.filter((t) => t.id === "turn-1")).toHaveLength(1);
    expect(state.turns.find((t) => t.id === "turn-1")?.status).toBe("failed");
  });

  it("replaces a proposal with the decided one returned by ICOS", () => {
    const proposal = { id: "ref-1", status: "awaiting_approval" } as AskProposal;
    let state = commandReducer(ready(), {
      type: "settled",
      result: result({ proposal }),
      phase: "accepted",
    });
    expect(state.proposals).toHaveLength(1);
    state = commandReducer(state, {
      type: "proposal",
      proposal: { ...proposal, status: "submitted" } as AskProposal,
    });
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0].status).toBe("submitted");
  });
});

describe("link honesty", () => {
  const failure = (over: Partial<Extract<Reply<unknown>, { kind: "error" }>> = {}) =>
    ({
      kind: "error",
      status: 500,
      code: "internal_error",
      message: "",
      typed: true,
      ...over,
    }) as Exclude<Reply<unknown>, { kind: "ok" }>;

  it("never leaves a settled hard failure looking like 'connecting'", () => {
    // This is the M-3 path: a typed 500 on arrival used to keep link === "loading".
    expect(linkFor(failure())).toBe("error");
    expect(linkFor(failure({ status: 401, code: "forbidden" }))).toBe("error");
    expect(linkFor(failure({ status: 429, code: "rate_limited" }))).toBe("error");
  });

  it("separates a missing deployment from a runtime that cannot serve", () => {
    expect(linkFor({ kind: "not_connected" })).toBe("not_connected");
    expect(linkFor(failure({ status: 503 }))).toBe("unavailable");
  });

  it("a non-ready link is never reported as ready by the reducer", () => {
    const state = commandReducer(ready(), { type: "link", link: "error", message: "boom" });
    expect(state.link).toBe("error");
    expect(state.message).toBe("boom");
  });
});

describe("conversation continuity", () => {
  it("continues the runtime's most recently updated conversation", () => {
    expect(
      latestConversation([
        { id: "old", updatedAt: "2026-09-29T10:00:00.000Z" },
        { id: "recent", updatedAt: "2026-09-30T09:00:00.000Z" },
      ])?.id,
    ).toBe("recent");
    expect(latestConversation([])).toBeUndefined();
  });

  it("keeps the conversation id across submissions so the second turn has the context", () => {
    let state = commandReducer(initialCommand, {
      type: "listed",
      engine: "claude",
      conversationId: "c1",
    });
    state = commandReducer(state, {
      type: "sending",
      text: "Parle-moi de LDS",
      idempotencyKey: "k1",
    });
    state = commandReducer(state, { type: "settled", result: result(), phase: "accepted" });
    state = commandReducer(state, {
      type: "sending",
      text: "Qu'est-ce qu'on doit améliorer en priorité ?",
      idempotencyKey: "k2",
    });
    expect(state.conversationId).toBe("c1");
  });

  it("remembers a conversation it had to create", () => {
    const state = commandReducer(ready({ conversationId: null }), {
      type: "conversation",
      id: "c-new",
    });
    expect(state.conversationId).toBe("c-new");
  });

  it("keeps the known conversation when a later listing returns none", () => {
    const state = commandReducer(ready(), {
      type: "listed",
      engine: "claude",
      conversationId: null,
    });
    expect(state.conversationId).toBe("c1");
  });
});

describe("what an approval commits to", () => {
  it("shows the canonical goal payload, not a summary alone", () => {
    const rows = proposalRows({
      id: "ref-1",
      kind: "goal_proposal",
      payload: {
        title: "Relancer INV-7",
        objective: "Récupérer la facture échue",
        riskLevel: "reversible",
        successCriteria: ["facture payée"],
        constraints: ["pas de mise en demeure"],
      },
    } as unknown as AskProposal);
    expect(rows.map((r) => r.label)).toEqual([
      "Objectif",
      "Détail",
      "Risque",
      "Critères de succès",
      "Contraintes",
    ]);
    expect(rows.find((r) => r.label === "Risque")?.value).toBe("reversible");
  });

  it("shows the action payload for an action request", () => {
    const rows = proposalRows({
      id: "ref-2",
      kind: "action_request",
      payload: {
        kind: "repository.push",
        description: "pousser la branche",
        riskLevel: "sensitive",
      },
    } as unknown as AskProposal);
    expect(rows.map((r) => r.value)).toEqual([
      "repository.push",
      "pousser la branche",
      "sensitive",
    ]);
  });

  it("reports a field the model did not provide as absent, never as empty text", () => {
    const rows = proposalRows({
      id: "ref-3",
      kind: "goal_proposal",
      payload: { title: 42, successCriteria: "not-an-array" },
    } as unknown as AskProposal);
    expect(rows.find((r) => r.label === "Objectif")?.value).toBeNull();
    expect(rows.find((r) => r.label === "Critères de succès")?.value).toBeNull();
  });
});

/**
 * The wire contract, asserted against the runtime's OWN type rather than a hand-written
 * literal. The previous schema required an `externalId` the runtime has never had and a
 * status vocabulary it never emits, so every real proposal failed to parse: an approval
 * the server had already committed — goal filed through canonical intake — was reported
 * to the owner as "Décision refusée". A fabricated fixture cannot catch that; this does.
 */
describe("proposal wire contract", () => {
  const reference: TurnReference = {
    id: "ref-1",
    conversationId: "c1",
    turnId: "turn-1",
    kind: "goal_proposal",
    status: "approval_required",
    payload: {
      title: "Relancer INV-7",
      objective: "Récupérer la facture échue",
      successCriteria: [],
      constraints: [],
      riskLevel: "reversible",
    },
    policyReason: "sensitive goal requires a human decision",
    decidedBy: null,
    decidedAt: null,
    goalId: null,
    missionId: null,
    launchJobId: null,
    failureReason: null,
    createdAt: "2026-09-30T10:00:00.000Z",
  };

  it("parses a canonical TurnReference exactly as the runtime serializes it", () => {
    const parsed = turnResultSchema.safeParse({
      turn: turn(),
      reply: null,
      proposal: reference,
      replayed: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("parses every status the runtime can emit", () => {
    for (const status of REF_STATUSES) {
      const parsed = turnResultSchema.safeParse({
        turn: turn(),
        reply: null,
        proposal: { ...reference, status },
        replayed: false,
      });
      expect(parsed.success, `status ${status} must parse`).toBe(true);
    }
  });

  it("treats the canonical approval state as awaiting a human decision", () => {
    expect(PROPOSAL_AWAITING).toContain("approval_required");
    // A proposal the runtime has not gated must never show decision buttons.
    for (const status of ["proposed", "approved", "launching", "launched", "rejected"] as const) {
      expect(PROPOSAL_AWAITING).not.toContain(status);
    }
  });

  it("renders the canonical payload of a real reference, not a summary", () => {
    const rows = proposalRows(reference as unknown as AskProposal);
    expect(rows.find((r) => r.label === "Objectif")?.value).toBe("Relancer INV-7");
    expect(rows.find((r) => r.label === "Risque")?.value).toBe("reversible");
  });
});

/**
 * The screen must always be able to get out of an unresolved submission. Before
 * `canReplay` existed, a turn ICOS reported as `processing` locked the command bar for
 * good: `canSend` blocked the only dispatch that could ever settle it, and the only
 * escape — a reload — dropped the idempotency key and so re-created the turn.
 */
describe("the command bar can always recover", () => {
  it("unlocks once a replay brings back the settled turn", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    state = commandReducer(state, {
      type: "settled",
      result: result({ turn: turn({ status: "processing" }), reply: null }),
      phase: "processing",
    });
    expect(isBusy(state)).toBe(true);
    expect(canReplay(state)).toBe(true);

    // The replay returns the same turn, now terminal, under the same id.
    state = commandReducer(state, {
      type: "settled",
      result: result({ turn: turn({ status: "completed" }), replayed: true }),
      phase: "replayed",
    });
    expect(isBusy(state)).toBe(false);
    expect(canSend(state, "question suivante")).toBe(true);
    // And no duplicate turn was left behind.
    expect(state.turns.filter((t) => t.role === "user")).toHaveLength(1);
  });

  it("settles a submission that a lost link left in flight", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    expect(state.sending).toBe(true);
    state = commandReducer(state, { type: "link", link: "not_connected" });
    // "ICOS traite ce tour" must not survive next to "rien n'a été envoyé".
    expect(state.sending).toBe(false);
    expect(state.pending?.phase).toBe("rejected");
    expect(isBusy(state)).toBe(false);
  });

  it("leaves a settled submission alone when the link drops afterwards", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    state = commandReducer(state, { type: "settled", result: result(), phase: "accepted" });
    state = commandReducer(state, { type: "link", link: "error" });
    expect(state.pending?.phase).toBe("accepted");
  });

  it("does not clear an in-flight submission when the link is merely re-confirmed ready", () => {
    let state = commandReducer(ready(), { type: "sending", text: "q", idempotencyKey: "k1" });
    state = commandReducer(state, { type: "link", link: "ready" });
    expect(state.sending).toBe(true);
    expect(state.pending?.phase).toBe("submitting");
  });
});

/**
 * Arrival must cost the Cognitive Runtime nothing. Entering its HTTP surface composes the
 * runtime, and composing it relaunches the tenant's interrupted goal launches at most once
 * a minute (`cognitiveRuntimeFor` -> `recoverLaunches` -> `launch`, which enqueues a
 * `start_mission` job). The Mobile Home is the ROOT page, so a probe on mount would turn
 * every page view into a potential write. The link therefore starts `idle` and is probed
 * only by the owner's first gesture.
 */
describe("arrival is inert", () => {
  it("starts idle, not loading: no claim about a runtime nobody asked", () => {
    expect(initialCommand.link).toBe("idle");
    expect(needsProbe(initialCommand)).toBe(true);
  });

  it("lets the owner type while idle — the field is what triggers the probe", () => {
    // A disabled field could never be focused, so the link would stay unknowable forever.
    expect(canType(initialCommand)).toBe(true);
  });

  it("still refuses to SEND while the link is unprobed", () => {
    expect(canSend(initialCommand, "démarre la mission")).toBe(false);
    // ...even though the body itself is perfectly valid.
    expect(bodyFits("démarre la mission")).toBe(true);
  });

  it("probes once: a settled failure is never re-dressed as 'connecting'", () => {
    const failed = commandReducer(initialCommand, { type: "link", link: "not_connected" });
    expect(needsProbe(failed)).toBe(false);
    // A later `probing` must not walk it back to loading.
    expect(commandReducer(failed, { type: "probing" }).link).toBe("not_connected");
  });

  it("moves idle -> loading only on an explicit probe", () => {
    expect(commandReducer(initialCommand, { type: "probing" }).link).toBe("loading");
  });

  it("is not typable once the link is known to be dead", () => {
    const dead = commandReducer(initialCommand, { type: "link", link: "unavailable" });
    expect(canType(dead)).toBe(false);
  });
});
