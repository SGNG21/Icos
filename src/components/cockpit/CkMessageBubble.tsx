"use client";

export interface CkMessageBubbleProps {
  role: "user" | "icos" | "error";
  content: string;
  timestamp?: string;
  /** Action label — e.g. "Réessayer" for error messages. */
  actionLabel?: string;
  onAction?: () => void;
}

const roleClass: Record<CkMessageBubbleProps["role"], string> = {
  user: "ck-message-user",
  icos: "ck-message-icos",
  error: "ck-message-error",
};

/**
 * CkMessageBubble — a single conversation message.
 *
 * Display only: it renders text the caller passes in. It carries no backend
 * authority and does not itself perform the action behind `onAction` — that
 * callback is owned by the caller.
 */
export function CkMessageBubble({
  role,
  content,
  timestamp,
  actionLabel,
  onAction,
}: CkMessageBubbleProps) {
  return (
    <div className={`ck-message-bubble ${roleClass[role]}`}>
      {role === "error" ? (
        <span className="ck-message-error-icon" aria-hidden="true">
          ⚠
        </span>
      ) : null}
      <span>{content}</span>
      {actionLabel && onAction ? (
        <button type="button" className="ck-message-action" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {timestamp ? <span className="ck-message-timestamp">{timestamp}</span> : null}
    </div>
  );
}
