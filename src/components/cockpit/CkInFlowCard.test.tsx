import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CkInFlowCard } from "./CkInFlowCard";

describe("CkInFlowCard", () => {
  it("renders the title, icon and children", () => {
    const html = renderToStaticMarkup(
      <CkInFlowCard title="Mission" icon="🎯">
        <div>CARD_BODY</div>
      </CkInFlowCard>,
    );
    expect(html).toContain("Mission");
    expect(html).toContain("🎯");
    expect(html).toContain("CARD_BODY");
  });

  it("defaults to the mission variant", () => {
    const html = renderToStaticMarkup(
      <CkInFlowCard title="X">
        <span />
      </CkInFlowCard>,
    );
    expect(html).toContain("ck-inflow-card mission");
  });

  it("applies the requested variant class", () => {
    for (const variant of ["mission", "approval", "activity", "result"] as const) {
      const html = renderToStaticMarkup(
        <CkInFlowCard title="X" variant={variant}>
          <span />
        </CkInFlowCard>,
      );
      expect(html).toContain(`ck-inflow-card ${variant}`);
    }
  });

  it("omits the icon element when no icon is provided", () => {
    const html = renderToStaticMarkup(
      <CkInFlowCard title="No icon">
        <span />
      </CkInFlowCard>,
    );
    expect(html).toContain("No icon");
    expect(html).not.toContain('aria-hidden="true"');
  });
});
