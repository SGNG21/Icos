import type { VoiceError } from "./types";

interface BrowserSpeechRecognitionAlternative {
  transcript: string;
}

interface BrowserSpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: BrowserSpeechRecognitionAlternative;
}

interface BrowserSpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechRecognitionResult>;
}

interface BrowserSpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface BrowserSpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface BrowserSpeechRecognitionConstructor {
  new (): BrowserSpeechRecognitionInstance;
}

type BrowserWindow = Window & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

export interface SpeechRecognitionHandlers {
  onStart?: () => void;
  onInterimTranscript?: (transcript: string) => void;
  onFinalTranscript: (transcript: string) => void;
  onError?: (error: VoiceError) => void;
  onEnd?: () => void;
}

export interface SpeechRecognitionController {
  readonly supported: boolean;
  start(): void;
  stop(): void;
  abort(): void;
}

export function recognitionError(error: string): VoiceError {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return {
      code: "permission_denied",
      message: "Accès au microphone refusé. Autorisez le microphone dans Chrome.",
    };
  }

  if (error === "no-speech") {
    return {
      code: "no_speech",
      message: "Aucune parole détectée. Réessayez en parlant après l’activation du micro.",
    };
  }

  return {
    code: "recognition_error",
    message: `Reconnaissance vocale indisponible (${error || "erreur inconnue"}).`,
  };
}

export function extractTranscripts(event: BrowserSpeechRecognitionEvent): {
  interim: string;
  final: string;
} {
  let interim = "";
  let final = "";

  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const transcript = result?.[0]?.transcript?.trim() ?? "";
    if (!transcript) continue;

    if (result.isFinal) {
      final = `${final} ${transcript}`.trim();
    } else {
      interim = `${interim} ${transcript}`.trim();
    }
  }

  return { interim, final };
}

export function createSpeechRecognitionController(
  handlers: SpeechRecognitionHandlers,
  browserWindow: BrowserWindow | undefined =
    typeof window === "undefined" ? undefined : (window as BrowserWindow),
): SpeechRecognitionController {
  const Constructor =
    browserWindow?.SpeechRecognition ?? browserWindow?.webkitSpeechRecognition;

  if (!Constructor) {
    return {
      supported: false,
      start() {
        handlers.onError?.({
          code: "unsupported_recognition",
          message: "La reconnaissance vocale n’est pas disponible dans ce navigateur.",
        });
      },
      stop() {},
      abort() {},
    };
  }

  const recognition = new Constructor();
  recognition.lang = "fr-FR";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => handlers.onStart?.();
  recognition.onresult = (event) => {
    const { interim, final } = extractTranscripts(event);
    if (interim) handlers.onInterimTranscript?.(interim);
    if (final) handlers.onFinalTranscript(final);
  };
  recognition.onerror = (event) => handlers.onError?.(recognitionError(event.error));
  recognition.onend = () => handlers.onEnd?.();

  return {
    supported: true,
    start() {
      recognition.start();
    },
    stop() {
      recognition.stop();
    },
    abort() {
      recognition.abort();
    },
  };
}
