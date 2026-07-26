import type { ReactNode } from "react";

export interface CkShellProps {
  sidebar: ReactNode;
  conversation: ReactNode;
  /** Optional footer bar — receives the CkMissionProgress footer variant. */
  footerBar?: ReactNode;
  /** Optional top-bar right slot — user identity / settings trigger. */
  topBarRight?: ReactNode;
}

/**
 * CkShell — cockpit layout wrapper.
 *
 * Grid layout: sidebar column + main column. A top bar carries the ICOS brand
 * on the left and an optional right slot (user/settings). The main column holds
 * the conversation; an optional footer bar sits below it.
 *
 * UI-only: this component holds no policy, approval, or execution authority.
 */
export function CkShell({ sidebar, conversation, footerBar, topBarRight }: CkShellProps) {
  return (
    <div className="ck-shell">
      <aside className="ck-shell-sidebar">{sidebar}</aside>
      <div className="ck-shell-main">
        <header className="ck-topbar">
          <span className="ck-brand" aria-label="ICOS">
            ICOS<span aria-hidden="true">_</span>
          </span>
          {topBarRight ? <div className="ck-topbar-right">{topBarRight}</div> : null}
        </header>
        <main className="ck-shell-content">{conversation}</main>
        {footerBar ? <div className="ck-footer-bar">{footerBar}</div> : null}
      </div>
    </div>
  );
}
