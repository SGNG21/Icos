"use client";

import { type FormEvent, useState } from "react";

export interface CkComposerProps {
  onSend: (message: string) => void | Promise<void>;
  disabled?: boolean;
  /** Placeholder text — defaults to "Décris ton objectif…". */
  placeholder?: string;
}

/**
 * Pure predicate: can the composer submit the given draft?
 *
 * Extracted so the submit-guard logic is testable without simulating DOM
 * events (CPT-1 uses static-render tests only). A message is sendable when it
 * has non-whitespace content and the composer is not disabled.
 */
export function canSend(draft: string, disabled = false): boolean {
  return !disabled && draft.trim().length > 0;
}

/**
 * CkComposer — message input with send and (placeholder) mic controls.
 *
 * UI only: it collects text and hands it to `onSend`. It has no execution
 * authority and does not itself send anything anywhere. The mic control is a
 * disabled placeholder — voice is explicitly out of scope for CPT-1.
 */
export function CkComposer({
  onSend,
  disabled = false,
  placeholder = "Décris ton objectif…",
}: CkComposerProps) {
  const [draft, setDraft] = useState("");
  const sendable = canSend(draft, disabled);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sendable) return;
    await onSend(draft);
    setDraft("");
  }

  return (
    <form className="ck-composer" onSubmit={handleSubmit}>
      <textarea
        rows={3}
        className="ck-composer-input"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label="Message"
      />
      <button
        type="button"
        className="ck-composer-mic"
        disabled
        title="Bientôt disponible"
        aria-label="Dictée vocale (bientôt disponible)"
      >
        🎙
      </button>
      <button type="submit" className="ck-composer-btn" disabled={!sendable} aria-label="Envoyer">
        ▶
      </button>
    </form>
  );
}
