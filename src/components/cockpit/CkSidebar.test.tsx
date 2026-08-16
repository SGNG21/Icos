import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CkSidebar } from "./CkSidebar";

describe("CkSidebar", () => {
  it("renders the brand and section labels", () => {
    const html = renderToStaticMarkup(
      <CkSidebar
        projectSelector={<div>PROJECT_SELECTOR</div>}
        activeMissionCount={2}
        historyCount={6}
      />,
    );
    expect(html).toContain("ICOS");
    expect(html).toContain("Projets");
    expect(html).toContain("Missions");
    expect(html).toContain("Mémoire");
  });

  it("renders the project selector slot", () => {
    const html = renderToStaticMarkup(
      <CkSidebar
        projectSelector={<div>PROJECT_SELECTOR</div>}
        activeMissionCount={0}
        historyCount={0}
      />,
    );
    expect(html).toContain("PROJECT_SELECTOR");
  });

  it("shows the active mission and history counts", () => {
    const html = renderToStaticMarkup(
      <CkSidebar projectSelector={<div />} activeMissionCount={3} historyCount={9} />,
    );
    expect(html).toContain("En cours");
    expect(html).toContain(">3<");
    expect(html).toContain("Historique");
    expect(html).toContain(">9<");
  });

  it("uses a nav landmark with an accessible name", () => {
    const html = renderToStaticMarkup(
      <CkSidebar projectSelector={<div />} activeMissionCount={0} historyCount={0} />,
    );
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Navigation principale"');
  });

  it("renders a close button only when onClose is provided", () => {
    const withClose = renderToStaticMarkup(
      <CkSidebar
        projectSelector={<div />}
        activeMissionCount={0}
        historyCount={0}
        onClose={() => {}}
      />,
    );
    expect(withClose).toContain("ck-sidebar-close");
    expect(withClose).toContain('aria-label="Fermer le menu"');

    const withoutClose = renderToStaticMarkup(
      <CkSidebar projectSelector={<div />} activeMissionCount={0} historyCount={0} />,
    );
    expect(withoutClose).not.toContain("ck-sidebar-close");
  });

  it("renders advanced and footer slots when provided", () => {
    const html = renderToStaticMarkup(
      <CkSidebar
        projectSelector={<div />}
        activeMissionCount={0}
        historyCount={0}
        advancedChildren={<div>ADVANCED_SLOT</div>}
        footer={<div>FOOTER_SLOT</div>}
      />,
    );
    expect(html).toContain("ADVANCED_SLOT");
    expect(html).toContain("FOOTER_SLOT");
  });
});
