import { EventQueue } from "../simulated-providers";

import {
  TtsProviderError,
  type SpeechSynthesizer,
  type SynthesisRequest,
  type SynthesisResponse,
  type TtsFailureClass,
  type TtsProviderName,
} from "./synthesizer";

/**
 * Test doubles for the TTS router and its HTTP adapters. SIMULATED: nothing here
 * measures a real provider.
 */

export const flush = () => new Promise((r) => setImmediate(r));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encode = (text: string) => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export type FetchCall = {
  url: string;
  method: string;
  headers: Headers;
  json: Record<string, unknown> | undefined;
  signal: AbortSignal;
  /** Answer with an error status (body never read by the adapter). */
  status(code: number, headers?: Record<string, string>): void;
  /** Answer 200 with a body the test streams chunk by chunk. */
  stream(mime?: string): { push(text: string): void; end(): void };
  reject(error: unknown): void;
};

/** A fetch whose every call waits for the test; abort behaves like real fetch. */
export function scriptedFetch() {
  const calls: FetchCall[] = [];
  const fetch = ((input: string | URL, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init.signal ?? new AbortController().signal;
      let body: ReadableStreamDefaultController<Uint8Array> | null = null;
      signal.addEventListener("abort", () => {
        reject(signal.reason);
        try {
          body?.error(signal.reason);
        } catch {
          // already closed
        }
      });
      calls.push({
        url: String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        json: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        signal,
        status: (code, headers = {}) =>
          resolve(
            new Response('{"detail":"echo of the request: SECRET-IN-BODY"}', {
              status: code,
              headers: { "content-type": "application/json", ...headers },
            }),
          ),
        stream: (mime = "audio/mpeg") => {
          const stream = new ReadableStream<Uint8Array>({ start: (c) => void (body = c) });
          resolve(new Response(stream, { status: 200, headers: { "content-type": mime } }));
          return {
            push: (text) => body?.enqueue(encode(text)),
            end: () => body?.close(),
          };
        },
        reject,
      });
    })) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Drain an adapter's response into a string. */
export async function readAll(response: SynthesisResponse): Promise<string> {
  let out = "";
  for await (const part of response.body) out += decode(part);
  return out;
}

export type Plan =
  | { audio: string | string[] }
  | { fail: TtsFailureClass; status?: number; retryAfterS?: number }
  | "hang"
  | "manual";

export type SynthCall = {
  text: string;
  language: string;
  signal: AbortSignal;
  /** For "manual" plans. */
  respond(): { push(text: string): void; end(): void };
  fail(failure: TtsFailureClass, status?: number): void;
};

/** A scripted synthesizer: plan[i] answers its i-th call (the last plan repeats). */
export class FakeSynth implements SpeechSynthesizer {
  readonly calls: SynthCall[] = [];
  probes = 0;
  probeResult: TtsFailureClass | "ok" = "ok";

  constructor(
    readonly name: TtsProviderName,
    private readonly plan: Plan[] = [{ audio: "a" }],
    readonly streaming = true,
    readonly model = `${name}-model`,
    readonly voice: string | null = `${name}-voice`,
  ) {}

  synthesize(request: SynthesisRequest): Promise<SynthesisResponse> {
    const plan = this.plan[Math.min(this.calls.length, this.plan.length - 1)];
    return new Promise((resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason));
      const respond = () => {
        const queue = new EventQueue<Uint8Array>();
        resolve({ mime: "audio/mpeg", body: queue });
        return { push: (text: string) => queue.push(encode(text)), end: () => queue.end() };
      };
      const fail = (failure: TtsFailureClass, status?: number, retryAfterS?: number) =>
        reject(new TtsProviderError(this.name, failure, status, retryAfterS));
      this.calls.push({
        text: request.text,
        language: request.language,
        signal: request.signal,
        respond,
        fail,
      });
      if (plan === "hang" || plan === "manual") return;
      if ("fail" in plan) return fail(plan.fail, plan.status, plan.retryAfterS);
      const body = respond();
      for (const part of [plan.audio].flat()) body.push(part);
      body.end();
    });
  }

  async probe(): Promise<void> {
    this.probes += 1;
    if (this.probeResult !== "ok") throw new TtsProviderError(this.name, this.probeResult);
  }
}
