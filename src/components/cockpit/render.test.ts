import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildDag } from "@/features/cockpit/dag";
import { buildCockpitSnapshot, type WorkerView } from "@/features/cockpit/snapshot";
import { missing, real } from "@/features/cockpit/truth";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cockpit/missions",
  useRouter: () => ({ refresh: () => {} }),
}));

const { MetricTile, TruthValue, ToneBadge, Unavailable } = await import("./primitives");
const { CockpitNav } = await import("./cockpit-nav");
const { MOBILE_TABS, NAV_ITEMS, isActive } = await import("./nav-items");
const { CommandButton } = await import("./command-button");
const { DagView } = await import("./dag-view");
const { SystemMap, flowDuration } = await import("./system-map");
const { AskIcos } = await import("./ask-icos");
const { AlertList } = await import("./alert-list");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

describe("truth rendering", () => {
  it("renders UNKNOWN / NOT AVAILABLE / NOT CONNECTED with reason and requirement, never a number", () => {
    const u = html(h(TruthValue, { truth: missing("unknown", "db down") }));
    expect(u).toContain("UNKNOWN");
    expect(u).toContain('title="db down"');
    const n = html(h(TruthValue, { truth: missing("not_available", "no ledger", "BR-05") }));
    expect(n).toContain("NOT AVAILABLE");
    expect(n).toContain("BR-05");
    const w = html(h(TruthValue, { truth: missing("not_connected", "bus", "BR-10") }));
    expect(w).toContain("NOT CONNECTED");
    expect(w).toMatch(/data-kind="not_connected"/);
  });

  it("marks derived real values and renders the value", () => {
    const out = html(h(TruthValue, { truth: real(7, "sum") }));
    expect(out).toContain("7");
    expect(out).toContain("derived: sum");
  });

  it("forces the unknown tone on a missing metric whatever tone was requested", () => {
    expect(
      html(h(MetricTile, { label: "Cost", truth: missing("not_available", "x"), tone: "ok" })),
    ).toContain('data-tone="unknown"');
  });

  it("never encodes state by colour alone", () => {
    const out = html(h(ToneBadge, { tone: "critical" }));
    expect(out).toContain("Critical");
    expect(out).toContain("<svg");
  });

  it("names the requirement of an unavailable feature", () => {
    expect(html(h(Unavailable, { title: "X", requirement: "BR-08" }))).toContain("BR-08");
  });
});

describe("navigation", () => {
  it("exposes all sections and a five-slot thumb bar with Ask ICOS centred", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Overview",
      "Executive",
      "Missions",
      "Pipeline",
      "Workers",
      "Compute",
      "Alerts",
      "Autonomy",
      "Self-development",
      "Audit",
      "System",
      "Settings",
    ]);
    expect(MOBILE_TABS.length).toBe(4); // + the "More" sheet = 5 slots
    expect(MOBILE_TABS[2].label).toBe("Ask ICOS");
  });

  it("marks the current section for assistive tech and badges P0", () => {
    const out = html(h(CockpitNav, { p0: 3 }));
    expect(out.match(/aria-current="page"/g)?.length).toBeGreaterThanOrEqual(2); // rail + tab bar
    expect(out).toContain('aria-label="3 P0 alerts"');
    expect(out).toContain('aria-label="All sections"');
  });

  it("matches nested routes but not the overview prefix", () => {
    expect(isActive("/cockpit/missions/abc", "/cockpit/missions")).toBe(true);
    expect(isActive("/cockpit/missions", "/cockpit")).toBe(false);
  });
});

