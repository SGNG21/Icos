/**
 * Speech rendering (decision 0074): what ICOS SAYS is derived from what it WROTE, never
 * generated twice. The displayed text is untouched; only the spoken copy loses markup,
 * code, URLs, machine identifiers and noisy punctuation. Numbers and dates are left as
 * written — the voice reads them better than a rule that could change their meaning.
 */

/** Abbreviations whose trailing dot does not end a sentence (fr + en, lower case). */
const ABBREVIATIONS = new Set([
  "m",
  "mm",
  "mme",
  "mmes",
  "mlle",
  "dr",
  "pr",
  "me",
  "st",
  "ste",
  "etc",
  "cf",
  "ex",
  "env",
  "av",
  "apr",
  "vs",
  "no",
  "n°",
  "mr",
  "mrs",
  "ms",
  "prof",
  "inc",
  "ltd",
  "approx",
  "fig",
  "vol",
  "p",
  "e.g",
  "i.e",
  "p.ex",
  "j.-c",
]);

/** Markdown → plain speakable text. Pure; safe on fragments. */
export function renderSpeech(text: string): string {
  return (
    text
      // Code is shown, not read: a fenced block is dropped whole (an unclosed one to the end).
      .replace(/```[\s\S]*?(?:```|$)/g, " ")
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // A URL stops before trailing punctuation: the sentence keeps its period.
      .replace(/<?\bhttps?:\/\/[^\s>)]*[^\s>).,;:!?]>?/g, " ")
      .replace(/\bwww\.[^\s)]+/g, " ")
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
      .replace(/^[ \t]*>[ \t]?/gm, "")
      .replace(/^[ \t]*[-*+•][ \t]+/gm, "")
      // "1. étape" → "1, étape": an enumeration pause, in any language.
      .replace(/^[ \t]*(\d{1,3})[.)][ \t]+/gm, "$1, ")
      .replace(/^[ \t]*\|?[ \t]*:?-{3,}[-:| \t]*$/gm, "")
      .replace(/[ \t]*\|[ \t]*/g, ", ")
      // Machine identifiers are telemetry, not speech.
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
      .replace(/\b[0-9a-f]{16,}\b/gi, " ")
      .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, " ")
      // NOT_CONNECTED-style codes: read aloud they also flip a voice's language guess.
      .replace(/\(?\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b\)?/g, " ")
      .replace(/(\w)_(?=\w)/g, "$1 ")
      .replace(/[*_~`#>]+/g, "")
      .replace(/([!?])[!?]+/g, "$1")
      .replace(/\.{3,}/g, "…")
      .replace(/([,;:])(?:\s*\1)+/g, "$1")
      .replace(/\(\s*\)/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[,;:]\s*\./g, ".")
      .replace(/\s+([.,])/g, "$1")
      .replace(/^[\s,.;:]+/, "")
      .replace(/[\s,]+$/, "")
      .trim()
  );
}

export type ChunkingOptions = {
  /** Smallest chunk sent to a provider (except the last one of an answer). */
  minChars: number;
  /** The first chunk may be shorter: first audio sooner. */
  firstMinChars: number;
  /** A chunk is split at a soft boundary (, ; :) or a space beyond this. */
  maxChars: number;
};

export const DEFAULT_CHUNKING: ChunkingOptions = { minChars: 40, firstMinChars: 20, maxChars: 220 };

/** One request per sentence, whatever its length: the pre-router behaviour. */
export const SENTENCE_CHUNKING: ChunkingOptions = { minChars: 0, firstMinChars: 0, maxChars: 400 };

/**
 * A hard boundary: sentence punctuation before whitespace ("3.14" and URLs stay whole),
 * or a line break (list items, paragraphs, headings).
 */
const HARD_BOUNDARY = /[.!?…]+(?=\s)|\n/g;

function isAbbreviation(text: string, dotAt: number): boolean {
  if (text[dotAt] !== ".") return false;
  const word = /([\p{L}°][\p{L}.°-]*)$/u.exec(text.slice(0, dotAt))?.[1];
  if (!word) return false;
  // A single capital is an initial ("J. Dupont"); a lower-case single letter is not ("a.").
  if (/^\p{Lu}$/u.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** Split `text` into pieces of at most `max` chars, at the last soft boundary or space. */
export function splitLong(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    const soft = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
    const space = head.lastIndexOf(" ");
    const cut = soft > max / 3 ? soft + 1 : space > 0 ? space : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Turns a streamed answer (markdown deltas) into speakable chunks at natural boundaries:
 * never one request per token, never a whole paragraph before the first audio.
 */
export class SpeechChunker {
  private raw = "";
  private pending = "";
  private emitted = 0;

  constructor(private readonly options: ChunkingOptions = DEFAULT_CHUNKING) {}

  push(delta: string): string[] {
    this.raw += delta;
    return this.drain(false);
  }

  /** End of the answer: everything left is spoken (an unclosed code block is not). */
  flush(): string[] {
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    // Closed code blocks never reach a voice; an open one holds the stream until it closes.
    this.raw = this.raw.replace(/```[\s\S]*?```/g, "\n");
    const fence = this.raw.indexOf("```");
    let region = fence >= 0 ? this.raw.slice(0, fence) : this.raw;
    let held = fence >= 0 ? this.raw.slice(fence) : "";
    if (!final && fence < 0) {
      // A trailing "`" or "``" may be the start of a fence still arriving.
      const ticks = /`{1,2}$/.exec(region);
      if (ticks) {
        held = ticks[0];
        region = region.slice(0, -ticks[0].length);
      }
    }
    if (final) held = ""; // an unclosed fence at the end is dropped, not read

    let start = 0;
    HARD_BOUNDARY.lastIndex = 0;
    for (let m = HARD_BOUNDARY.exec(region); m; m = HARD_BOUNDARY.exec(region)) {
      const end = m.index + m[0].length;
      if (m[0] !== "\n" && isAbbreviation(region, m.index)) continue;
      this.take(region.slice(start, end), m[0] === "\n", out);
      start = end;
    }
    let tail = region.slice(start);
    if (final) {
      this.take(tail, false, out);
      tail = "";
      if (this.pending) out.push(...this.emit(this.pending));
      this.pending = "";
    } else if (tail.length > this.options.maxChars) {
      // A very long run without punctuation: speak its head rather than wait.
      const pieces = splitLong(tail, this.options.maxChars);
      tail = pieces.pop() ?? "";
      for (const piece of pieces) this.take(piece, false, out);
    }
    this.raw = tail + held;
    return out;
  }

  private take(segment: string, lineEnd: boolean, out: string[]): void {
    let spoken = renderSpeech(segment);
    if (!spoken) return;
    // A line without punctuation (heading, list item) still deserves a pause.
    if (lineEnd && !/[.!?…:;,]$/.test(spoken)) spoken += ".";
    const { minChars, firstMinChars, maxChars } = this.options;
    if (this.pending && this.pending.length + 1 + spoken.length > maxChars) {
      out.push(...this.emit(this.pending));
      this.pending = "";
    }
    this.pending = this.pending ? `${this.pending} ${spoken}` : spoken;
    if (this.pending.length >= (this.emitted === 0 ? firstMinChars : minChars)) {
      out.push(...this.emit(this.pending));
      this.pending = "";
    }
  }

  private emit(text: string): string[] {
    const pieces = splitLong(text, this.options.maxChars);
    this.emitted += pieces.length;
    return pieces;
  }
}
