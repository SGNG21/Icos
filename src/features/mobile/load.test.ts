import { beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";
import type { CockpitSnapshot } from "@/features/cockpit/snapshot";
import { missing, real } from "@/features/cockpit/truth";

/**
 * The Mobile Home loader is a READ path. These tests pin the three things that make it
 * safe: it fails closed, it only ever calls list/read methods on the canonical runtime,
 * and the supervisor digest is asked for one tenant and only in owner/admin scope.
 */

const digest = vi.fn();
vi.mock("@/server/proactive/read-port", () => ({
  supervisorReadPort: (db: unknown) => {
    void db;
    return { digest };
  },
}));

const state = vi.hoisted(() => ({
  context: null as unknown,
  snapshot: null as unknown,
  sources: null as unknown,
  readModels: null as unknown,
}));

vi.mock("@/features/cockpit/load", () => ({
  getCockpitContext: async () => state.context,
  loadSnapshot: async () => state.snapshot,
  loadSources: async () => state.sources,
  // A function stub is CALLED, so a test can make this source throw rather than resolve —
  // which is the whole point of the containment tests below.
  loadReadModels: async () =>
    typeof state.readModels === "function"
      ? (state.readModels as () => unknown)()
      : state.readModels,
}));

const { loadMobileHome } = await import("./load");

const snapshot = (over: Partial<CockpitSnapshot> = {}): CockpitSnapshot =>
  ({
    generatedAt: "2026-09-30T10:00:00.000Z",
    backend: "postgres",
    scope: "global",
    health: { level: "healthy", reasons: [] },
    metrics: {},
    domains: [],
    alerts: [],
    workers: real([]),
    missions: real([]),
    focus: null,
    timeline: real([]),
    ...over,
  }) as unknown as CockpitSnapshot;

/**
 * Every mutating method the loader could reach is a spy. `read()` swallows thrown errors
 * into an UNKNOWN Truth, so a throwing stub would NOT fail the test — the assertion has
 * to be "this spy was never called".
 */
const MUTATORS = [
  "create",
  "update",
  "save",
  "insert",
  "delete",
  "transact",
  "ingest",
  "drain",
  "dispatch",
  "launch",
  "recoverInterrupted",
  "start",
  "close",
] as const;

function runtime(options: {
  scope?: { kind: "global" } | { kind: "linked"; agentIds: string[] };
  roles?: string[];
  db?: unknown;
  listForScope?: () => Promise<unknown[]>;
}) {
  const listForScope = vi.fn(options.listForScope ?? (async () => []));
  const mutators = Object.fromEntries(MUTATORS.map((m) => [m, vi.fn()])) as Record<
    (typeof MUTATORS)[number],
    ReturnType<typeof vi.fn>
  >;
  const container = {
    db: options.db,
    actions: { listForScope, ...mutators },
    mission: { ...mutators },
    missionService: { ...mutators },
    taskExecution: { ...mutators },
    audit: { ...mutators },
    scheduler: { ...mutators },
  };
  state.context = {
    container,
    session: { user: { id: "u1", email: "o@example.com" }, roles: options.roles ?? ["owner"] },
    scope: options.scope ?? { kind: "global" },
  };
  return { listForScope, mutators, container };
}

beforeEach(() => {
  digest.mockReset();
  digest.mockResolvedValue({ situations: [], eventCount: 0, ignoredCount: 0 });
  state.snapshot = snapshot();
  state.sources = { attempts: real([]) };
  state.readModels = { workforce: missing("not_connected", "lane D not wired") };
});

describe("fail closed", () => {
  it("returns null when the caller is authenticated but not allowed to read", async () => {
    state.context = null;
    expect(await loadMobileHome()).toBeNull();
  });

  it("returns null when the canonical snapshot refuses the caller", async () => {
    runtime({});
    state.snapshot = null;
    expect(await loadMobileHome()).toBeNull();
  });

  it("returns null when the canonical sources refuse the caller", async () => {
    runtime({});
    state.sources = null;
    expect(await loadMobileHome()).toBeNull();
  });
});

describe("user and tenant scope", () => {
  it("reads pending actions only through the caller's operational scope", async () => {
    const { listForScope } = runtime({ scope: { kind: "linked", agentIds: ["agent-1"] } });
    await loadMobileHome();
    expect(listForScope).toHaveBeenCalledTimes(1);
    expect(listForScope).toHaveBeenCalledWith(
      { kind: "linked", agentIds: ["agent-1"] },
      { approvalStatus: "pending" },
    );
  });

  it("asks the supervisor digest for the caller's tenant only", async () => {
    runtime({ db: {} });
    await loadMobileHome();
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest.mock.calls[0][0]).toBe(CURRENT_SINGLE_TENANT_ID);
  });

  it("never reads supervisor rows for a linked (non owner/admin) scope", async () => {
    runtime({ db: {}, scope: { kind: "linked", agentIds: ["agent-1"] } });
    const model = await loadMobileHome();
    expect(digest).not.toHaveBeenCalled();
    expect(model?.proposals.state).toBe("UNAVAILABLE");
    expect(model?.incidents.state).toBe("UNAVAILABLE");
  });

  it("reports the supervisor as NOT CONNECTED without a durable database", async () => {
    runtime({ db: undefined });
    const model = await loadMobileHome();
    expect(digest).not.toHaveBeenCalled();
    expect(model?.proposals.state).toBe("NOT_CONNECTED");
  });

  it("derives the decision permissions from the caller's roles", async () => {
    runtime({ roles: ["viewer"] });
    const viewer = await loadMobileHome();
    expect(viewer?.canDecideApprovals).toBe(false);
    expect(viewer?.canDecideProposals).toBe(false);
    runtime({ roles: ["operator"] });
    const operator = await loadMobileHome();
    expect(operator?.canDecideApprovals).toBe(true);
    expect(operator?.canDecideProposals).toBe(true);
  });
});

