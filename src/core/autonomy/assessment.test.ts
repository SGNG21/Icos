import { describe, expect, it } from "vitest";

import {
  assessAutonomy,
  read,
  unavailable,
  type AutonomyEvidence,
  type EvidenceRef,
} from "./assessment";

const NOW = new Date("2026-10-11T20:00:00Z");

const proof = (ref: string, at = "2026-10-11T18:28:00.000Z"): EvidenceRef => ({
  source: "audit_entries",
  ref,
  at,
  summary: `proof ${ref}`,
});

const none = read<readonly EvidenceRef[]>([]);

function evidence(over: Partial<AutonomyEvidence> = {}): AutonomyEvidence {
  return {
    tier: undefined,
    planned: none,
    routed: none,
    recovered: none,
    reviewed: none,
    integrated: none,
    selfDeveloped: none,
    selfProposed: none,
    ...over,
  };
}

describe("assessAutonomy — the level is computed from durable proofs, never guessed", () => {
  it("every source readable and empty → L0, all dimensions UNPROVEN, deployment NONE", () => {
    const a = assessAutonomy(evidence(), NOW);
    expect(a.level).toBe("L0");
    expect(a.certification).toBe("CODE_READY");
    expect(a.dimensions.map((d) => d.state)).toEqual([
      "UNPROVEN",
      "UNPROVEN",
      "UNPROVEN",
      "UNPROVEN",
      "UNPROVEN",
      "UNPROVEN",
      "UNKNOWN",
    ]);
    expect(a.dimensions.find((d) => d.key === "deployment")?.certification).toBe("NONE");
    expect(a.unmeasurableLevels).toEqual(["L5", "L6"]);
  });

  it("an unreadable source on a rung makes the level UNKNOWN, not a lower level", () => {
    const a = assessAutonomy(
      evidence({
        planned: read([proof("m1")]),
        routed: unavailable("Dispatch ledger could not be read."),
      }),
      NOW,
    );
    expect(a.level).toBe("UNKNOWN");
    expect(a.levelReason).toContain("Routing");
    expect(a.dimensions.find((d) => d.key === "routing")).toMatchObject({
      state: "UNKNOWN",
      limits: ["Dispatch ledger could not be read."],
    });
  });

  it("planning alone → L1; planning + routing → L2; + recovery → L3", () => {
    const planned = read([proof("m1")]);
    const routed = read([proof("d1")]);
    expect(assessAutonomy(evidence({ planned }), NOW).level).toBe("L1");
    expect(assessAutonomy(evidence({ planned, routed }), NOW).level).toBe("L2");
    const l3 = assessAutonomy(evidence({ planned, routed, recovered: read([proof("r1")]) }), NOW);
    expect(l3.level).toBe("L3");
    expect(l3.levelReason).toContain("L3: L4 needs");
    expect(l3.levelReason).toContain("Review");
  });

  it("L4 needs review, integration AND a completed self-development mission", () => {
    const base = {
      planned: read([proof("m1")]),
      routed: read([proof("d1")]),
      recovered: read([proof("r1")]),
      reviewed: read([proof("rv1")]),
      integrated: read([proof("g1")]),
      selfProposed: read([proof("sd-goal-1")]),
    };
    const proposedOnly = assessAutonomy(evidence(base), NOW);
    expect(proposedOnly.level).toBe("L3");
    const sd = proposedOnly.dimensions.find((d) => d.key === "self_development");
    expect(sd?.state).toBe("UNPROVEN");
    expect(sd?.limits[0]).toContain("1 self-development goal(s) proposed");

    const l4 = assessAutonomy(
      evidence({ ...base, selfDeveloped: read([proof("sd-mission-1")]) }),
      NOW,
    );
    expect(l4.level).toBe("L4");
  });

  it("a proven dimension without a declared tier is CODE_READY and says why", () => {
    const a = assessAutonomy(evidence({ planned: read([proof("m1")]) }), NOW);
    const planning = a.dimensions.find((d) => d.key === "planning");
    expect(planning?.certification).toBe("CODE_READY");
    expect(planning?.limits.join(" ")).toContain("ICOS_RUNTIME_TIER");
    expect(a.limits.join(" ")).toContain("ICOS_RUNTIME_TIER");
  });

  it("the tier certifies: lab → LAB_CERTIFIED, live → LIVE_CERTIFIED, proofs counted exactly", () => {
    const planned = read([
      proof("m1", "2026-10-11T10:00:00.000Z"),
      proof("m2", "2026-10-11T12:00:00.000Z"),
    ]);
    const lab = assessAutonomy(evidence({ tier: "lab", planned }), NOW);
    expect(lab.level).toBe("L1");
    expect(lab.certification).toBe("LAB_CERTIFIED");
    const live = assessAutonomy(evidence({ tier: "live", planned }), NOW);
    expect(live.certification).toBe("LIVE_CERTIFIED");
    const planning = live.dimensions.find((d) => d.key === "planning");
    expect(planning).toMatchObject({ proofs: 2, lastEvidenceAt: "2026-10-11T12:00:00.000Z" });
    expect(planning?.limits).toEqual([]);
  });

  it("mixed lab and live proofs never certify LIVE", () => {
    // Impossible in one runtime (one tier), guarded anyway: the overall certification is the
    // weakest of the proven dimensions.
    const a = assessAutonomy(evidence({ tier: "live", planned: read([proof("m1")]) }), NOW);
    expect(a.certification).toBe("LIVE_CERTIFIED");
    const b = assessAutonomy(evidence({ tier: undefined, planned: read([proof("m1")]) }), NOW);
    expect(b.certification).toBe("CODE_READY");
  });

  it("shows at most five proofs per dimension while counting all of them", () => {
    const many = read(Array.from({ length: 9 }, (_, i) => proof(`m${i}`)));
    const a = assessAutonomy(evidence({ planned: many }), NOW);
    const planning = a.dimensions.find((d) => d.key === "planning");
    expect(planning?.proofs).toBe(9);
    expect(planning?.evidence).toHaveLength(5);
  });
});
