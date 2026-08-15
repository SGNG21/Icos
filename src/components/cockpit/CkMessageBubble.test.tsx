import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CkMessageBubble } from "./CkMessageBubble";

describe("CkMessageBubble", () => {
  it("renders a user message right-aligned", () => {
    const html = renderToStaticMarkup(<CkMessageBubble role="user" content="Déploie la staging" />);
    expect(html).toContain("ck-message-user");
    expect(html).toContain("Déploie la staging");
  });

  it("renders an ICOS message", () => {
    const html = renderToStaticMarkup(<CkMessageBubble role="icos" content="C'est parti." />);
    expect(html).toContain("ck-message-icos");
    expect(html).toContain("C&#x27;est parti.");
  });

  it("renders the timestamp when provided", () => {
    const html = renderToStaticMarkup(
      <CkMessageBubble role="icos" content="Fait" timestamp="12:04" />,
    );
    expect(html).toContain("ck-message-timestamp");
    expect(html).toContain("12:04");
  });

  it("renders an error message with an icon and action button", () => {
    const html = renderToStaticMarkup(
      <CkMessageBubble
        role="error"
        content="Échec du déploiement"
        actionLabel="Réessayer"
        onAction={() => {}}
      />,
    );
    expect(html).toContain("ck-message-error");
    expect(html).toContain("ck-message-error-icon");
    expect(html).toContain("ck-message-action");
    expect(html).toContain("Réessayer");
  });

  it("omits the action button when actionLabel or onAction is missing", () => {
    const noHandler = renderToStaticMarkup(
      <CkMessageBubble role="error" content="Erreur" actionLabel="Réessayer" />,
    );
    expect(noHandler).not.toContain("ck-message-action");

    const noLabel = renderToStaticMarkup(
      <CkMessageBubble role="error" content="Erreur" onAction={() => {}} />,
    );
    expect(noLabel).not.toContain("ck-message-action");
  });
});