describe("degradation", () => {
  it("renders UNKNOWN instead of an empty list when the action source throws", async () => {
    runtime({
      listForScope: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    const model = await loadMobileHome();
    expect(model?.approvals.state).toBe("UNKNOWN");
    expect(model?.approvals.items).toEqual([]);
  });

  it("renders UNKNOWN when the supervisor store is unreachable", async () => {
    runtime({ db: {} });
    digest.mockRejectedValue(new Error('relation "supervisor_situations" does not exist'));
    const model = await loadMobileHome();
    expect(model?.proposals.state).toBe("UNKNOWN");
    // The reason never carries the database error text.
    expect(model?.proposals.reason).not.toContain("supervisor_situations");
  });

  it("keeps the workforce census honest when lane D is not wired", async () => {
    runtime({});
    const model = await loadMobileHome();
    expect(model?.workforce.state).toBe("NOT_CONNECTED");
  });

  it("does not report a measured workforce census from a malformed projection", async () => {
    runtime({});
    state.readModels = { workforce: missing("unknown", "projection did not match the contract") };
    const model = await loadMobileHome();
    expect(model?.workforce.state).toBe("UNKNOWN");
  });
});

describe("no page-render side effect", () => {
  it("calls no mutating runtime method at all", async () => {
    const { mutators, listForScope } = runtime({ db: {} });
    const model = await loadMobileHome();
    expect(model).not.toBeNull();
    for (const [name, spy] of Object.entries(mutators)) {
      expect(spy, `${name}() must not be called while rendering a page`).not.toHaveBeenCalled();
    }
    // The one canonical call the loader is allowed to make.
    expect(listForScope).toHaveBeenCalledTimes(1);
  });

  it("reads the supervisor through a digest-only port (no ingest, drain or transact)", async () => {
    runtime({ db: {} });
    await loadMobileHome();
    expect(digest).toHaveBeenCalledTimes(1);
    const window = digest.mock.calls[0][1] as { since: Date; until: Date };
    expect(window.since.getTime()).toBeLessThan(window.until.getTime());
  });

  it("carries the dispatch ledger truth so an unreadable ledger degrades, not lies", async () => {
    runtime({ db: {} });
    state.sources = { attempts: missing("unknown", "Dispatch attempts could not be read.") };
    state.snapshot = snapshot({
      workers: real([
        {
          id: "w1",
          name: "Hermes",
          runtime: "temporal",
          health: "healthy",
          status: "active",
          availability: "available",
          probe: { outcome: "ok", at: null, ageMs: null },
          model: real("m"),
          provider: real("p"),
          slots: { used: real(0), max: 1 },
          assignments: [],
          routable: true,
        },
      ]) as never,
    });
    const model = await loadMobileHome();
    expect(model?.workers.state).toBe("DEGRADED");
    expect(model?.workers.items[0].currentTask.kind).toBe("unknown");
  });
});

/**
 * The loader promises that "each source is read in isolation so one failure degrades that
 * section to UNKNOWN instead of blanking the page". `loadReadModels` has no error handling
 * of its own, and the workforce port awaits four service calls that throw when the database
 * is unavailable — so uncontained it would reject the whole `Promise.all` and 500 the ROOT
 * page. Containment is the difference between one honest UNKNOWN line and no home screen.
 */
describe("one failing source never blanks the page", () => {
  it("degrades the workforce census to UNKNOWN when the read model THROWS", async () => {
    runtime({ db: {} });
    state.readModels = () => {
      throw new Error("PersistenceUnavailableError: connection terminated");
    };
    const model = await loadMobileHome();
    // The page still renders, and the census says it does not know.
    expect(model).not.toBeNull();
    expect(model?.workforce.state).toBe("UNKNOWN");
    // Every other section is unaffected by a workforce outage.
    expect(model?.missions.state).not.toBe("UNKNOWN");
  });

  it("leaks no error internals into the reason it shows", async () => {
    runtime({ db: {} });
    state.readModels = () => {
      throw new Error("postgres://icos:s3cr3t@10.0.0.4:5432/icos timed out");
    };
    const model = await loadMobileHome();
    const reason = model?.workforce.reason ?? "";
    expect(reason).not.toContain("s3cr3t");
    expect(reason).not.toContain("postgres://");
    expect(reason).not.toContain("10.0.0.4");
  });
});

describe("the perimeter the facts were read under is carried to the screen", () => {
  it("reports the snapshot's own scope rather than dropping it", async () => {
    runtime({ db: {} });
    state.snapshot = snapshot({ scope: "linked" });
    expect((await loadMobileHome())?.scope).toBe("linked");
  });

  it("reports global scope as global", async () => {
    runtime({ db: {} });
    state.snapshot = snapshot({ scope: "global" });
    expect((await loadMobileHome())?.scope).toBe("global");
  });
});
