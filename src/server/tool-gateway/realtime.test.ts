import { describe, expect, it } from "vitest";

import { declaredRealtimeInstanceIds } from "./realtime";

describe("realtime connector measurement (self-model external.realtime)", () => {
  it("counts only enabled web/search instances; a model provider is never realtime access", () => {
    const config = JSON.stringify({
      instances: [
        { instanceId: "web-main", connectorId: "web" },
        { instanceId: "search-main", connectorId: "search" },
        { instanceId: "search-off", connectorId: "search", enabled: false },
        { instanceId: "api", connectorId: "http", config: { baseUrl: "https://x.example" } },
      ],
    });
    expect(declaredRealtimeInstanceIds(config)).toEqual(["web-main", "search-main"]);
    expect(declaredRealtimeInstanceIds(undefined)).toEqual([]);
  });

  it("an unreadable config is unmeasurable (undefined), never zero", () => {
    expect(declaredRealtimeInstanceIds("{not json")).toBeUndefined();
    expect(declaredRealtimeInstanceIds(JSON.stringify({ instances: "nope" }))).toBeUndefined();
  });
});
