"use client";

import { useEffect, useState, type FormEvent } from "react";

type Message = {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export function CommandComposer() {
  const [command, setCommand] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/conversation", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || data.error || "Erreur API");
        setMessages(data.messages || []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Erreur"));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const content = command.trim();
    if (!content || sending) return;

    setSending(true);
    setError("");
    setCommand("");

    try {
      const res = await fetch("/api/conversation", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.message || data.error || `Erreur HTTP ${res.status}`);
      }

      setMessages(data.messages || []);
    } catch (err) {
      setCommand(content);
      setError(err instanceof Error ? err.message : "Erreur d’envoi");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <div className="conversation-stream">
        {messages.length === 0 ? (
          <div className="empty-conversation">
            <div className="orbit-mark" aria-hidden="true">
              <span>i</span>
            </div>
            <h3>Prêt à recevoir une instruction</h3>
            <p>Conversation connectée à ICOS.</p>
          </div>
        ) : (
          <div className="conversation-messages">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`conversation-message conversation-message-${message.role}`}
              >
                <strong>
                  {message.role === "user" ? "Vous" : message.role === "assistant" ? "ICOS" : "Système"}
                </strong>
                <p>{message.content}</p>
              </div>
            ))}

            {sending && (
              <div className="conversation-message conversation-message-assistant">
                <strong>ICOS</strong>
                <p>Analyse en cours…</p>
              </div>
            )}
          </div>
        )}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <label htmlFor="command">Instruction pour ICOS</label>

        <div className="composer-row">
          <input
            id="command"
            value={command}
            disabled={sending}
            placeholder="Parlez à ICOS…"
            onChange={(event) => setCommand(event.target.value)}
          />

          <button type="submit" disabled={sending || !command.trim()}>
            {sending ? "Envoi…" : "Envoyer"}
          </button>
        </div>

        <div className="composer-help">
          <span>{error || "Conversation persistante"}</span>
          <kbd>Entrée</kbd>
        </div>
      </form>
    </>
  );
}
