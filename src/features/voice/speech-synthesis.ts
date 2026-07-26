import type { VoiceError } from "./types";

export interface SpeechSynthesisController {
  readonly supported: boolean;
  speak(text: string, callbacks?: { onStart?: () => void; onEnd?: () => void; onError?: (error: VoiceError) => void }): void;
  stop(): void;
}

type SynthesisWindow = Window & {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
};

export function pickFrenchVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return voices.find((voice) => voice.lang.toLowerCase().startsWith("fr")) ?? null;
}

export function createSpeechSynthesisController(
  browserWindow: SynthesisWindow | undefined =
    typeof window === "undefined" ? undefined : (window as SynthesisWindow),
): SpeechSynthesisController {
  const synth = browserWindow?.speechSynthesis;
  const Utterance = browserWindow?.SpeechSynthesisUtterance ?? globalThis.SpeechSynthesisUtterance;

  if (!synth || typeof Utterance !== "function") {
    return {
      supported: false,
      speak(_text, callbacks) {
        callbacks?.onError?.({
          code: "unsupported_synthesis",
          message: "La synthèse vocale n’est pas disponible dans ce navigateur.",
        });
      },
      stop() {},
    };
  }

  return {
    supported: true,
    speak(text, callbacks) {
      const cleanText = text.trim();
      if (!cleanText) return;

      // Une seule réponse vocale à la fois : toute phrase précédente est interrompue.
      synth.cancel();

      const utterance = new Utterance(cleanText);
      utterance.lang = "fr-FR";
      const frenchVoice = pickFrenchVoice(synth.getVoices());
      if (frenchVoice) utterance.voice = frenchVoice;
      utterance.onstart = () => callbacks?.onStart?.();
      utterance.onend = () => callbacks?.onEnd?.();
      utterance.onerror = () =>
        callbacks?.onError?.({
          code: "synthesis_error",
          message: "Impossible de lire la réponse à voix haute.",
        });

      synth.speak(utterance);
    },
    stop() {
      synth.cancel();
    },
  };
}
