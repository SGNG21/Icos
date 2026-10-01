import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { missing, real } from "@/features/cockpit/truth";
import {
  buildMobileHome,
  type MobileHomeInput,
  type MobileHomeModel,
} from "@/features/mobile/home";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ refresh: () => {} }),
}));

const { MobileHome } = await import("./home");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const session = {
  user: { name: "Geoffrey", email: "owner@example.com" },
  roles: ["owner"],
};

const baseInput: MobileHomeInput = {
  generatedAt: "2026-09-30T10:05:00.000Z",
  health: { level: "healthy", reasons: [] },
  scope: "global",
  missions: real([]),
  focus: null,
  workers: real([]),
  timeline: real([]),
  alerts: [],
  approvals: real([]),
  canDecideApprovals: true,
  canDecideProposals: true,
  workforce: missing("not_connected", "Digital Workforce (lane D) is not wired into this build."),
  supervisor: real([]),
  dispatchLedger: real([]),
  canConverse: true,
};

const model = (over: Partial<MobileHomeInput> = {}): MobileHomeModel =>
  buildMobileHome({ ...baseInput, ...over });

const render = (m: MobileHomeModel) => html(h(MobileHome, { session, model: m }));

describe("truthful state rendering", () => {
  it("says EMPTY in words, never 'NON CONNECTÉE', when a source answered with nothing", () => {
    const out = render(model({ workforce: real({ total: 0, byStatus: {} }) }));
    expect(out).toContain("Aucune mission active.");
    expect(out).toContain("Aucune mission dans votre périmètre.");
    expect(out).toContain("Aucun worker enregistré.");
    expect(out).toContain("Aucune activité enregistrée.");
    expect(out).not.toContain("NON CONNECTÉE");
  });

  it("says INCONNU with the reason when a source could not be read", () => {
    const out = render(
      model({
        missions: missing("unknown", "Missions could not be read from ICOS."),
        workers: missing("unknown", "Worker registry could not be read from ICOS."),
        timeline: missing("unknown", "Audit log could not be read from ICOS."),
      }),
    );
    // The French section label, not the raw Truth kind: CSS-module class names such as
    // `status-UNKNOWN` also land in the markup under vitest's CSS stub, so asserting on
    // "UNKNOWN" could pass for the wrong reason.
    expect(out).toContain("INCONNU");
    expect(out).toContain("Missions could not be read from ICOS.");
    expect(out).toContain("Worker registry could not be read from ICOS.");
    // Never a zero count or an empty list dressed as an answer.
    expect(out).not.toContain("Aucune mission dans votre périmètre.");
  });

  it("distinguishes INDISPONIBLE from NON CONNECTÉE and names the requirement", () => {
    const out = render(
      model({
        timeline: missing("not_available", "The audit timeline requires audit.read.full.", "BR-07"),
        supervisor: missing("not_connected", "Le superviseur proactif exige PostgreSQL."),
      }),
    );
    expect(out).toContain("INDISPONIBLE");
    expect(out).toContain("BR-07");
    expect(out).toContain("NON CONNECTÉE");
    expect(out).toContain("Le superviseur proactif exige PostgreSQL.");
  });

  it("flags a section as DÉGRADÉE when a supporting source is missing", () => {
    const out = render(
      model({
        missions: real([
          {
            id: "m1",
            title: "Refonte LDS",
            objective: "Livrer LDS",
            status: "running",
            updatedAt: "2026-09-30T10:00:00.000Z",
            total: 2,
            completed: 1,
            running: 1,
            failed: 0,
            ready: 0,
            progressPct: 50,
            remainingCriticalPath: 1,
            attention: false,
            tone: "ok",
          },
        ]),
        workers: missing("unknown", "Worker registry could not be read from ICOS."),
      }),
    );
    expect(out).toContain("DÉGRADÉE");
    expect(out).toContain("Worker registry could not be read from ICOS.");
  });

  it("renders the canonical workforce census state instead of an invented zero", () => {
    expect(render(model())).toContain("Digital Workforce");
    expect(render(model())).toContain("NON CONNECTÉE");
  });

  it("never asserts 'no task dispatched' when the dispatch ledger was unreadable", () => {
    const out = render(
      model({
        workers: real([
          {
            id: "w1",
            name: "Hermes",
            runtime: "temporal",
            health: "healthy",
            status: "active",
            availability: "available",
            probe: { outcome: "ok", at: null, ageMs: null },
            model: real("claude-opus-5"),
            provider: real("anthropic"),
            slots: { used: real(0), max: 1 },
            assignments: [],
            routable: true,
          },
        ]) as never,
        dispatchLedger: missing("unknown", "Dispatch attempts could not be read."),
      }),
    );
    expect(out).not.toContain("Aucune tâche dispatchée");
    expect(out).toContain("Tâche :");
    expect(out).toContain("UNKNOWN");
  });

  it("never shows a progress percentage for a mission without tasks", () => {
    const out = render(
      model({
        missions: real([
          {
            id: "m1",
            title: "Sans tâche",
            objective: "x",
            status: "planning",
            updatedAt: "2026-09-30T10:00:00.000Z",
            total: 0,
            completed: 0,
            running: 0,
            failed: 0,
            ready: 0,
            progressPct: 0,
            remainingCriticalPath: 0,
            attention: false,
            tone: "flow",
          },
        ]),
      }),
    );
    // The progression row says there is no task, and claims no percentage.
    expect(out).toContain("AUCUNE TÂCHE");
    expect(out).not.toContain("0 %");
  });
});

