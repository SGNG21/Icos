import { describe, expect, it } from "vitest";

import {
  goalProposalSchema,
  type GoalProposal,
  type InitiativePolicy,
  type SupervisorEventInput,
} from "@/core/proactive/contracts";
import { DEFAULT_INITIATIVE_POLICY, DEFAULT_RELEVANCE_RULES } from "@/core/proactive/defaults";

import { ProactiveSupervisor, type SubjectStatusPort } from "./proactive-supervisor";
import type { SupervisorStore } from "./store";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

export const ev = (overrides: Partial<SupervisorEventInput> = {}): SupervisorEventInput => ({
  tenantId: "tenant-a",
  source: "fixture",
  origin: "push",
  type: "SITE_HEALTH_FAILURE",
  subject: "site:example.test/contact",
  occurredAt: new Date(),
  dedupKey: `obs-${++seq}-${Math.random()}`,
  ...overrides,
});

const withRules = (
  rules: InitiativePolicy["rules"],
  extra: Partial<InitiativePolicy> = {},
): InitiativePolicy => ({
  ...DEFAULT_INITIATIVE_POLICY,
  ...extra,
  rules: [
    ...rules,
    ...DEFAULT_INITIATIVE_POLICY.rules.filter((r) => !rules.some((o) => o.domain === r.domain)),
  ],
});

export function harness(
  store: SupervisorStore,
  options: {
    policy?: InitiativePolicy;
    subjects?: SubjectStatusPort;
    toolGateway?: boolean;
    rules?: typeof DEFAULT_RELEVANCE_RULES;
    /** Makes goal submission throw for matching proposals (a broken intake). */
    failSubmit?: (p: GoalProposal) => boolean;
  } = {},
) {
  const submitted: GoalProposal[] = [];
  const toolRequests: string[] = [];
  const delivered: string[] = [];
  const episodes: string[] = [];
  const supervisor = new ProactiveSupervisor({
    store,
    rules: options.rules ?? DEFAULT_RELEVANCE_RULES,
    policy: options.policy ?? DEFAULT_INITIATIVE_POLICY,
    goalIntake: {
      submit: async (p) => {
        if (options.failSubmit?.(p)) throw new Error("intake down");
        submitted.push(p);
        return { status: "SUBMITTED", ref: `goal-${p.id}` };
      },
    },
    toolGateway: options.toolGateway
      ? {
          requestAction: async (r) => {
            toolRequests.push(r.requestId);
            return { status: "ACCEPTED", ref: `tool-${r.requestId}` };
          },
        }
      : undefined,
    attention: {
      deliver: async (a) => {
        delivered.push(a.attentionClass);
        return { status: "ACCEPTED" };
      },
    },
    episodes: {
      publish: async (e) => {
        episodes.push(e.kind);
        return { status: "ACCEPTED" };
      },
    },
    subjects: options.subjects,
  });
  return { supervisor, submitted, toolRequests, delivered, episodes };
}

const hourAgo = () => new Date(Date.now() - 3_600_000);
const soon = () => new Date(Date.now() + 3_600_000);

/**
 * The 14 safety proofs of decision 0060 + business examples A–E, run against the
 * in-memory store AND real PostgreSQL. `make` returns an EMPTY store.
 */