describe("governed controls", () => {
  it("renders a control that opens a dialog, with its risk exposed", () => {
    const out = html(
      h(CommandButton, {
        type: "ENTER_SAFE_MODE",
        target: { kind: "runtime", id: "global" },
        label: "ICOS",
      }),
    );
    expect(out).toContain('data-risk="MEDIUM"');
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).toContain("Enter safe mode");
    // Nothing is claimed before the owner acts.
    expect(out).not.toMatch(/SUCCEEDED|Executed/);
  });

  it("a control with no canonical command is never clickable", async () => {
    const { NotCommandable } = await import("./command-button");
    const out = html(h(NotCommandable, { label: "Retry task", requirement: "BR-23" }));
    expect(out).toContain('aria-disabled="true"');
    expect(out).not.toContain("<button");
    expect(out).toContain("NO COMMAND");
  });
});

describe("mission DAG view", () => {
  const task = (
    id: string,
    status: "succeeded" | "queued" | "running",
    dependsOn: string[] = [],
  ) => ({
    task: { id, title: id, status, dependsOn, taskId: `t-${id}` },
  });

  it("renders focusable nodes with status labels and critical path", () => {
    const dag = buildDag([
      task("a", "succeeded"),
      task("b", "running", ["a"]),
      task("c", "queued", ["b"]),
    ]);
    const out = html(h(DagView, { dag }));
    expect(out.match(/role="button"/g)?.length).toBe(3);
    expect(out).toContain('aria-label="b: RUNNING, on critical path"');
    expect(out).toContain("remaining critical path 2");
    expect(out).toContain("WHY DATA NOT AVAILABLE");
  });

  it("says so when the mission has no graph", () => {
    expect(html(h(DagView, { dag: buildDag([]) }))).toContain("no task graph");
  });
});

describe("system map", () => {
  const base = {
    now: new Date("2026-09-28T12:00:00Z"),
    backend: "postgres" as const,
    scope: "global" as const,
    tasks: real([]),
    missions: real([]),
    workers: real([]),
    activeAssignments: real([]),
    attempts: real([]),
    pendingApprovals: real(0),
    audit: real([]),
    qualityJobs: real([]),
    workspaces: real([]),
  };

  it("animates nothing without real activity and labels missing domains", () => {
    const out = html(h(SystemMap, { snapshot: buildCockpitSnapshot(base) }));
    expect(out).not.toContain("cx-map__flow");
    expect(out).toContain("NOT AVAILABLE");
    expect(out).toContain('aria-label="Providers: NOT AVAILABLE, Unknown"');
  });

  it("maps flow speed to activity", () => {
    expect(flowDuration(0)).toBeNull();
    expect(flowDuration(1)!).toBeGreaterThan(flowDuration(50)!);
  });
});

describe("worker identity", () => {
  it("renders model/provider/account as missing rather than borrowing the worker kind", async () => {
    const { default: WorkersPage } = await import("@/app/cockpit/workers/page");
    expect(WorkersPage).toBeTypeOf("function"); // server page compiles and exports
    const w = buildCockpitSnapshot({
      ...{
        now: new Date(),
        backend: "postgres",
        scope: "global",
        tasks: real([]),
        missions: real([]),
        attempts: real([]),
        pendingApprovals: real(0),
        audit: real([]),
        qualityJobs: real([]),
        workspaces: real([]),
      },
      activeAssignments: real([]),
      workers: real([
        {
          id: "00000000-0000-4000-8000-000000000001",
          workerKind: "hermes",
          displayName: "hermes-01",
          capabilities: [],
          features: [],
          supportsTools: false,
          supportsStructuredOutput: false,
          status: "active",
          runtime: "node",
          runtimeSupport: "SUPPORTED_RUNTIME",
          health: "healthy",
          availability: "available",
          tags: [],
          metadata: {},
          metadataHidden: 0,
          lastProbeAt: null,
          lastProbeOutcome: "never",
          maxConcurrency: 1,
          capacityPool: null,
          capacityPoolLimit: null,
          updatedAt: "2026-09-28T00:00:00Z",
        },
      ]),
    });
    const view = (w.workers as { kind: "real"; value: WorkerView[] }).value[0];
    for (const t of [view.model, view.provider, view.account]) {
      expect(html(h(TruthValue, { truth: t }))).toContain("NOT AVAILABLE");
    }
    expect(view.tone).toBe("unknown"); // healthy claim without probe evidence is not trusted
  });
});

