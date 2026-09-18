import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(process.cwd(), "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("no debug logging in shipped source", () => {
  it("has no console.log / console.debug / console.info (results and evidence must never be dumped)", () => {
    const offenders = sources(ROOT).filter((file) =>
      /console\.(log|debug|info)\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => f.replace(ROOT, "src"))).toEqual([]);
  });
});
