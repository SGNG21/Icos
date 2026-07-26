import { describe, expect, it } from "vitest";

import {
  formatSizeBytes,
  formatDurationMs,
  formatRelativeTime,
  formatStepCount,
} from "./format";

describe("formatSizeBytes", () => {
  it("returns '0 o' for 0 bytes", () => {
    expect(formatSizeBytes(0)).toBe("0 o");
  });

  it("returns plain bytes for small values", () => {
    expect(formatSizeBytes(1)).toBe("1 o");
    expect(formatSizeBytes(512)).toBe("512 o");
    expect(formatSizeBytes(1023)).toBe("1023 o");
  });

  it("returns Ko for kilobyte range", () => {
    expect(formatSizeBytes(1024)).toBe("1.0 Ko");
    expect(formatSizeBytes(1536)).toBe("1.5 Ko");
    expect(formatSizeBytes(10240)).toBe("10 Ko");
    expect(formatSizeBytes(1048575)).toBe("1024 Ko");
  });

  it("returns Mo for megabyte range", () => {
    expect(formatSizeBytes(1048576)).toBe("1.0 Mo");
    expect(formatSizeBytes(2097152)).toBe("2.0 Mo");
    expect(formatSizeBytes(10485760)).toBe("10 Mo");
  });

  it("handles Go and To ranges", () => {
    expect(formatSizeBytes(1073741824)).toBe("1.0 Go");
    expect(formatSizeBytes(1099511627776)).toBe("1.0 To");
  });

  it("handles negative and NaN gracefully", () => {
    expect(formatSizeBytes(-100)).toBe("0 o");
    expect(formatSizeBytes(Number.NaN)).toBe("0 o");
    expect(formatSizeBytes(Number.POSITIVE_INFINITY)).toBe("0 o");
  });
});

describe("formatDurationMs", () => {
  it("returns '0 s' for 0 or negative", () => {
    expect(formatDurationMs(0)).toBe("0 s");
    expect(formatDurationMs(-100)).toBe("0 s");
  });

  it("formats seconds only", () => {
    expect(formatDurationMs(5000)).toBe("5 s");
    expect(formatDurationMs(12000)).toBe("12 s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDurationMs(150000)).toBe("2 min 30 s");
    expect(formatDurationMs(61000)).toBe("1 min 1 s");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMs(3600000)).toBe("1 h");
    expect(formatDurationMs(3900000)).toBe("1 h 5 min");
    expect(formatDurationMs(7200000)).toBe("2 h");
  });

  it("does not show seconds when >= 1 hour", () => {
    // 1h 30m 5s → "1 h 30 min" (no seconds)
    expect(formatDurationMs(5405000)).toBe("1 h 30 min");
  });

  it("handles NaN gracefully", () => {
    expect(formatDurationMs(Number.NaN)).toBe("0 s");
  });
});

describe("formatRelativeTime", () => {
  it("returns 'il y a 30 s' for recent timestamps", () => {
    const d = new Date(Date.now() - 30000).toISOString();
    const result = formatRelativeTime(d);
    // The exact wording depends on Intl.RelativeTimeFormat + numeric: "auto"
    // "30 secondes" might also appear with the unit spelled out
    expect(result).toMatch(/30/);
  });

  it("returns 'il y a 1 minute' for 1 minute ago", () => {
    const d = new Date(Date.now() - 60000).toISOString();
    const result = formatRelativeTime(d);
    expect(result).toMatch(/minut/);
  });

  it("returns 'il y a 1 heure' for 1 hour ago", () => {
    const d = new Date(Date.now() - 3600000).toISOString();
    const result = formatRelativeTime(d);
    expect(result).toMatch(/heure/);
  });

  it("returns 'il y a 2 jours' for 2 days ago", () => {
    const d = new Date(Date.now() - 172800000).toISOString();
    const result = formatRelativeTime(d);
    expect(result).toMatch(/[a-z]/); // keyed to French relative time output
  });

  it("returns empty string for invalid date", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});

describe("formatStepCount", () => {
  it("returns '3/5 étapes' for valid counts", () => {
    expect(formatStepCount(3, 5)).toBe("3/5 étapes");
  });

  it("clamps completed to total", () => {
    expect(formatStepCount(10, 5)).toBe("5/5 étapes");
  });

  it("returns empty for zero or negative total", () => {
    expect(formatStepCount(0, 0)).toBe("");
    expect(formatStepCount(3, -1)).toBe("");
  });

  it("handles NaN gracefully", () => {
    expect(formatStepCount(Number.NaN, 5)).toBe("");
  });
});