/**
 * A phone has no hover, so a reason carried only in a `title` attribute cannot be read on
 * the device this page exists for. Every non-value must explain itself in visible text.
 */
describe("missing values explain themselves on screen, not in a tooltip", () => {
  it("renders the reason of a per-value non-value as text", () => {
    const out = render(
      model({
        missions: real([
          {
            id: "m1",
            title: "Refonte LDS",
            objective: "Livrer LDS",
            status: "running",
            updatedAt: "2026-09-30T10:00:00.000Z",
            total: 2,
            completed: 1,
            running: 1,
            failed: 0,
            ready: 0,
            progressPct: 50,
            remainingCriticalPath: 1,
            attention: false,
            tone: "ok",
          },
        ]) as never,
      }),
    );
    // The active mission is not the focus one, so ICOS derives no critical path for it.
    expect(out).toContain("ICOS ne dérive un chemin critique que pour la mission en focus.");
    expect(out).not.toMatch(/title="ICOS ne dérive/);
  });

  it("renders the reason a worker's activity is unknown as text", () => {
    const out = render(
      model({
        workers: real([
          {
            id: "w1",
            name: "Hermes",
            runtime: "temporal",
            health: "healthy",
            status: "active",
            availability: "available",
            probe: { outcome: "ok", at: null, ageMs: null },
            model: real("claude-opus-5"),
            provider: real("anthropic"),
            slots: { used: real(0), max: 1 },
            assignments: [],
            routable: true,
          },
        ]) as never,
        dispatchLedger: missing("unknown", "Dispatch attempts could not be read."),
      }),
    );
    expect(out).toContain("Dispatch attempts could not be read.");
  });

  it("states a finished critical path as a value rather than an absent source", () => {
    const out = render(
      model({
        missions: real([
          {
            id: "m1",
            title: "Refonte LDS",
            objective: "Livrer LDS",
            status: "running",
            updatedAt: "2026-09-30T10:00:00.000Z",
            total: 1,
            completed: 1,
            running: 0,
            failed: 0,
            ready: 0,
            progressPct: 100,
            remainingCriticalPath: 0,
            attention: false,
            tone: "ok",
          },
        ]) as never,
        focus: { missionId: "m1", path: [{ id: "t1", title: "Audit", status: "COMPLETED" }] },
      }),
    );
    expect(out).toContain("chemin critique terminé");
    expect(out).not.toContain("NOT AVAILABLE");
  });
});

describe("control surfaces are permission gated", () => {
  const withApproval = (canDecide: boolean) =>
    render(
      model({
        canDecideApprovals: canDecide,
        approvals: real([
          {
            id: "action-1",
            kind: "repository.push",
            risk: "sensitive",
            taskId: "task-2",
            requestedAt: "2026-09-30T08:10:00.000Z",
            requestedBy: "agent-development",
          },
        ]),
      }),
    );

  it("offers a decision only to a session that may decide", () => {
    expect(withApproval(true)).toContain("Approuver");
    expect(withApproval(false)).not.toContain("Approuver");
    expect(withApproval(false)).toContain("approvals.decide");
  });

  it("shows the pending action's own canonical facts", () => {
    const out = withApproval(true);
    expect(out).toContain("repository.push");
    expect(out).toContain("sensitive");
    expect(out).toContain("agent-development");
  });
});

describe("command surface", () => {
  /**
   * Arrival must call the Cognitive Runtime ZERO times. Entering its HTTP surface composes
   * the runtime, and composing it relaunches the tenant's interrupted goal launches once a
   * minute (`cognitiveRuntimeFor` -> `recoverLaunches` -> `launch`, which enqueues
   * `start_mission`). On the root page that would turn a page view into a write. So the
   * first render is `idle`: no probe, and therefore no claim about the link either way.
   */
  it("renders the ICOS prompt without touching the runtime on arrival", () => {
    const out = render(model());
    expect(out).toContain("Que voulez-vous faire ?");
    // No link claim of any kind: the runtime has not been asked, so nothing is known.
    // Every command-link notice names the runtime, so its absence is the whole assertion.
    // (A bare "NON CONNECTÉE" would be too broad — that is also a legitimate SECTION state,
    // e.g. the Digital Workforce line, which has nothing to do with the command link.)
    expect(out).not.toContain("runtime cognitif");
    expect(out).not.toContain("MOTEUR COGNITIF");
    // Nothing can be submitted: the send button stays disabled until there is a draft
    // AND a probed link. An empty draft alone is enough to keep it shut.
    expect(out).toMatch(/aria-label="Envoyer à ICOS"/);
    expect(out).toMatch(/<button[^>]*disabled[^>]*aria-label="Envoyer à ICOS"/);
  });

  /**
   * The field itself is what triggers the probe (onFocus), so it must NOT be disabled on
   * arrival — a disabled input could never be focused and the link would stay unknowable.
   */
  it("leaves the field usable so the owner's first gesture can probe the link", () => {
    const out = render(model());
    expect(out).toMatch(/aria-label="Commande textuelle"/);
    expect(out).not.toMatch(/aria-label="Commande textuelle"[^>]*disabled/);
  });

  it("implies no transcript and no submission before anything was sent", () => {
    const out = render(model());
    expect(out).not.toContain("Échanges de cette session");
    expect(out).not.toContain("ICOS traite ce tour");
    // Nor the "a conversation already exists" note, which needs a probed conversation.
    expect(out).not.toContain("Une conversation ICOS existe déjà");
  });

  it("offers nothing to a session that may read but not converse", () => {
    const out = render(model({ canConverse: false }));
    expect(out).toContain("LECTURE SEULE");
    expect(out).toContain("tasks.write");
  });
});

/**
 * Architectural boundary, enforced on the source itself: the Mobile Home is a read and
 * control surface. It talks to the Cognitive Runtime for conversation, to the canonical
 * action-decision route for an explicit human decision, and to the read-only cockpit
 * endpoint for its heartbeat. It never submits work to CORE3, the scheduler, the
 * Workforce or the Tool Gateway — those have their own authorities.
 */
describe("Mobile Home does not invoke CORE3 directly", () => {
  /**
   * The scan covers the phone's components, its server loader AND the transport the
   * command bar delegates to — every file that can name an ICOS endpoint on this path.
   * It is a lint, not a proof: a URL assembled at runtime would escape it. The
   * mutation-free guarantee is pinned separately by the resume assertion below and by
   * `load.test.ts`'s spies.
   */
  const dirs = ["src/components/mobile", "src/features/mobile"];
  const extra = ["src/features/cockpit/ask.ts"];
  /** Comments explain the boundary by naming the forbidden routes; only code is scanned. */
  const code = (text: string) =>
    text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");
  const paths = [
    ...dirs.flatMap((d) =>
      readdirSync(join(process.cwd(), d))
        .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
        .map((f) => join(d, f)),
    ),
    ...extra,
  ];
  const sources = paths.map((p) => ({
    file: p,
    text: readFileSync(join(process.cwd(), p), "utf8"),
    code: code(readFileSync(join(process.cwd(), p), "utf8")),
  }));

  const ALLOWED = [
    "/api/cognitive/conversations",
    "/api/actions/",
    "/api/cockpit",
    "/voice",
    "/login",
  ];

  const FORBIDDEN = [
    "/api/missions",
    "/api/tasks",
    "/api/goals",
    "/api/scheduler",
    "/api/internal",
    "/api/control/commands",
    "/api/tool-gateway",
    "/api/admin",
    "/api/agents",
    "/api/skills",
  ];

  it("references no CORE3, scheduler, workforce or tool-gateway endpoint", () => {
    for (const { file, code: text } of sources) {
      for (const endpoint of FORBIDDEN) {
        expect(text, `${file} must not reference ${endpoint}`).not.toContain(endpoint);
      }
    }
  });

  it("every endpoint it does reference is a read path or an explicit human decision", () => {
    const referenced = sources.flatMap(({ file, code: text }) =>
      [...text.matchAll(/["'`](\/api\/[A-Za-z0-9/_${}().-]*)/g)].map((m) => ({
        file,
        url: m[1],
      })),
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const { file, url } of referenced) {
      expect(
        ALLOWED.some((prefix) => url.startsWith(prefix)),
        `${file} references an unexpected endpoint: ${url}`,
      ).toBe(true);
    }
  });

  it("scans the files that can actually name an endpoint", () => {
    const scanned = sources.map((s) => s.file);
    expect(scanned.some((f) => f.endsWith("command-bar.tsx"))).toBe(true);
    expect(scanned.some((f) => f.endsWith("load.ts"))).toBe(true);
    // The command bar's URLs are built here, not in the component.
    expect(scanned).toContain("src/features/cockpit/ask.ts");
  });

  it("submits conversation turns through the Cognitive Runtime transport", () => {
    const bar = sources.find((s) => s.file.endsWith("command-bar.tsx"));
    expect(bar).toBeDefined();
    expect(bar!.code).toContain("httpCognitiveTransport");
    expect(bar!.code).not.toMatch(/\bfetch\s*\(/);
    // The transport's base is the Cognitive Runtime and nothing else.
    const ask = sources.find((s) => s.file === "src/features/cockpit/ask.ts");
    expect(ask!.code).toContain('const base = "/api/cognitive/conversations"');
  });

  /**
   * `CognitiveRuntime.resume` closes interrupted turns and finishes approved proposals —
   * it can complete a goal launch. It is a recovery operation behind a GET, so the home
   * screen must never call it: opening a page would mutate durable state.
   */
  it("never calls the runtime's resume route, which mutates behind a GET", () => {
    for (const { file, code: text } of sources) {
      if (file === "src/features/cockpit/ask.ts") continue; // the shared transport offers it
      expect(text, `${file} must not call transport.resume`).not.toMatch(/\.resume\s*\(/);
    }
  });

  /**
   * Every Cognitive Runtime URL is built in the shared transport. If a file on this
   * surface ever names `/api/cognitive` itself it could reach the mutating `resume` GET
   * without going through `transport.`, which the assertions above would not see.
   */
  it("names no Cognitive Runtime URL of its own — all of them go through the transport", () => {
    const mobile = sources.filter((s) => !s.file.startsWith("src/features/cockpit"));
    for (const { file, code: text } of mobile) {
      expect(text, `${file} must not build a cognitive URL itself`).not.toContain("/api/cognitive");
    }
  });

  it("the only runtime calls it makes are list, create, submit and decide", () => {
    const mobile = sources.filter((s) => !s.file.startsWith("src/features/cockpit"));
    const used = new Set(
      mobile.flatMap(({ code: text }) =>
        [...text.matchAll(/transport\.([a-zA-Z]+)\s*\(/g)].map((m) => m[1]),
      ),
    );
    expect([...used].sort()).toEqual(["create", "decide", "list", "submit"]);
  });
});

/**
 * A consent surface must state what the tap actually commits to. Approving a goal proposal
 * enqueues `start_mission` (`mission-gateway.ts`), whose handler calls
 * `igniteAutonomousMission` -> `startAutonomousMission`: the runner plans and the supervisor
 * DISPATCHES ready tasks through the durable dispatch ledger, with no further human step.
 * The goal's `humanApprovalPolicy: "always"` is read by `GoalPlanner` for the stored PREVIEW
 * only; it never reaches the autonomous runner, which gets `{id,title,objective,goalId}` and
 * ignores goalId for gating.
 *
 * The proposal block only renders after a live submission, which static rendering cannot
 * reach, so this is asserted on the source text. A lint, not a proof — but the hazard here
 * IS the wording, and a lint is exactly what stops the old sentence coming back.
 */
describe("the approval surface states what approving really does", () => {
  const bar = readFileSync(join(process.cwd(), "src/components/mobile/command-bar.tsx"), "utf8");
  /** Only rendered strings count; the comment above the block explains the old claim. */
  const rendered = bar.replaceAll(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("no longer claims that starting the mission stays a human step", () => {
    expect(rendered).not.toContain("étape opérateur");
    expect(rendered).not.toContain("ne lance jamais de workers");
  });

  it("states that the mission starts by itself and dispatches to workers", () => {
    expect(rendered).toContain("La mission démarre d");
    expect(rendered).toContain("dispatche les tâches prêtes aux workers");
  });

  it("warns BEFORE the tap, next to the Approuver button, not only after it", () => {
    expect(rendered).toContain("et la démarre");
    const warning = rendered.indexOf("Approuver crée la mission");
    // The approve button is identified by its handler, not its label text, which JSX wraps.
    const button = rendered.indexOf('decide(p.id, "approve")');
    expect(warning).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(button);
  });
});

describe("scope disclosure", () => {
  /**
   * `resolveOperationalScope` falls back to an EMPTY linked scope when the operational-access
   * service is not composed, so an empty mission list is not evidence that ICOS is idle.
   */
  it("says the perimeter is LIÉ when the reads were scope-limited", () => {
    const out = render(model({ scope: "linked" }));
    expect(out).toContain("LIÉ");
    expect(out).toContain("ne veut pas dire qu");
  });

  it("says nothing extra at owner/admin scope — there is no perimeter caveat to make", () => {
    expect(render(model({ scope: "global" }))).not.toContain("Périmètre");
  });
});

describe("canonical severity is shown, not a re-derived one", () => {
  it("shows a HIGH supervisor situation as HIGH, never as CRITICAL", () => {
    const out = render(
      model({
        alerts: [],
        supervisor: real([
          {
            id: "s1",
            domain: "finance",
            eventType: "invoice.overdue",
            subject: "LDS",
            kind: "problem" as const,
            severity: "high" as const,
            state: "open" as const,
            eventCount: 3,
            lastSeenAt: "2026-09-30T09:00:00.000Z",
            clientScope: null,
            projectScope: null,
            proposal: null,
          },
        ]),
      }),
    );
    expect(out).toContain("HIGH");
    expect(out).not.toContain("CRITICAL");
  });
});
