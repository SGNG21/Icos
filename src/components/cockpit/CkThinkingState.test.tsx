import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CkThinkingState } from "./CkThinkingState";

describe("CkThinkingState", () => {
  it("renders three animated dots with a status role", () => {
    const html = renderToStaticMarkup(<CkThinkingState />);
    expect(html).toContain("ck-thinking");
    expect((html.match(/ck-thinking-dot/g) ?? []).length).toBe(3);
    expect(html).toContain('role="status"');
  });

  it("uses the default label when none is provided", () => {
    const html = renderToStaticMarkup(<CkThinkingState />);
    expect(html).toContain('aria-label="Réflexion en cours…"');
  });

  it("uses a custom label when provided", () => {
    const html = renderToStaticMarkup(<CkThinkingState label="Analyse…" />);
    expect(html).toContain('aria-label="Analyse…"');
  });
});
