import { describe, expect, it } from "vitest";

import { PlaybackGate } from "./playback-gate";

describe("PlaybackGate — each chunk plays once, in order, for the current speech only", () => {
  it("plays chunks in order and rejects a duplicate or a replay", () => {
    const g = new PlaybackGate();
    expect(g.admit({ turnId: "A", generation: 1, seq: 0 })).toBe("play");
    expect(g.admit({ turnId: "A", generation: 1, seq: 1 })).toBe("play");
    expect(g.admit({ turnId: "A", generation: 1, seq: 1 })).toBe("duplicate");
    expect(g.admit({ turnId: "A", generation: 1, seq: 0 })).toBe("duplicate");
    expect(g.admit({ turnId: "A", generation: 1, seq: 2 })).toBe("play");
  });

  it("an older generation of the same turn is stale; a newer one restarts at seq 0", () => {
    const g = new PlaybackGate();
    g.admit({ turnId: "A", generation: 1, seq: 0 });
    g.admit({ turnId: "A", generation: 1, seq: 1 });
    expect(g.admit({ turnId: "A", generation: 2, seq: 0 })).toBe("play");
    expect(g.admit({ turnId: "A", generation: 1, seq: 2 })).toBe("stale");
  });

  it("barge-in: a silenced turn never plays again, whatever arrives late", () => {
    const g = new PlaybackGate();
    g.admit({ turnId: "A", generation: 1, seq: 0 });
    g.silence("A");
    expect(g.admit({ turnId: "A", generation: 1, seq: 1 })).toBe("silenced");
    expect(g.admit({ turnId: "A", generation: 2, seq: 0 })).toBe("silenced");
    expect(g.isSilenced("A")).toBe(true);
  });

  it("once a newer turn speaks, the older turn's queued audio never resumes", () => {
    const g = new PlaybackGate();
    g.admit({ turnId: "A", generation: 1, seq: 0 });
    expect(g.admit({ turnId: "B", generation: 2, seq: 0 })).toBe("play");
    expect(g.admit({ turnId: "A", generation: 1, seq: 1 })).toBe("silenced");
  });

  it("a second turn after a barge-in plays normally", () => {
    const g = new PlaybackGate();
    g.admit({ turnId: "A", generation: 1, seq: 0 });
    g.silence("A");
    expect(g.admit({ turnId: "B", generation: 2, seq: 0 })).toBe("play");
    expect(g.admit({ turnId: "B", generation: 2, seq: 1 })).toBe("play");
  });

  it("a skipped seq does not block later chunks (WebSocket keeps order; a gap is a skip)", () => {
    const g = new PlaybackGate();
    g.admit({ turnId: "A", seq: 0 });
    expect(g.admit({ turnId: "A", seq: 2 })).toBe("play");
    expect(g.admit({ turnId: "A", seq: 1 })).toBe("duplicate"); // never behind a later one
  });

  it("works with a server that sends no generation", () => {
    const g = new PlaybackGate();
    expect(g.admit({ turnId: "A", seq: 0 })).toBe("play");
    expect(g.admit({ turnId: "A", seq: 0 })).toBe("duplicate");
  });

  it("memory is bounded; recently superseded turns stay silenced", () => {
    const g = new PlaybackGate();
    for (let i = 0; i < 200; i++) g.admit({ turnId: `T${i}`, seq: 0 });
    expect(g.admit({ turnId: "T198", seq: 1 })).toBe("silenced");
    expect(g.admit({ turnId: "T199", seq: 1 })).toBe("play");
  });
});
