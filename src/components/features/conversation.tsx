"use client";

import { useEffect, useState, useRef } from "react";
import type { Message } from "@/core/ceo/contracts";

export default function Conversation() {
  const [conversation, setConversation] = useState<{ id: string; title: string } | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load conversation and messages on mount
  useEffect(() => {
    async function loadConversation() {
      try {
        const res = await fetch("/api/conversation");
        if (!res.ok) {
          throw new Error(`Failed to load conversation: ${res.status}`);
        }
        const data = await res.json();
        setConversation(data.conversation);
        setMessages(data.messages);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    loadConversation();
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !conversation) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/conversation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: input }),
      });
      if (!res.ok) {
        throw new Error(`Failed to send message: ${res.status}`);
      }
      const data = await res.json();
      // Update messages with the latest from the server
      setMessages(data.messages);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (error) {
    return (
      <section className="conversation-panel">
        <div className="panel-heading compact">
          <div>
            <p className="eyebrow">Conversation CEO</p>
            <h2>Erreur</h2>
          </div>
        </div>
        <div className="conversation-error">{error}</div>
      </section>
    );
  }

  if (!conversation) {
    return <div className="conversation-panel">Chargement de la conversation...</div>;
  }

  return (
    <section className="conversation-panel" id="conversation">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Conversation CEO</p>
          <h2>{conversation.title}</h2>
        </div>
      </div>
      <div
        className="conversation-messages"
        style={{ height: "60vh", overflowY: "auto", marginBottom: "1rem" }}
      >
        {messages.map((msg, idx) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-content">{msg.content}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>
      <form onSubmit={handleSend} className="conversation-form">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Envoyer un message au CEO..."
          disabled={sending}
        />
        <button type="submit" disabled={sending || !input.trim()}>
          {sending ? "Envoi..." : "Envoyer"}
        </button>
      </form>
    </section>
  );
}