describe("alerts", () => {
  it("renders severity as text and links to the subject", () => {
    const out = html(
      h(AlertList, {
        alerts: [
          {
            id: "a",
            category: "CAPACITY",
            severity: "P0",
            title: "No routable worker",
            href: "/cockpit/workers",
          },
        ],
        empty: "none",
      }),
    );
    expect(out).toContain("P0");
    expect(out).toContain('href="/cockpit/workers"');
  });
});

describe("Ask ICOS shell", () => {
  it("renders no answer and a disabled send button before anything is typed", () => {
    const out = html(h(AskIcos));
    expect(out).not.toContain("cx-answer");
    expect(out).toMatch(/<button type="submit"[^>]*disabled/);
  });
});

describe("worker card", () => {
  it("keeps Worker / Runtime / Model / Provider / Account / Capacity slot separate and verbatim", async () => {
    const { WorkerCard } = await import("./worker-card");
    const w: WorkerView = {
      id: "w-1",
      name: "openhands-docker-01",
      kind: "openhands",
      runtime: "docker",
      runtimeSupport: "DECLARED_ONLY",
      status: "active",
      health: "unknown",
      availability: "unknown",
      probe: { outcome: "unsupported", at: null, ageMs: null },
      model: real(
        "nemotron-120b",
        "declared in worker registry metadata (not verified by a probe)",
      ),
      provider: real("nvidia", "declared"),
      account: missing("not_available", "no account", "BR-03"),
      slots: { used: real(1, "ledger"), max: 3 },
      pool: { name: "nv-quota", limit: 2 },
      capabilities: [],
      features: [],
      tags: [],
      metadata: {},
      metadataHidden: 0,
      assignments: [],
      leases: real([]),
      tone: "unknown",
      routable: false,
    };
    const out = html(h(WorkerCard, { worker: w }));
    for (const k of ["Worker kind", "Runtime", "Model", "Provider", "Account", "Capacity slots"])
      expect(out).toContain(`>${k}<`);
    expect(out).toContain("nemotron-120b"); // verbatim, not transformed
    expect(out).toContain("NOT AVAILABLE");
    expect(out).toContain("no workspace lease held"); // read from the workspace registry
    expect(out).toContain("pool nv-quota ≤2");
    expect(out).toContain("unsupported");
    // One governed control (disable, since the worker is active) + retry shown as not commandable.
    expect(out.match(/<button[^>]*class="cx-cmd"/g)?.length).toBe(1);
    expect(out).toContain("Disable");
    expect(out).toContain("BR-23");
  });
});

describe("emergency controls", () => {
  it("mirror the backend risk: entering is reachable, leaving is CRITICAL", async () => {
    const { COMMAND_SPECS, needsReauth } = await import("@/features/cockpit/commands");
    expect(COMMAND_SPECS.ENTER_SAFE_MODE.risk).toBe("MEDIUM");
    expect(COMMAND_SPECS.EXIT_SAFE_MODE.risk).toBe("CRITICAL");
    expect(needsReauth("ENTER_SAFE_MODE")).toBe(false);
    expect(needsReauth("EXIT_SAFE_MODE")).toBe(true);
  });

  it("control state renders UNKNOWN before ICOS answers, never on/off", async () => {
    const { ControlStatePanel } = await import("./control-state");
    const out = html(h(ControlStatePanel));
    expect(out).toContain("UNKNOWN");
    expect(out).not.toMatch(/>on<|>off</);
  });
});

describe("stale indicator", () => {
  it("renders live state with a polite live region", async () => {
    const { LiveRefresh } = await import("./live-refresh");
    const out = html(h(LiveRefresh, { generatedAt: new Date().toISOString() }));
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("LIVE");
  });
});
