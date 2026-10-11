/**
 * Which audio chunk may play (decision 0074). Pure: no DOM, no audio APIs.
 *
 * A chunk plays only when it belongs to the newest speech the client has accepted:
 * - a silenced turn (barge-in, cancel, playback_stop) never plays again;
 * - once a newer turn has started speaking, every older turn is silenced;
 * - within a turn, an older generation (the answer before a re-answer) is stale;
 * - within a generation, each seq plays once and never behind a later one.
 * WebSocket order is preserved, so a gap only means the server skipped a chunk: the
 * gate lets later chunks through rather than waiting for one that will never come.
 */

export type PlaybackVerdict = "play" | "silenced" | "stale" | "duplicate";

export type AudioChunkRef = { turnId: string; generation?: number; seq: number };

/** Turns remembered; far beyond what one conversation screen shows. */
const MAX_TURNS = 50;

export class PlaybackGate {
  private readonly silenced = new Set<string>();
  /** Turn → its current generation and the next seq it may play. */
  private readonly turns = new Map<string, { generation: number; nextSeq: number }>();
  private latest: string | null = null;

  admit(chunk: AudioChunkRef): PlaybackVerdict {
    if (this.silenced.has(chunk.turnId)) return "silenced";
    const generation = chunk.generation ?? 0;
    let state = this.turns.get(chunk.turnId);
    if (!state) {
      state = { generation, nextSeq: 0 };
      this.turns.set(chunk.turnId, state);
    }
    if (generation < state.generation) return "stale";
    if (generation > state.generation) {
      state.generation = generation;
      state.nextSeq = 0;
    }
    if (chunk.seq < state.nextSeq) return "duplicate";
    state.nextSeq = chunk.seq + 1;
    if (this.latest !== chunk.turnId) {
      // A newer turn speaks: whatever an older turn still had queued must never resume.
      if (this.latest !== null) this.silence(this.latest);
      this.latest = chunk.turnId;
    }
    return "play";
  }

  /** Barge-in / cancel / playback_stop: this turn's audio is over for good. */
  silence(turnId: string): void {
    this.turns.delete(turnId);
    this.silenced.delete(turnId); // re-insert: the set stays in recency order
    this.silenced.add(turnId);
    if (this.latest === turnId) this.latest = null;
    for (const set of [this.silenced, this.turns]) {
      while (set.size > MAX_TURNS) {
        const oldest = set.keys().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
      }
    }
  }

  isSilenced(turnId: string): boolean {
    return this.silenced.has(turnId);
  }
}
