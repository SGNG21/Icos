import type { ReactNode } from "react";

export type CkInFlowCardVariant = "mission" | "approval" | "activity" | "result";

export interface CkInFlowCardProps {
  title: string;
  icon?: string;
  children: ReactNode;
  variant?: CkInFlowCardVariant;
}

/**
 * CkInFlowCard — generic wrapper for cards embedded in the conversation flow
 * (mission progress, approval, activity, result).
 *
 * Presentational shell only: title bar + variant accent + content slot. It
 * assigns no meaning and grants no authority; the child decides what is shown
 * and the caller owns any behaviour.
 */
export function CkInFlowCard({
  title,
  icon,
  children,
  variant = "mission",
}: CkInFlowCardProps) {
  return (
    <section className={`ck-inflow-card ${variant}`}>
      <header className="ck-inflow-card-header">
        {icon ? <span aria-hidden="true">{icon}</span> : null}
        <span>{title}</span>
      </header>
      <div className="ck-inflow-card-body">{children}</div>
    </section>
  );
}
