import { describe, expect, it } from "vitest";

import { missionStatusSchema } from "@/core/mission";
import { riskLevelSchema } from "@/core/contracts";

import {
  statusConfig,
  riskLabelMap,
  riskStyleMap,
  getStatusConfig,
  getRiskConfig,
} from "./statusConfig";

describe("statusConfig", () => {
  it("has an entry for every MissionStatus value", () => {
    const definedStatuses = Object.keys(statusConfig);
    const allStatuses: readonly string[] = missionStatusSchema.options;
    for (const s of allStatuses) {
      expect(definedStatuses).toContain(s);
    }
  });

  it("every entry has label, icon, color, and cssClass", () => {
    for (const [status, config] of Object.entries(statusConfig)) {
      expect(config.label, `${status} missing label`).toBeTruthy();
      expect(config.icon, `${status} missing icon`).toBeTruthy();
      expect(config.color, `${status} missing color`).toBeTruthy();
      expect(config.cssClass, `${status} missing cssClass`).toBeTruthy();
    }
  });

  it("recovery statuses (PROVIDER_UNAVAILABLE through MISSION_RECOVERABLE) include 'Suspendue'", () => {
    const recovery: string[] = [
      "PROVIDER_UNAVAILABLE",
      "TOOL_FAILED",
      "SKILL_REVOKED",
      "STALE_ATTESTATION",
      "MISSION_RECOVERABLE",
    ];
    for (const s of recovery) {
      expect(statusConfig[s as keyof typeof statusConfig].label).toMatch(/^Suspendue — /);
    }
  });

  it("getStatusConfig returns correct entry for known status", () => {
    const cfg = getStatusConfig("IN_PROGRESS");
    expect(cfg.label).toBe("En cours");
    expect(cfg.icon).toBe("●");
    expect(cfg.cssClass).toBe("status-in-progress");
  });

  it("getStatusConfig returns fallback for unknown status", () => {
    const cfg = getStatusConfig("SOME_UNKNOWN_STATUS" as never);
    expect(cfg.icon).toBe("?");
    expect(cfg.cssClass).toBe("status-unknown");
  });

  it("COMPLETED uses ✅ icon and mint color", () => {
    expect(statusConfig.COMPLETED.icon).toBe("✅");
    expect(statusConfig.COMPLETED.color).toBe("mint");
  });

  it("FAILED uses ❌ icon and red color", () => {
    expect(statusConfig.FAILED.icon).toBe("❌");
    expect(statusConfig.FAILED.color).toBe("red");
  });

  it("CANCELLED uses — icon and muted color", () => {
    expect(statusConfig.CANCELLED.icon).toBe("—");
    expect(statusConfig.CANCELLED.color).toBe("muted");
  });
});

describe("riskLabelMap", () => {
  it("has an entry for every RiskLevel value", () => {
    const definedRisks = Object.keys(riskLabelMap);
    const allRisks: readonly string[] = riskLevelSchema.options;
    for (const r of allRisks) {
      expect(definedRisks).toContain(r);
    }
  });

  it("maps sensitive → Sensible", () => {
    expect(riskLabelMap.sensitive).toBe("Sensible");
  });

  it("maps read_only → Lecture seule", () => {
    expect(riskLabelMap.read_only).toBe("Lecture seule");
  });

  it("maps reversible → Réversible", () => {
    expect(riskLabelMap.reversible).toBe("Réversible");
  });
});

describe("riskStyleMap", () => {
  it("has an entry for every RiskLevel", () => {
    const allRisks: readonly string[] = riskLevelSchema.options;
    for (const r of allRisks) {
      expect(riskStyleMap[r]).toBeDefined();
      expect(riskStyleMap[r].label).toBeTruthy();
      expect(riskStyleMap[r].cssClass).toBeTruthy();
    }
  });
});

describe("getRiskConfig", () => {
  it("returns correct config for sensitive", () => {
    const cfg = getRiskConfig("sensitive");
    expect(cfg.label).toBe("Sensible");
    expect(cfg.cssClass).toBe("risk-sensitive");
  });

  it("returns fallback for unknown risk level", () => {
    const cfg = getRiskConfig("critical" as never);
    expect(cfg.cssClass).toBe("risk-unknown");
  });
});
