import { describe, expect, it } from "vitest";

import { extractJsonObject } from "./omniroute-reviewer";

describe("reviewer output envelope", () => {
  it("unwraps fences and prose around the JSON object, and leaves bare JSON alone", () => {
    const obj = '{"decision":"APPROVE","reasons":["ok"]}';
    expect(extractJsonObject("```json\n" + obj + "\n```")).toBe(obj);
    expect(extractJsonObject("Voici la revue :\n" + obj + "\nMerci.")).toBe(obj);
    expect(extractJsonObject(obj)).toBe(obj);
  });

  it("text with no object still fails closed at JSON.parse", () => {
    expect(() => JSON.parse(extractJsonObject("no json here"))).toThrow();
  });
});
