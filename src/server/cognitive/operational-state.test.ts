import { describe, expect, it } from "vitest";

import type { CognitiveScope } from "@/core/cognitive/contracts";
import type { ContextCandidate } from "@/core/cognitive/context-selection";

import { CombinedSelfModel } from "./operational-state";
import type { SelfModelSource } from "./context-assembler";

const now = new Date("2026-10-01T18:30:00.000Z");
const scope: CognitiveScope = {
  tenantId: "default",
  userId: "geoffrey",
  clientId: null,
  projectId: null,
};

const fact = (ref: string): ContextCandidate => ({
  stage: "runtime",
  kind: "runtime_state",
  ref,
  text: `fait ${ref}`,
  anchored: true,
  entityIds: [],
  occurredAt: now.toISOString(),
  confidence: 1,
  epistemic: "TOOL_CONFIRMED",
  trust: "trusted",
});

const source = (refs: string[]): SelfModelSource => ({
  candidates: async () => refs.map(fact),
});
const broken: SelfModelSource = {
  candidates: async () => {
    throw new Error("overlay down");
  },
};

describe("CombinedSelfModel: a missing overlay is silence, never invention", () => {
  it("merges every overlay's facts", async () => {
    const combined = new CombinedSelfModel([source(["runtime:a"]), source(["runtime:b"])]);
    expect((await combined.candidates(scope, now)).map((c) => c.ref)).toEqual([
      "runtime:a",
      "runtime:b",
    ]);
  });

  it("keeps the surviving overlays when one throws, and invents nothing for it", async () => {
    const combined = new CombinedSelfModel([broken, source(["runtime:b"])]);
    const refs = (await combined.candidates(scope, now)).map((c) => c.ref);
    expect(refs).toEqual(["runtime:b"]);
  });

  it("returns nothing at all rather than a guess when every overlay fails", async () => {
    const combined = new CombinedSelfModel([broken, broken]);
    expect(await combined.candidates(scope, now)).toEqual([]);
  });

  it("passes the asking user's scope down, so state cannot cross users", async () => {
    const seen: CognitiveScope[] = [];
    const spy: SelfModelSource = {
      candidates: async (s) => {
        seen.push(s);
        return [];
      },
    };
    await new CombinedSelfModel([spy]).candidates(scope, now);
    expect(seen).toEqual([scope]);
    expect(seen[0].userId).toBe("geoffrey");
  });
});
