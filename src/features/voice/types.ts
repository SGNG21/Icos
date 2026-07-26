export type VoiceState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

export interface VoiceError {
  code:
    | "unsupported_recognition"
    | "unsupported_synthesis"
    | "permission_denied"
    | "no_speech"
    | "recognition_error"
    | "synthesis_error";
  message: string;
}

export interface VoiceSnapshot {
  state: VoiceState;
  interimTranscript: string;
  error: VoiceError | null;
}
