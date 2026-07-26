"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { createSpeechRecognitionController } from "./speech-recognition";
import { createSpeechSynthesisController } from "./speech-synthesis";
import type { VoiceError, VoiceState } from "./types";

interface UseVoiceSessionOptions {
  onFinalTranscript: (transcript: string) => void | Promise<void>;
}

/**
 * Souscription stable no-op : la capacité vocale est déterminée une fois
 * côté client et ne change pas ensuite. `useSyncExternalStore` sert ici
 * uniquement à lire une valeur client-only sans mismatch d'hydratation
 * (snapshot serveur = false, snapshot client = capacité réelle).
 */
const noopSubscribe = () => () => {};

export function useVoiceSession({ onFinalTranscript }: UseVoiceSessionOptions) {
  const [state, setState] = useState<VoiceState>("idle");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [error, setError] = useState<VoiceError | null>(null);

  const synthesis = useMemo(() => createSpeechSynthesisController(), []);

  const recognition = useMemo(
    () =>
      createSpeechRecognitionController({
        onStart() {
          setError(null);
          setInterimTranscript("");
          setState("listening");
        },
        onInterimTranscript(transcript) {
          setInterimTranscript(transcript);
          setState("transcribing");
        },
        onFinalTranscript(transcript) {
          setInterimTranscript("");
          setState("thinking");
          void Promise.resolve(onFinalTranscript(transcript)).catch(() => {
            // cleanup effect calls recognition.abort() which prevents
            // callbacks from firing on an unmounted component.
            setError({
              code: "recognition_error",
              message: "La commande vocale n’a pas pu être envoyée à ICOS.",
            });
            setState("error");
          });
        },
        onError(nextError) {
          setError(nextError);
          setState("error");
        },
        onEnd() {
          setInterimTranscript("");
          setState((current) =>
            current === "listening" || current === "transcribing" ? "idle" : current,
          );
        },
      }),
    [onFinalTranscript],
  );

  const recognitionSupported = useSyncExternalStore(
    noopSubscribe,
    () => recognition.supported,
    () => false,
  );
  const synthesisSupported = useSyncExternalStore(
    noopSubscribe,
    () => synthesis.supported,
    () => false,
  );

  useEffect(() => {
    return () => {
      recognition.abort();
      synthesis.stop();
    };
  }, [recognition, synthesis]);

  const startListening = useCallback(() => {
    setError(null);
    synthesis.stop();
    recognition.start();
  }, [recognition, synthesis]);

  const stopListening = useCallback(() => recognition.stop(), [recognition]);

  const speak = useCallback(
    (text: string) => {
      synthesis.speak(text, {
        onStart: () => setState("speaking"),
        onEnd: () => setState("idle"),
        onError: (nextError) => {
          setError(nextError);
          setState("error");
        },
      });
    },
    [synthesis],
  );

  const stopSpeaking = useCallback(() => {
    synthesis.stop();
    setState("idle");
  }, [synthesis]);

  const markThinking = useCallback(() => setState("thinking"), []);
  const markIdle = useCallback(() => setState("idle"), []);

  return {
    state,
    error,
    interimTranscript,
    recognitionSupported,
    synthesisSupported,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    markThinking,
    markIdle,
  };
}
