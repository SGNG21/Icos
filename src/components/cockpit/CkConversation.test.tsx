import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/features/cockpit/types";

import { CkConversation, inFlowCardMeta, isScrolledUp } from "./CkConversation";

describe("inFlowCardMeta", () => {
  it("maps each in-flow role to its card metadata", () => {
    expect(inFlowCardMeta("mission-progress")).toMatchObject({ variant: "mission" });
    expect(inFlowCardMeta("approval")).toMatchObject({ variant: "approval" });
    expect(inFlowCardMeta("activity")).toMatchObject({ variant: "activity" });
    expect(inFlowCardMeta("result")).toMatchObject({ variant: "result" });
  });

  it("returns null for plain-text and thinking roles", () => {
    expect(inFlowCardMeta("user")).toBeNull();
    expect(inFlowCardMeta("icos")).toBeNull();
    expect(inFlowCardMeta("thinking")).toBeNull();
    expect(inFlowCardMeta("error")).toBeNull();
  });
});

describe("isScrolledUp", () => {
  it("is false at (or near) the bottom", () => {
    // scrollHeight 1000, clientHeight 400, scrollTop 600 => distance 0
    expect(isScrolledUp(600, 1000, 400)).toBe(false);
    // within the default 80px threshold
    expect(isScrolledUp(540, 1000, 400)).toBe(false);
  });

  it("is true when scrolled meaningfully up", () => {
    // distance from bottom = 1000 - 400 - 300 = 300 > 80
    expect(isScrolledUp(300, 1000, 400)).toBe(true);
  });
});

describe("CkConversation", () => {
  it("renders the empty state when there are no messages", () => {
    const html = renderToStaticMarkup(
      <CkConversation messages={[]} onSend={() => {}} />,
    );
    expect(html).toContain("ck-empty-state");
    expect(html).toContain("Que veux-tu faire ?");
  });

  it("renders the composer", () => {
    const html = renderToStaticMarkup(
      <CkConversation messages={[]} onSend={() => {}} />,
    );
    expect(html).toContain("ck-composer");
  });

  it("renders user and icos messages as bubbles", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "user", content: "Salut", timestamp: "t" },
      { id: "m2", role: "icos", content: "Bonjour", timestamp: "t" },
    ];
    const html = renderToStaticMarkup(
      <CkConversation messages={messages} onSend={() => {}} />,
    );
    expect(html).toContain("ck-message-user");
    expect(html).toContain("Salut");
    expect(html).toContain("ck-message-icos");
    expect(html).toContain("Bonjour");
    expect(html).not.toContain("ck-empty-state");
  });

  it("renders a thinking indicator for the thinking role", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "thinking", timestamp: "t" },
    ];
    const html = renderToStaticMarkup(
      <CkConversation messages={messages} onSend={() => {}} />,
    );
    expect(html).toContain("ck-thinking");
  });

  it("renders an in-flow card placeholder for each card role", () => {
    const messages: ChatMessage[] = [
      { id: "m1", role: "mission-progress", timestamp: "t" },
      { id: "m2", role: "approval", timestamp: "t" },
      { id: "m3", role: "activity", timestamp: "t" },
      { id: "m4", role: "result", timestamp: "t" },
    ];
    const html = renderToStaticMarkup(
      <CkConversation messages={messages} onSend={() => {}} />,
    );
    expect(html).toContain("ck-inflow-card mission");
    expect(html).toContain("ck-inflow-card approval");
    expect(html).toContain("ck-inflow-card activity");
    expect(html).toContain("ck-inflow-card result");
  });

  it("renders an error message with its retry action", () => {
    const messages: ChatMessage[] = [
      {
        id: "err-1",
        role: "error",
        content: "Échec",
        errorLabel: "Réessayer",
        timestamp: "t",
      },
    ];
    const html = renderToStaticMarkup(
      <CkConversation messages={messages} onSend={() => {}} onRetry={() => {}} />,
    );
    expect(html).toContain("ck-message-error");
    expect(html).toContain("ck-message-action");
    expect(html).toContain("Réessayer");
  });
});
