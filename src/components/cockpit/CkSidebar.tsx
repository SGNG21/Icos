"use client";

import type { ReactNode } from "react";

export interface CkSidebarProps {
  /** Project selector slot (CkProjectSelector — added in a later lot). */
  projectSelector: ReactNode;
  activeMissionCount: number;
  historyCount: number;
  /** Advanced section slot (CkAdvancedSection — added in a later lot). */
  advancedChildren?: ReactNode;
  /** Footer slot — mini status / logout control. */
  footer?: ReactNode;
  /** Mobile overlay close handler. When provided, a close button is rendered. */
  onClose?: () => void;
}

/**
 * CkSidebar — cockpit navigation sidebar.
 *
 * Sections: brand, Projets (selector slot), Missions (counts), Mémoire,
 * Avancé (collapsible slot), footer. Navigation only — no backend authority,
 * no fake system status. Counts are display values passed in by the caller.
 */
export function CkSidebar({
  projectSelector,
  activeMissionCount,
  historyCount,
  advancedChildren,
  footer,
  onClose,
}: CkSidebarProps) {
  return (
    <nav className="ck-sidebar" aria-label="Navigation principale">
      <div className="ck-sidebar-brand">
        <span className="ck-sidebar-brand-mark" aria-hidden="true">
          I
        </span>
        <span>ICOS</span>
      </div>

      {onClose ? (
        <button
          type="button"
          className="ck-sidebar-close"
          onClick={onClose}
          aria-label="Fermer le menu"
        >
          ✕
        </button>
      ) : null}

      <div className="ck-sidebar-section">
        <p className="ck-sidebar-label">Projets</p>
        {projectSelector}
      </div>

      <div className="ck-sidebar-section">
        <p className="ck-sidebar-label">Missions</p>
        <span className="ck-sidebar-item">
          <span>En cours</span>
          <span className="ck-sidebar-count">{activeMissionCount}</span>
        </span>
        <span className="ck-sidebar-item">
          <span>Historique</span>
          <span className="ck-sidebar-count">{historyCount}</span>
        </span>
      </div>

      <div className="ck-sidebar-section">
        <span className="ck-sidebar-item">
          <span aria-hidden="true">🧠</span>
          <span>Mémoire</span>
        </span>
      </div>

      {advancedChildren ? <div className="ck-sidebar-section">{advancedChildren}</div> : null}

      {footer ? <div className="ck-sidebar-footer">{footer}</div> : null}
    </nav>
  );
}
