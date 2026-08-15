"use client";

import { useEffect, useRef, useState } from "react";

import type { ChatMessage, MessageRole } from "@/features/cockpit/types";

import { CkComposer } from "./CkComposer";
import { CkInFlowCard, type CkInFlowCardVariant } from "./CkInFlowCard";
import { CkMessageBubble } from "./CkMessageBubble";
import { CkThinkingState } from "./CkThinkingState";

export interface CkConversationProps {
  messages: ChatMessage[];
  onSend: (message: string) => void;
  disabled?: boolean;
  /** Error-recovery callback, keyed by the message id. */
  onRetry?: (messageId: string) => void;
}

/** Metadata for the four in-flow card roles. */
interface InFlowCardMeta {
  title: string;
  icon: string;
  variant: CkInFlowCardVariant;
}

/**
 * Pure map from an in-flow message role to its card metadata, or null for the
 * plain-text / thinking roles that are not rendered as cards.
 *
 * Extracted so role→card routing is testable without rendering. In CPT-1 the
 * card *bodies* are placeholders: the real children (mission progress,
 * approval, activity timeline, results) arrive in CPT-2/CPT-3. This keeps the
 * conversation honest — it shows that a card belongs here without inventing
 * backend behaviour it cannot yet perform.
 */
export function inFlowCardMeta(role: MessageRole): InFlowCardMeta | null {
  switch (role) {
    case "mission-progress":
      return { title: "Mission en cours", icon: "🎯", variant: "mission" };
    case "approval":
      return { title: "Approbation requise", icon: "🔐", variant: "approval" };
    case "activity":
      return { title: "Activité", icon: "📋", variant: "activity" };
    case "result":
      return { title: "Résultats", icon: "📦", variant: "result" };
    default:
      return null;
  }
}

/**
 * Pure predicate: is the scroll container scrolled meaningfully up from the
 * bottom? Used to decide whether to show the "jump to latest" affordance.
 * Extracted so the threshold logic is testable without a live DOM.
 */
export function isScrolledUp(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 80,
): boolean {
  const distanceFromBottom = scrollHeight - clientHeight - scrollTop;
  return distanceFromBottom > threshold;
}

/**
 * CkConversation — the central chat surface: scrollable message list + fixed
 * composer, with an empty state and a "jump to latest" control.
 *
 * UI only. It renders whatever messages the caller provides and forwards user
 * intent through `onSend` / `onRetry`. It holds no policy, approval, or
 * execution authority and does not fabricate backend state.
 */
export function CkConversation({
  messages,
  onSend,
  disabled = false,
  onRetry,
}: CkConversationProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [scrolledUp, setScrolledUp] = useState(false);

  // Auto-scroll to the newest message whenever the count changes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    setScrolledUp(isScrolledUp(el.scrollTop, el.scrollHeight, el.clientHeight));
  }

  function scrollToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <div className="ck-conversation">
      <div className="ck-message-list" ref={listRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="ck-empty-state">
            <h3>Que veux-tu faire ?</h3>
            <p>
              Décris ton objectif en langage naturel. ICOS planifie, exécute et te rend compte à
              chaque étape.
            </p>
          </div>
        ) : (
          messages.map((msg) => <MessageRow key={msg.id} message={msg} onRetry={onRetry} />)
        )}
        <div ref={bottomRef} />
      </div>

      {scrolledUp ? (
        <button type="button" className="ck-scroll-fab" onClick={scrollToBottom}>
          ↓ Dernier message
        </button>
      ) : null}

      <CkComposer onSend={onSend} disabled={disabled} />
    </div>
  );
}

interface MessageRowProps {
  message: ChatMessage;
  onRetry?: (messageId: string) => void;
}

function MessageRow({ message, onRetry }: MessageRowProps) {
  const { role, content, errorLabel } = message;

  if (role === "user" || role === "icos") {
    return <CkMessageBubble role={role} content={content ?? ""} timestamp={undefined} />;
  }

  if (role === "error") {
    return (
      <CkMessageBubble
        role="error"
        content={content ?? ""}
        actionLabel={errorLabel}
        onAction={onRetry ? () => onRetry(message.id) : undefined}
      />
    );
  }

  if (role === "thinking") {
    return <CkThinkingState />;
  }

  const meta = inFlowCardMeta(role);
  if (meta) {
    return (
      <CkInFlowCard title={meta.title} icon={meta.icon} variant={meta.variant}>
        <p className="ck-inflow-placeholder">Détails disponibles prochainement.</p>
      </CkInFlowCard>
    );
  }

  return null;
}
