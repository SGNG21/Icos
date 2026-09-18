import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DIR = join(process.cwd(), "drizzle");
const journal: { entries: { idx: number; tag: string; when: number }[] } = JSON.parse(
  readFileSync(join(DIR, "meta", "_journal.json"), "utf8"),
);

describe("drizzle migration journal integrity", () => {
  it("registers every SQL migration file and only existing files", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.slice(0, -4))
      .sort();
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(files);
  });

  it("has contiguous idx and strictly increasing `when` (drizzle applies by timestamp)", () => {
    journal.entries.forEach((e, i) => expect(e.idx).toBe(i));
    for (let i = 1; i < journal.entries.length; i++) {
      expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
    }
  });

  it("keeps the numeric prefixes unique", () => {
    const prefixes = journal.entries.map((e) => e.tag.slice(0, 4));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
