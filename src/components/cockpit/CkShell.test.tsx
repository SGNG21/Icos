import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CkShell } from "./CkShell";

describe("CkShell", () => {
  it("renders sidebar and conversation children", () => {
    const html = renderToStaticMarkup(
      <CkShell
        sidebar={<div>SIDEBAR_CONTENT</div>}
        conversation={<div>CONVERSATION_CONTENT</div>}
      />,
    );
    expect(html).toContain("SIDEBAR_CONTENT");
    expect(html).toContain("CONVERSATION_CONTENT");
  });

  it("renders the top bar with the ICOS brand", () => {
    const html = renderToStaticMarkup(
      <CkShell sidebar={<div />} conversation={<div />} />,
    );
    expect(html).toContain("ck-topbar");
    expect(html).toContain("ICOS");
  });

  it("renders the footer bar when provided", () => {
    const html = renderToStaticMarkup(
      <CkShell
        sidebar={<div />}
        conversation={<div />}
        footerBar={<div>FOOTER_CONTENT</div>}
      />,
    );
    expect(html).toContain("ck-footer-bar");
    expect(html).toContain("FOOTER_CONTENT");
  });

  it("hides the footer bar when not provided", () => {
    const html = renderToStaticMarkup(
      <CkShell sidebar={<div />} conversation={<div />} />,
    );
    expect(html).not.toContain("ck-footer-bar");
  });

  it("renders the top-bar right slot when provided", () => {
    const html = renderToStaticMarkup(
      <CkShell
        sidebar={<div />}
        conversation={<div />}
        topBarRight={<div>TOPBAR_RIGHT</div>}
      />,
    );
    expect(html).toContain("ck-topbar-right");
    expect(html).toContain("TOPBAR_RIGHT");
  });

  it("omits the top-bar right slot when not provided", () => {
    const html = renderToStaticMarkup(
      <CkShell sidebar={<div />} conversation={<div />} />,
    );
    expect(html).not.toContain("ck-topbar-right");
  });
});
