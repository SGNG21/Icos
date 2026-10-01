import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { CognitiveScope } from "@/core/cognitive/contracts";
import type { DatabaseHandle } from "@/server/database/client";
import { goals, missions } from "@/server/database/schema";

import { OperationalStateSource } from "./operational-state";
import { openTestDb, resetCognitive } from "./testing/support";

/**
 * CROSS-CLIENT BLEED THROUGH THE RUNTIME STAGE — found by the independent review of the
 * central integration, not by either lane alone.
 *
 * `OperationalStateSource` (phone lane, decision 0062) filtered open missions on the asking
 * user only. That was harmless while `scope.clientId` was always null; once client
 * resolution became real (context lane, decision 0063) the same query put EVERY client's
 * mission titles into a conversation resolved to ONE client — at `runtime` stage with
 * `anchored: true`, so not even relevance-gated, defeating for this one stage the isolation
 * every other stage enforces.
 *
 * A mission has no client column: its client is the one its goal was launched under
 * (`goals.metadata.clientId`). These are REAL PostgreSQL proofs because the defect and the
 * fix are both in SQL — an in-memory double would prove nothing about the predicate.
 */
const TENANT = "default";
const ME = "user-geoffrey";
const SOMEONE_ELSE = "user-other";
const LDS = "lds-renov";
const MECENE = "editions-du-mecene";

const now = new Date("2026-10-01T18:30:00.000Z");
const scopeOf = (over: Partial<CognitiveScope> = {}): CognitiveScope => ({
  tenantId: TENANT,
  userId: ME,
  clientId: null,
  projectId: null,
  ...over,
});

let handle: DatabaseHandle;
const handles: DatabaseHandle[] = [];

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

/** A mission plus, when `clientId` is given, the goal row that attributes it. */
async function seedMission(opts: {
  id: string;
  userId?: string;
  clientId?: string;
  projectId?: string;
  attributed?: boolean;
}): Promise<void> {
  const attributed = opts.attributed ?? true;
  const goalId = attributed ? `goal-${opts.id}` : null;
  if (goalId) {
    await handle.db.insert(goals).values({
      id: `g-row-${opts.id}`,
      goalId,
      title: `Objectif ${opts.id}`,
      objective: "preuve d'isolation",
      rawInput: "preuve d'isolation",
      normalizedIntent: "preuve d'isolation",
      metadata: {
        source: "cognitive_conversation",
        ...(opts.clientId ? { clientId: opts.clientId } : {}),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  await handle.db.insert(missions).values({
    id: opts.id,
    title: `Mission ${opts.id}`,
    objective: "preuve d'isolation",
    status: "running",
    goalId,
    userId: opts.userId ?? ME,
    createdAt: now,
    updatedAt: now,
  });
}

const refsFor = async (scope: CognitiveScope) =>
  (await new OperationalStateSource(handle.db).candidates(scope, now)).map((c) => c.ref);

const textFor = async (scope: CognitiveScope) =>
  (await new OperationalStateSource(handle.db).candidates(scope, now)).map((c) => c.text);

beforeEach(async () => {
  if (!handle) {
    handle = openTestDb();
    handles.push(handle);
  }
  await resetCognitive(handle);
});

describe("OperationalStateSource is scoped to the resolved client", () => {
  it("gives a client-scoped conversation only that client's open missions", async () => {
    await seedMission({ id: "m-lds", clientId: LDS });
    await seedMission({ id: "m-mecene", clientId: MECENE });

    expect(await refsFor(scopeOf({ clientId: MECENE }))).toEqual(["runtime:mission.m-mecene"]);
    expect(await refsFor(scopeOf({ clientId: LDS }))).toEqual(["runtime:mission.m-lds"]);
  });

  it("never names another client's mission in the prompt text", async () => {
    await seedMission({ id: "m-lds", clientId: LDS });
    await seedMission({ id: "m-mecene", clientId: MECENE });

    const text = (await textFor(scopeOf({ clientId: MECENE }))).join("\n");
    expect(text).toContain("Mission m-mecene");
    // The exact bleed the review found: the LDS title reaching the Mécène's turn.
    expect(text).not.toContain("Mission m-lds");
  });

  it("leaves out a mission that cannot be attributed to the resolved client", async () => {
    await seedMission({ id: "m-lds", clientId: LDS });
    // No goal row at all, and a goal carrying no clientId: both are unattributable.
    await seedMission({ id: "m-orphan", attributed: false });
    await seedMission({ id: "m-unattributed" });

    expect(await refsFor(scopeOf({ clientId: LDS }))).toEqual(["runtime:mission.m-lds"]);
  });

  it("keeps an UNSCOPED conversation unchanged: the user's whole open workload", async () => {
    await seedMission({ id: "m-lds", clientId: LDS });
    await seedMission({ id: "m-mecene", clientId: MECENE });
    await seedMission({ id: "m-orphan", attributed: false });

    expect((await refsFor(scopeOf())).sort()).toEqual([
      "runtime:mission.m-lds",
      "runtime:mission.m-mecene",
      "runtime:mission.m-orphan",
    ]);
  });

  it("narrows further to the resolved project when there is one", async () => {
    await seedMission({ id: "m-lds-p1", clientId: LDS, projectId: "chantier-1" });
    await seedMission({ id: "m-lds-p2", clientId: LDS, projectId: "chantier-2" });

    expect(await refsFor(scopeOf({ clientId: LDS, projectId: "chantier-2" }))).toEqual([
      "runtime:mission.m-lds-p2",
    ]);
  });

  it("still never crosses users, which is what this stage already guaranteed", async () => {
    await seedMission({ id: "m-mine", clientId: LDS });
    await seedMission({ id: "m-theirs", clientId: LDS, userId: SOMEONE_ELSE });

    expect(await refsFor(scopeOf({ clientId: LDS }))).toEqual(["runtime:mission.m-mine"]);
  });

  it("says WHICH perimeter is empty rather than 'nothing is running'", async () => {
    await seedMission({ id: "m-mecene", clientId: MECENE });

    const [text] = await textFor(scopeOf({ clientId: LDS }));
    expect(text).toContain(LDS);
    // An owner with work elsewhere must not read this as a dead system.
    expect(text).not.toBe("Aucune mission ouverte en cours.");

    await resetCognitive(handle);
    expect(await textFor(scopeOf())).toEqual(["Aucune mission ouverte en cours."]);
  });
});
