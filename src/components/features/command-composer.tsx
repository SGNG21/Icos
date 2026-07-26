"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { useVoiceSession } from "@/features/voice/use-voice-session";

interface ConversationResponse {
  reply?: string;
  message?: string;
}

export function CommandComposer() {
  const voiceRef = useRef<ReturnType<typeof useVoiceSession> | null>(null);
  const [command, setCommand] = useState("");
  const [answer, setAnswer] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submitCommand = useCallback(async (rawCommand: string) => {
    const nextCommand = rawCommand.trim();
    if (!nextCommand || submitting) return;

    setSubmitting(true);
    setNotice("ICOS réfléchit…");
    setAnswer("");

    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: nextCommand }),
      });
      const data = (await response.json()) as ConversationResponse;

      if (!response.ok || !data.reply) {
        throw new Error(data.message || "ICOS n’a pas pu répondre.");
      }

      setAnswer(data.reply);
      setNotice("Réponse reçue.");
      return data.reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Erreur de conversation.";
      setNotice(message);
      return undefined;
    } finally {
      setSubmitting(false);
    }
  }, [submitting]);

  const handleVoiceTranscript = useCallback(
    async (transcript: string) => {
      setCommand(transcript);
      const reply = await submitCommand(transcript);
      if (reply) voiceRef.current?.speak(reply);
      else voiceRef.current?.markIdle();
    },
    [submitCommand],
  );

  // The hook stays the only owner of microphone/TTS browser APIs.
  const voice = useVoiceSession({ onFinalTranscript: handleVoiceTranscript });

  // keep ref in sync outside of render — the ref is read from event handlers
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    voice.markThinking();
    const reply = await submitCommand(command);
    if (reply) voice.speak(reply);
    else voice.markIdle();
  }

  const voiceLabel =
    voice.state === "listening"
      ? "Écoute…"
      : voice.state === "transcribing"
        ? "Transcription…"
        : voice.state === "thinking"
          ? "Réflexion…"
          : voice.state === "speaking"
            ? "ICOS parle…"
            : voice.error?.message;

  return (
    <div className="conversation-composer-stack">
      {answer ? (
        <div className="voice-answer" aria-live="polite">
          <span className="voice-answer-label">ICOS</span>
          <p>{answer}</p>
        </div>
      ) : null}

      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="command">Instruction pour ICOS</label>
        <div className="composer-row">
          <input
            id="command"
            onChange={(event) => {
              setCommand(event.target.value);
              setNotice("");
            }}
            placeholder="Parlez ou écrivez à ICOS…"
            type="text"
            value={voice.interimTranscript || command}
          />

          {voice.recognitionSupported ? (
            <button
              className={voice.state === "listening" || voice.state === "transcribing" ? "voice-button active" : "voice-button"}
              onClick={() => {
                if (voice.state === "listening" || voice.state === "transcribing") {
                  voice.stopListening();
                } else {
                  voice.startListening();
                }
              }}
              type="button"
              aria-label="Parler à ICOS"
              title="Parler à ICOS"
            >
              {voice.state === "listening" || voice.state === "transcribing" ? "■" : "🎙"}
            </button>
          ) : null}

          {voice.state === "speaking" ? (
            <button className="voice-stop-button" onClick={voice.stopSpeaking} type="button">
              Stop voix
            </button>
          ) : null}

          <button disabled={submitting || !command.trim()} type="submit">
            {submitting ? "Réflexion…" : "Envoyer"}
          </button>
        </div>

        <div className="composer-help" aria-live="polite">
          <span>
            {voiceLabel ||
              notice ||
              (voice.recognitionSupported
                ? "Micro Chrome prêt · aucune action externe depuis Voice V0"
                : "Micro non pris en charge · saisie texte disponible")}
          </span>
          <kbd>Entrée</kbd>
        </div>
      </form>
    </div>
  );
}
