import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CkComposer, canSend } from "./CkComposer";

describe("canSend", () => {
  it("is false for an empty or whitespace-only draft", () => {
    expect(canSend("")).toBe(false);
    expect(canSend("   ")).toBe(false);
    expect(canSend("\n\t")).toBe(false);
  });

  it("is true for a draft with content", () => {
    expect(canSend("go")).toBe(true);
    expect(canSend("  padded  ")).toBe(true);
  });

  it("is false when disabled, regardless of content", () => {
    expect(canSend("ready", true)).toBe(false);
  });
});

describe("CkComposer", () => {
  it("renders the input, send button and mic placeholder", () => {
    const html = renderToStaticMarkup(<CkComposer onSend={() => {}} />);
    expect(html).toContain("<textarea");
    expect(html).toContain("ck-composer-input");
    expect(html).toContain("ck-composer-btn");
    expect(html).toContain("ck-composer-mic");
  });

  it("disables the send button when the draft starts empty", () => {
    const html = renderToStaticMarkup(<CkComposer onSend={() => {}} />);
    // The send button renders disabled at rest (empty draft).
    expect(html).toMatch(/ck-composer-btn[^>]*disabled/);
  });

  it("renders the mic control as a disabled placeholder", () => {
    const html = renderToStaticMarkup(<CkComposer onSend={() => {}} />);
    expect(html).toMatch(/ck-composer-mic[^>]*disabled/);
    expect(html).toContain('title="Bientôt disponible"');
  });

  it("uses the default placeholder and honours a custom one", () => {
    const dflt = renderToStaticMarkup(<CkComposer onSend={() => {}} />);
    expect(dflt).toContain('placeholder="Décris ton objectif…"');

    const custom = renderToStaticMarkup(
      <CkComposer onSend={() => {}} placeholder="Autre chose…" />,
    );
    expect(custom).toContain('placeholder="Autre chose…"');
  });

  it("disables the input when the disabled prop is set", () => {
    const html = renderToStaticMarkup(<CkComposer onSend={() => {}} disabled />);
    expect(html).toMatch(/ck-composer-input[^>]*disabled/);
  });
});
