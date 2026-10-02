import { describe, expect, it } from "vitest";

import { createVad, DEFAULT_VAD, rms, type VadEvent } from "./vad";

/** 20 ms de trame à 16 kHz : la taille réelle envoyée par le tap audio. */
const SAMPLE_RATE = 16_000;
const FRAME = (SAMPLE_RATE * 20) / 1000;

const frame = (amplitude: number) => {
  const samples = new Float32Array(FRAME);
  /* Alternance ±amplitude : RMS == amplitude exactement, donc les seuils sont lisibles. */
  for (let i = 0; i < samples.length; i += 1) samples[i] = i % 2 === 0 ? amplitude : -amplitude;
  return samples;
};

/** Pousse `ms` de signal et rend les évènements franchis, dans l'ordre. */
const feed = (vad: ReturnType<typeof createVad>, amplitude: number, ms: number): VadEvent[] => {
  const events: VadEvent[] = [];
  for (let elapsed = 0; elapsed < ms; elapsed += 20) {
    const event = vad.push(frame(amplitude), SAMPLE_RATE);
    if (event) events.push(event);
  }
  return events;
};

const LOUD = DEFAULT_VAD.startThreshold * 2;
const QUIET = DEFAULT_VAD.endThreshold / 2;
/** Entre les deux seuils : ne DÉMARRE pas un énoncé, n'en TERMINE pas un non plus. */
const BETWEEN = (DEFAULT_VAD.startThreshold + DEFAULT_VAD.endThreshold) / 2;

describe("VAD local — segmente les tours sans aucun clic", () => {
  it("détecte le début de parole une fois la durée minimale tenue", () => {
    const vad = createVad();
    /* Moins que `minSpeechMs` : rien encore, un claquement n'est pas un tour. */
    expect(feed(vad, LOUD, DEFAULT_VAD.minSpeechMs - 40)).toEqual([]);
    expect(feed(vad, LOUD, 60)).toEqual(["SPEECH_START"]);
    expect(vad.speaking).toBe(true);
  });

  it("ignore un bruit BREF, si fort soit-il", () => {
    const vad = createVad();
    expect(feed(vad, 1, 40)).toEqual([]); // 40 ms de saturation
    expect(feed(vad, QUIET, 200)).toEqual([]);
    expect(vad.speaking).toBe(false);
  });

  it("une PAUSE entre deux mots ne termine pas l'énoncé", () => {
    const vad = createVad();
    feed(vad, LOUD, 300);
    expect(vad.speaking).toBe(true);
    /* Un silence plus court que le hangover : l'énoncé continue. */
    expect(feed(vad, QUIET, DEFAULT_VAD.hangoverMs - 100)).toEqual([]);
    expect(vad.speaking).toBe(true);
    /* Et la parole qui reprend réarme le compteur. */
    feed(vad, LOUD, 100);
    expect(feed(vad, QUIET, DEFAULT_VAD.hangoverMs - 100)).toEqual([]);
    expect(vad.speaking).toBe(true);
  });

  it("termine l'énoncé après un silence FRANC", () => {
    const vad = createVad();
    feed(vad, LOUD, 300);
    expect(feed(vad, QUIET, DEFAULT_VAD.hangoverMs + 40)).toEqual(["SPEECH_END"]);
    expect(vad.speaking).toBe(false);
  });

  it("HYSTÉRÉSIS : entre les deux seuils, l'état ne clignote jamais", () => {
    const vad = createVad();
    /* Hors parole, un niveau intermédiaire ne démarre rien, même longtemps. */
    expect(feed(vad, BETWEEN, 2_000)).toEqual([]);
    expect(vad.speaking).toBe(false);
    /* En parole, le même niveau ne termine rien : c'est tout l'intérêt des deux seuils. */
    feed(vad, LOUD, 300);
    expect(feed(vad, BETWEEN, 2_000)).toEqual([]);
    expect(vad.speaking).toBe(true);
  });

  it("enchaîne plusieurs énoncés : c'est ce qui rend la conversation continue", () => {
    const vad = createVad();
    const events: VadEvent[] = [];
    for (let i = 0; i < 3; i += 1) {
      events.push(...feed(vad, LOUD, 300));
      events.push(...feed(vad, QUIET, DEFAULT_VAD.hangoverMs + 40));
    }
    expect(events).toEqual([
      "SPEECH_START",
      "SPEECH_END",
      "SPEECH_START",
      "SPEECH_END",
      "SPEECH_START",
      "SPEECH_END",
    ]);
  });

  it("`reset` oublie tout : après un barge-in on repart propre", () => {
    const vad = createVad();
    feed(vad, LOUD, 300);
    expect(vad.speaking).toBe(true);
    vad.reset();
    expect(vad.speaking).toBe(false);
    /* Et il faut de nouveau tenir `minSpeechMs` : rien n'est hérité. */
    expect(feed(vad, LOUD, DEFAULT_VAD.minSpeechMs - 40)).toEqual([]);
  });

  it("REFUSE une configuration sans hystérésis au lieu de clignoter", () => {
    expect(() => createVad({ ...DEFAULT_VAD, endThreshold: DEFAULT_VAD.startThreshold })).toThrow(
      /VAD_CONFIG_INVALID/,
    );
    expect(() => createVad({ ...DEFAULT_VAD, endThreshold: 1 })).toThrow(/VAD_CONFIG_INVALID/);
  });

  it("une trame vide ou un taux absurde ne produit rien", () => {
    const vad = createVad();
    expect(vad.push(new Float32Array(0), SAMPLE_RATE)).toBeNull();
    expect(vad.push(frame(LOUD), 0)).toBeNull();
  });

  it("rms d'un silence est 0, rms d'un signal saturé est 1", () => {
    expect(rms(new Float32Array(FRAME))).toBe(0);
    expect(rms(frame(1))).toBeCloseTo(1, 10);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
