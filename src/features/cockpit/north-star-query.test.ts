import { describe, expect, it } from "vitest";

import { northStarHref, parseNorthStarQuery } from "./north-star-query";

const programs = new Set(["p01", "p10"]);

describe("north-star query parsing", () => {
  it("ignores repeated parameters instead of crashing (Codex MAJOR: ?q=a&q=b)", () => {
    const parsed = parseNorthStarQuery({ q: ["alpha", "beta"], priority: ["P0", "P1"], program: ["p01"] }, programs);
    expect(parsed).toEqual({ q: "", priority: undefined, program: undefined });
  });

  it("trims q and validates priority and program against the known sets", () => {
    expect(parseNorthStarQuery({ q: "  cognitif ", priority: "P0", program: "p10" }, programs)).toEqual({
      q: "cognitif",
      priority: "P0",
      program: "p10",
    });
    expect(parseNorthStarQuery({ priority: "P9", program: "nope" }, programs)).toEqual({
      q: "",
      priority: undefined,
      program: undefined,
    });
    expect(parseNorthStarQuery({}, programs)).toEqual({ q: "", priority: undefined, program: undefined });
  });

  it("priority links preserve q and program (Codex MINOR)", () => {
    const query = parseNorthStarQuery({ q: "sauvegarde", program: "p10" }, programs);
    expect(northStarHref(query, "P0")).toBe("/cockpit/north-star?q=sauvegarde&priority=P0&program=p10");
    expect(northStarHref(query)).toBe("/cockpit/north-star?q=sauvegarde&program=p10");
    expect(northStarHref({ q: "", priority: undefined, program: undefined })).toBe("/cockpit/north-star");
  });
});