export function describeProactiveSupervisorContract(
  name: string,
  make: () => Promise<SupervisorStore>,
): void {
  describe(`Proactive Supervisor safety proofs — ${name}`, () => {
    it("P1 a duplicate event creates no duplicate situation, proposal or goal (sequential and concurrent)", async () => {
      const store = await make();
      const policy = withRules([{ domain: "web.operations", level: "EXECUTE_BOUNDED" }]);
      const h = harness(store, { policy });
      const event = ev({ dedupKey: "same-observation" });
      const first = await h.supervisor.ingest(event);
      const replays = await Promise.all(
        Array.from({ length: 10 }, () => h.supervisor.ingest(event)),
      );
      expect(first.status).toBe("RECORDED");
      expect(replays.every((r) => r.status === "DUPLICATE" && r.eventId === first.eventId)).toBe(
        true,
      );
      await h.supervisor.drain();
      expect(h.submitted).toHaveLength(1);
      const digest = await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() });
      expect(digest.eventCount).toBe(1);
      expect(digest.situations).toHaveLength(1);

      // Concurrent FIRST delivery of one observation: still exactly one.
      const racing = ev({ dedupKey: "racing", subject: "site:other.test" });
      const results = await Promise.all(
        Array.from({ length: 8 }, () => h.supervisor.ingest(racing)),
      );
      expect(results.filter((r) => r.status === "RECORDED")).toHaveLength(1);
    });

    it("P2 a replay through a NEW supervisor instance (restart) is still a duplicate", async () => {
      const store = await make();
      const event = ev({ dedupKey: "before-restart" });
      await harness(store).supervisor.ingest(event);
      const restarted = harness(store);
      expect((await restarted.supervisor.ingest(event)).status).toBe("DUPLICATE");
    });

    it("P3 an ignored event has no side effect: no situation, attention, proposal or port call", async () => {
      const store = await make();
      const h = harness(store, { toolGateway: true });
      const r = await h.supervisor.ingest(ev({ type: "SOMETHING_NOBODY_CARES_ABOUT" }));
      expect(r).toMatchObject({
        status: "RECORDED",
        disposition: "IGNORE",
        situationId: null,
        proposalId: null,
        attention: null,
      });
      await h.supervisor.drain();
      expect(
        [h.submitted, h.toolRequests, h.delivered, h.episodes].every((a) => a.length === 0),
      ).toBe(true);
      const digest = await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() });
      expect(digest).toMatchObject({ situations: [], eventCount: 1, ignoredCount: 1 });
    });

    it("P4 PROPOSE never auto-executes: the proposal waits for a human, drain sends nothing", async () => {
      const store = await make();
      const h = harness(store, { toolGateway: true });
      const r = await h.supervisor.ingest(ev()); // web.operations defaults to PROPOSE
      expect(r).toMatchObject({ disposition: "PROPOSE_ACTION" });
      await h.supervisor.drain();
      expect(h.submitted).toHaveLength(0);
      expect(h.toolRequests).toHaveLength(0);
      const [s] = (await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() }))
        .situations;
      expect(s.proposal).toMatchObject({ state: "awaiting_human" });
      expect(h.delivered).toEqual(["URGENT"]); // a human decision is pending
    });

    it("P5 low-risk execution stays bounded by risk ceiling and hourly budget", async () => {
      const store = await make();
      const policy = withRules([
        { domain: "marketing.seo", level: "EXECUTE_LOW_RISK", maxExecutionsPerHour: 2 },
        { domain: "web.operations", level: "EXECUTE_LOW_RISK" },
      ]);
      const h = harness(store, { policy });
      const seo = (subject: string) => ev({ type: "SEO_CHANGE", subject });
      expect(await h.supervisor.ingest(seo("page:/a"))).toMatchObject({
        disposition: "CREATE_BOUNDED_GOAL",
      });
      expect(await h.supervisor.ingest(seo("page:/b"))).toMatchObject({
        disposition: "CREATE_BOUNDED_GOAL",
      });
      const third = await h.supervisor.ingest(seo("page:/c"));
      expect(third).toMatchObject({ disposition: "PROPOSE_ACTION" });
      expect((third as { reasons: string[] }).reasons).toContain("EXECUTION_BUDGET_EXHAUSTED");
      // A reversible action exceeds EXECUTE_LOW_RISK (read-only ceiling).
      const reversible = await h.supervisor.ingest(ev());
      expect(reversible).toMatchObject({ disposition: "PROPOSE_ACTION" });
      expect((reversible as { reasons: string[] }).reasons).toContain("RISK_EXCEEDS_LEVEL");
      await h.supervisor.drain();
      expect(h.submitted.map((p) => p.action)).toEqual([
        "analyse_seo_change",
        "analyse_seo_change",
      ]);
    });

    it("P6 a human-required domain cannot self-authorize, even with a rule granting execution", async () => {
      const store = await make();
      const policy = withRules([
        { domain: "security", level: "EXECUTE_BOUNDED" },
        {
          domain: "security",
          action: "investigate_security_alert",
          clientScope: "client-x",
          level: "EXECUTE_BOUNDED",
        },
      ]);
      const h = harness(store, { policy });
      const r = await h.supervisor.ingest(
        ev({ type: "SECURITY_ALERT", subject: "host:db-1", clientScope: "client-x" }),
      );
      expect(r).toMatchObject({ disposition: "ESCALATE_HUMAN", attention: "CRITICAL" });
      await h.supervisor.drain();
      expect(h.submitted).toHaveLength(0);
      // A sensitive action outside a human-required domain also escalates.
      const sensitive = harness(await make(), {
        policy: withRules([{ domain: "web.operations", level: "EXECUTE_BOUNDED" }]),
        rules: [
          {
            ...DEFAULT_RELEVANCE_RULES.find((x) => x.eventType === "SITE_HEALTH_FAILURE")!,
            action: {
              ...DEFAULT_RELEVANCE_RULES.find((x) => x.eventType === "SITE_HEALTH_FAILURE")!
                .action!,
              risk: "sensitive",
            },
          },
        ],
      });
      expect(await sensitive.supervisor.ingest(ev())).toMatchObject({
        disposition: "ESCALATE_HUMAN",
      });
    });

    it("P7 events of different clients and tenants are isolated", async () => {
      const store = await make();
      const h = harness(store);
      const a = await h.supervisor.ingest(ev({ clientScope: "client-a" }));
      const b = await h.supervisor.ingest(ev({ clientScope: "client-b" }));
      const other = await h.supervisor.ingest(
        ev({ tenantId: "tenant-b", clientScope: "client-a" }),
      );
      expect(new Set([a.situationId, b.situationId, other.situationId]).size).toBe(3);
      const onlyA = await h.supervisor.digest("tenant-a", {
        since: hourAgo(),
        until: soon(),
        clientScope: "client-a",
      });
      expect(onlyA.situations.map((s) => s.id)).toEqual([a.situationId]);
      expect(onlyA.eventCount).toBe(1);
      expect(await store.getSituation("tenant-b", a.situationId!)).toBeNull();
      expect(
        await h.supervisor.closeSituation("tenant-b", a.situationId!, {
          state: "resolved",
          by: "x",
          resolution: "x",
        }),
      ).toBe(false);
    });

    it("P8 repeated checks aggregate into one incident; attention rises only when it gets worse", async () => {
      const store = await make();
      const h = harness(store);
      const results = [];
      for (let i = 0; i < 10; i++) results.push(await h.supervisor.ingest(ev()));
      const ids = new Set(results.map((r) => r.situationId));
      expect(ids.size).toBe(1);
      const situation = await store.getSituation("tenant-a", results[0].situationId!);
      expect(situation).toMatchObject({
        eventCount: 10,
        severity: "critical",
        maxAttention: "CRITICAL",
      });
      expect(h.delivered).toEqual(["URGENT", "CRITICAL"]); // escalated once, at the 5th check
      expect(
        results.filter((r) => r.status === "RECORDED" && r.disposition === "RECORD_ONLY"),
      ).toHaveLength(8);

      // A later, QUIETER assessment of the same situation interrupts nobody.
      const seo = harness(await make());
      const loud = await seo.supervisor.ingest(ev({ type: "SEO_CHANGE", subject: "page:/p" })); // PROPOSE ⇒ ACTIONABLE
      const quiet = await seo.supervisor.ingest(
        ev({ type: "SEO_CHANGE", subject: "page:/p", confidence: 0.2 }),
      ); // NOTIFY low ⇒ INFO
      expect(loud).toMatchObject({ attention: "ACTIONABLE" });
      expect(quiet).toMatchObject({ attention: null, disposition: "RECORD_ONLY" });
      expect(seo.delivered).toEqual(["ACTIONABLE"]);
    });

    it("P9 an event flood is deduplicated and rate-limited", async () => {
      const store = await make();
      const h = harness(store, {
        policy: { ...DEFAULT_INITIATIVE_POLICY, maxNewSituationsPerHour: 5 },
      });
      await Promise.all(
        Array.from({ length: 100 }, () => h.supervisor.ingest(ev({ subject: "site:flooded" }))),
      );
      const distinct = [];
      for (let i = 0; i < 12; i++)
        distinct.push(await h.supervisor.ingest(ev({ subject: `site:s${i}` })));
      const digest = await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() });
      expect(digest.eventCount).toBe(112);
      expect(digest.situations).toHaveLength(5); // 1 flooded + 4 distinct, then the cap
      expect(digest.situations.find((s) => s.subject === "site:flooded")?.eventCount).toBe(100);
      expect(
        distinct
          .slice(4)
          .every((r) => r.status === "RECORDED" && r.reasons.includes("FLOOD_LIMIT")),
      ).toBe(true);
      expect(digest.situations.filter((s) => s.proposal).length).toBe(5);
    });

    it("P10 a terminal situation or subject is never reopened", async () => {
      const store = await make();
      const rules = DEFAULT_RELEVANCE_RULES.map((r) =>
        r.eventType === "SITE_HEALTH_FAILURE" ? { ...r, reopenCooldownMs: 150 } : r,
      );
      const h = harness(store, {
        rules,
        subjects: { isTerminal: async (subject) => subject === "mission:done" },
      });
      const first = await h.supervisor.ingest(ev());
      expect(
        await h.supervisor.closeSituation("tenant-a", first.situationId!, {
          state: "resolved",
          by: "human:owner",
          resolution: "fixed",
        }),
      ).toBe(true);
      expect(
        await h.supervisor.closeSituation("tenant-a", first.situationId!, {
          state: "dismissed",
          by: "x",
          resolution: "again",
        }),
      ).toBe(false);
      const late = await h.supervisor.ingest(ev());
      expect(late).toMatchObject({ disposition: "RECORD_ONLY", situationId: null });
      expect((late as { reasons: string[] }).reasons).toContain("TERMINAL_COOLDOWN");
      expect(await store.getSituation("tenant-a", first.situationId!)).toMatchObject({
        state: "resolved",
      });
      await sleep(200);
      const recurrence = await h.supervisor.ingest(ev());
      expect(recurrence.situationId).not.toBe(first.situationId); // a NEW incident, the old one stays closed
      expect(h.episodes).toContain("situation_closed");

      const blocked = await h.supervisor.ingest(
        ev({ type: "MISSION_BLOCKED", subject: "mission:done" }),
      );
      expect(blocked).toMatchObject({ disposition: "RECORD_ONLY", situationId: null });
      expect((blocked as { reasons: string[] }).reasons).toEqual(["SUBJECT_TERMINAL"]);
    });

    it("P11 an UNKNOWN policy fails closed", async () => {
      const store = await make();
      const h = harness(store, {
        policy: { ...DEFAULT_INITIATIVE_POLICY, rules: [] },
        toolGateway: true,
      });
      const r = await h.supervisor.ingest(
        ev({ type: "INVOICE_OVERDUE", subject: "invoice:INV-1" }),
      );
      expect(r).toMatchObject({ disposition: "RECORD_ONLY", proposalId: null, attention: null });
      expect((r as { reasons: string[] }).reasons).toContain("POLICY_UNKNOWN");
      await h.supervisor.drain();
      expect([h.submitted, h.toolRequests, h.delivered].every((a) => a.length === 0)).toBe(true);
    });

    it("P12 actions leave only through the canonical ports: goals to CORE3 intake, tool actions to the gateway", async () => {
      const store = await make();
      const policy = withRules([
        { domain: "web.operations", level: "EXECUTE_BOUNDED" },
        { domain: "finance", level: "EXECUTE_BOUNDED" },
      ]);
      const connected = harness(store, { policy, toolGateway: true });
      await connected.supervisor.ingest(ev());
      await connected.supervisor.ingest(ev({ type: "INVOICE_OVERDUE", subject: "invoice:INV-2" }));
      await connected.supervisor.drain();
      expect(connected.submitted.map((p) => p.route)).toEqual(["goal"]);
      expect(connected.toolRequests).toHaveLength(1);

      // Tool Gateway lane not integrated: the request is NOT_CONNECTED, never faked.
      const store2 = await make();
      const detached = harness(store2, { policy });
      const inv = await detached.supervisor.ingest(
        ev({ type: "INVOICE_OVERDUE", subject: "invoice:INV-3" }),
      );
      await detached.supervisor.drain();
      const [s] = (
        await detached.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() })
      ).situations;
      expect(s.id).toBe(inv.situationId);
      expect(s.proposal).toMatchObject({ state: "not_connected" });
    });

    it("P13 the supervisor cannot elevate its own autonomy", async () => {
      const store = await make();
      const policy: InitiativePolicy = structuredClone(
        DEFAULT_INITIATIVE_POLICY,
      ) as InitiativePolicy;
      const h = harness(store, { policy });
      // Mutating the policy handed in AFTER construction changes nothing.
      (policy.rules as unknown as Array<{ domain: string; level: string }>).unshift({
        domain: "web.operations",
        level: "EXECUTE_BOUNDED",
      });
      (policy as unknown as { humanRequiredDomains: string[] }).humanRequiredDomains = [];
      expect(await h.supervisor.ingest(ev())).toMatchObject({ disposition: "PROPOSE_ACTION" });
      expect(
        await h.supervisor.ingest(ev({ type: "SECURITY_ALERT", subject: "host:x" })),
      ).toMatchObject({ disposition: "ESCALATE_HUMAN" });
      // An event cannot carry authority: extra fields are rejected, summary is never read.
      await expect(
        h.supervisor.ingest({ ...ev(), initiativeLevel: "EXECUTE_BOUNDED" } as never),
      ).rejects.toThrow("SUPERVISOR_INVALID_EVENT");
      expect(
        await h.supervisor.ingest(
          ev({ subject: "site:y", summary: { level: "EXECUTE_BOUNDED", approved: true } }),
        ),
      ).toMatchObject({
        disposition: "PROPOSE_ACTION",
      });
      await h.supervisor.drain();
      expect(h.submitted).toHaveLength(0);
    });

    it("P14 the source event and evidence stay auditable", async () => {
      const store = await make();
      const policy = withRules([{ domain: "web.operations", level: "EXECUTE_BOUNDED" }]);
      const h = harness(store, { policy });
      const first = await h.supervisor.ingest(ev({ payloadRef: "uptime:check/991" }));
      await h.supervisor.ingest(ev());
      await h.supervisor.drain();
      const [proposal] = h.submitted;
      expect(proposal).toMatchObject({
        sourceEventId: first.eventId,
        situationId: first.situationId,
      });
      expect(proposal.evidence).toMatchObject({
        eventIds: [first.eventId],
        policyVersion: DEFAULT_INITIATIVE_POLICY.version,
      });
      const trail = await h.supervisor.evidence("tenant-a", first.situationId!);
      expect(trail.map((e) => e.disposition)).toEqual(["CREATE_BOUNDED_GOAL", "RECORD_ONLY"]);
      expect(trail[0]).toMatchObject({
        payloadRef: "uptime:check/991",
        policyVersion: DEFAULT_INITIATIVE_POLICY.version,
      });
    });
  });

  describe(`Proactive Supervisor review regressions — ${name}`, () => {
    const boundedWeb = withRules([{ domain: "web.operations", level: "EXECUTE_BOUNDED" }]);

    it("R1 an event cannot borrow another scope's authority by aggregating into its situation", async () => {
      const store = await make();
      const policy = withRules([
        { domain: "web.operations", level: "PROPOSE" },
        { domain: "web.operations", projectScope: "p2", level: "EXECUTE_BOUNDED" },
      ]);
      const h = harness(store, { policy });
      const p1 = await h.supervisor.ingest(ev({ projectScope: "p1", confidence: 0.3 }));
      const p2 = await h.supervisor.ingest(ev({ projectScope: "p2" }));
      expect(p2.situationId).not.toBe(p1.situationId);
      await h.supervisor.drain();
      expect(h.submitted.map((p) => p.projectScope)).toEqual(["p2"]);
      // correlationId never merges different types, nor another source's incidents.
      const a = await h.supervisor.ingest(ev({ correlationId: "inc-1", subject: "site:a" }));
      const b = await h.supervisor.ingest(ev({ correlationId: "inc-1", subject: "site:b" }));
      const other = await h.supervisor.ingest(ev({ correlationId: "inc-1", source: "evil" }));
      const otherType = await h.supervisor.ingest(ev({ correlationId: "inc-1", type: "NEW_LEAD" }));
      expect(b.situationId).toBe(a.situationId);
      expect(new Set([a.situationId, other.situationId, otherType.situationId]).size).toBe(3);
      // "-" is a client scope, not the absence of one.
      const dash = await h.supervisor.ingest(ev({ clientScope: "-", subject: "site:z" }));
      const none = await h.supervisor.ingest(ev({ subject: "site:z" }));
      expect(dash.situationId).not.toBe(none.situationId);
    });

    it("R2 routine noise in one domain cannot flood-suppress another, nor a human-required alert", async () => {
      const store = await make();
      const h = harness(store, {
        policy: { ...DEFAULT_INITIATIVE_POLICY, maxNewSituationsPerHour: 3 },
      });
      for (let i = 0; i < 6; i++)
        await h.supervisor.ingest(ev({ type: "EMAIL_RECEIVED", subject: `mail:${i}` }));
      expect(await h.supervisor.ingest(ev({ subject: "site:after-emails" }))).toMatchObject({
        disposition: "PROPOSE_ACTION",
      });
      for (let i = 0; i < 6; i++) await h.supervisor.ingest(ev({ subject: `site:n${i}` }));
      expect(
        await h.supervisor.ingest(ev({ type: "SECURITY_ALERT", subject: "host:1" })),
      ).toMatchObject({
        disposition: "ESCALATE_HUMAN",
      });
      // Nor can a flood of the human-required domain itself silence its own alerts.
      const alerts = [];
      for (let i = 0; i < 6; i++)
        alerts.push(
          await h.supervisor.ingest(ev({ type: "SECURITY_ALERT", subject: `host:f${i}` })),
        );
      expect(
        alerts.every((r) => r.status === "RECORDED" && r.disposition === "ESCALATE_HUMAN"),
      ).toBe(true);
    });

    it("R3 a persistently failing delivery neither blocks the others nor retries forever", async () => {
      const store = await make();
      const h = harness(store, {
        policy: boundedWeb,
        failSubmit: (p) => p.reason.includes("site:broken"),
      });
      await h.supervisor.ingest(ev({ subject: "site:broken" }));
      await h.supervisor.ingest(ev({ subject: "site:fine" }));
      for (let i = 0; i < 6; i++) await h.supervisor.drain();
      expect(h.submitted.map((p) => p.reason)).toEqual([expect.stringContaining("site:fine")]);
      const digest = await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() });
      expect(digest.situations.find((s) => s.subject === "site:broken")?.proposal).toMatchObject({
        state: "failed",
        attempts: 5,
        lastError: "intake down",
      });
    });

    it("R4 a situation quiet past its window closes as stale; the next occurrence is a new incident", async () => {
      const store = await make();
      const rules = DEFAULT_RELEVANCE_RULES.map((r) =>
        r.eventType === "SITE_HEALTH_FAILURE" ? { ...r, staleAfterMs: 100 } : r,
      );
      const h = harness(store, { rules });
      const first = await h.supervisor.ingest(ev());
      await sleep(200);
      const again = await h.supervisor.ingest(ev());
      expect(again.situationId).not.toBe(first.situationId);
      expect(again).toMatchObject({ attention: "URGENT" }); // a real re-notification
      expect(await store.getSituation("tenant-a", first.situationId!)).toMatchObject({
        state: "dismissed",
        closedBy: "supervisor:stale",
      });
    });

    it("R5 closing a situation cancels its undelivered goal: nothing fires after a dismissal", async () => {
      const store = await make();
      let down = true;
      const h = harness(store, { policy: boundedWeb, failSubmit: () => down });
      const r = await h.supervisor.ingest(ev());
      expect(
        await h.supervisor.closeSituation("tenant-a", r.situationId!, {
          state: "dismissed",
          by: "human:owner",
          resolution: "not needed",
        }),
      ).toBe(true);
      down = false;
      await h.supervisor.drain();
      expect(h.submitted).toHaveLength(0);
      const [s] = (await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() }))
        .situations;
      expect(s.proposal).toMatchObject({ state: "cancelled" });
    });

    it("R6 concurrent drains deliver each row once", async () => {
      const store = await make();
      const h = harness(store, {
        policy: withRules([
          { domain: "web.operations", level: "EXECUTE_BOUNDED", maxExecutionsPerHour: 10 },
        ]),
        failSubmit: () => true,
      });
      for (let i = 0; i < 4; i++) await h.supervisor.ingest(ev({ subject: `site:c${i}` }));
      const ok = harness(store, { policy: boundedWeb });
      // first attempts failed and went back to pending; now race four drains
      await Promise.all(Array.from({ length: 4 }, () => ok.supervisor.drain()));
      expect(ok.submitted).toHaveLength(4);
      expect(new Set(ok.submitted.map((p) => p.id)).size).toBe(4);
    });

    it("R8 a low-confidence human-required alert is escalated without paging", async () => {
      const h = harness(await make());
      expect(
        await h.supervisor.ingest(
          ev({ type: "SECURITY_ALERT", subject: "host:2", confidence: 0.1 }),
        ),
      ).toMatchObject({
        disposition: "ESCALATE_HUMAN",
        attention: "ACTIONABLE",
      });
    });
  });

  describe(`Proactive Supervisor business examples — ${name}`, () => {
    it("A invoice overdue → propose a reminder (default); bounded policy → governed tool action", async () => {
      const h = harness(await make());
      const r = await h.supervisor.ingest(
        ev({ type: "INVOICE_OVERDUE", subject: "invoice:INV-9", clientScope: "client-a" }),
      );
      expect(r).toMatchObject({ disposition: "PROPOSE_ACTION", attention: "ACTIONABLE" });
      const [s] = (await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() }))
        .situations;
      expect(s.proposal?.proposal).toMatchObject({
        action: "payment_reminder",
        route: "tool_action",
        clientScope: "client-a",
      });
    });

    it("B website form failure → one incident → bounded dev goal via CORE3 when policy allows", async () => {
      const h = harness(await make(), {
        policy: withRules([{ domain: "web.operations", level: "EXECUTE_BOUNDED" }]),
      });
      for (let i = 0; i < 3; i++) await h.supervisor.ingest(ev({ subject: "site:shop.test/form" }));
      await h.supervisor.drain();
      expect(h.submitted).toHaveLength(1);
      expect(h.submitted[0]).toMatchObject({
        route: "goal",
        risk: "reversible",
        requestedCapabilities: ["web.development", "web.testing"],
      });
    });

    it("C provider rate-limited → compute-health situation, remediation left to compute routing", async () => {
      const h = harness(await make(), {
        policy: withRules([{ domain: "compute", level: "EXECUTE_BOUNDED" }]),
      });
      const r = await h.supervisor.ingest(
        ev({
          source: "icos.dispatch",
          origin: "internal",
          type: "PROVIDER_RATE_LIMIT",
          subject: "worker:nvidia-nemotron",
        }),
      );
      expect(r).toMatchObject({ disposition: "NOTIFY", proposalId: null, attention: "INFO" });
      expect((r as { reasons: string[] }).reasons).toContain("OWNED_BY:compute-routing");
    });

    it("D lead replies → sales opportunity requesting capabilities, never an agent or model", async () => {
      const h = harness(await make());
      const r = await h.supervisor.ingest(
        ev({ type: "CRM_REPLY", subject: "lead:L-4", clientScope: "client-a" }),
      );
      expect(r).toMatchObject({ disposition: "PROPOSE_ACTION" });
      const [s] = (await h.supervisor.digest("tenant-a", { since: hourAgo(), until: soon() }))
        .situations;
      expect(s).toMatchObject({ kind: "opportunity" });
      expect(s.proposal?.proposal.requestedCapabilities).toEqual(["sales.follow_up"]);
      expect(() =>
        goalProposalSchema.parse({ ...s.proposal!.proposal, agentId: "agent-x" }),
      ).toThrow();
      expect(() =>
        goalProposalSchema.parse({ ...s.proposal!.proposal, model: "nvidia/x" }),
      ).toThrow();
    });

    it("E mission stuck → recovery-owned escalation event; once finished it is not reopened", async () => {
      let finished = false;
      const h = harness(await make(), { subjects: { isTerminal: async () => finished } });
      const r = await h.supervisor.ingest(
        ev({
          source: "icos.runtime",
          origin: "internal",
          type: "MISSION_BLOCKED",
          subject: "mission:m-1",
        }),
      );
      expect(r).toMatchObject({ disposition: "NOTIFY", attention: "URGENT", proposalId: null });
      finished = true;
      expect(
        await h.supervisor.ingest(
          ev({ source: "icos.runtime", type: "MISSION_BLOCKED", subject: "mission:m-1" }),
        ),
      ).toMatchObject({
        disposition: "RECORD_ONLY",
      });
    });

    it("answers 'what happened overnight?' from durable situations", async () => {
      const store = await make();
      const h = harness(store);
      await h.supervisor.ingest(ev({ type: "INVOICE_OVERDUE", subject: "invoice:INV-1" }));
      for (let i = 0; i < 3; i++)
        await h.supervisor.ingest(ev({ type: "PROVIDER_RATE_LIMIT", subject: "worker:w1" }));
      await h.supervisor.ingest(ev({ type: "NOISE" }));
      const overnight = await harness(store).supervisor.digest("tenant-a", {
        since: hourAgo(),
        until: soon(),
      });
      expect(overnight.eventCount).toBe(5);
      expect(overnight.ignoredCount).toBe(1);
      expect(overnight.situations.map((s) => [s.eventType, s.eventCount]).sort()).toEqual([
        ["INVOICE_OVERDUE", 1],
        ["PROVIDER_RATE_LIMIT", 3],
      ]);
    });
  });
}
