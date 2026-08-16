"use client";

export interface CkThinkingStateProps {
  /** Accessible label — defaults to "Réflexion en cours…". */
  label?: string;
}

/**
 * CkThinkingState — inline "thinking" indicator (three pulsing dots).
 *
 * Purely visual. It represents that a response is pending; it does not itself
 * poll, stream, or know anything about backend state. Animation lives in the
 * existing `.ck-thinking` CSS (CPT-0 foundation).
 */
export function CkThinkingState({ label = "Réflexion en cours…" }: CkThinkingStateProps) {
  return (
    <div className="ck-thinking" role="status" aria-label={label}>
      <span className="ck-thinking-dot" aria-hidden="true" />
      <span className="ck-thinking-dot" aria-hidden="true" />
      <span className="ck-thinking-dot" aria-hidden="true" />
    </div>
  );
}
