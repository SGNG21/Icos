import { describe, expect, it } from "vitest";

import { measured, unavailable } from "@/core/telemetry";

import {
  formatBitRate,
  formatBytes,
  formatDuration,
  formatPercent,
  show,
} from "./telemetry-format";

describe("telemetry-format", () => {
  it("formate octets, débits, pourcentages et durées en français", () => {
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(24 * 1024 ** 3)).toBe("24,0 Gio");
    expect(formatBytes(290 * 1024 ** 3)).toBe("290 Gio");
    expect(formatBitRate(1129)).toBe("9,0 kbit/s");
    expect(formatBitRate(125_000_000)).toBe("1,0 Gbit/s");
    expect(formatPercent(0.326)).toBe("33 %");
    expect(formatPercent(0.1596, 1)).toBe("16,0 %");
    expect(formatDuration(90_000)).toBe("1 j 1 h");
    expect(formatDuration(125)).toBe("2 min");
  });

  it("affiche « Indisponible » plutôt qu'une valeur pour une mesure absente", () => {
    expect(show(unavailable("x"), String)).toBe("Indisponible");
    expect(show(measured(3), String)).toBe("3");
    expect(formatBytes(Number.NaN)).toBe("Indisponible");
  });
});
