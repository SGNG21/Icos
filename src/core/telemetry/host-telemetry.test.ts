import { describe, expect, it } from "vitest";

import {
  capacityOf,
  classifyHostSample,
  measured,
  toneFor,
  unavailable,
  unwiredAiExtensions,
  type HostSample,
} from "./host-telemetry";

const GiB = 1024 ** 3;

function sample(overrides: Partial<HostSample> = {}): HostSample {
  return {
    at: "2026-10-17T10:00:00.000Z",
    cpu: {
      cores: 8,
      usage: measured(0.2),
      perCore: measured([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2]),
      iowait: measured(0.01),
      load: measured({ one: 1, five: 1, fifteen: 1 }),
    },
    memory: measured(capacityOf(24 * GiB, 16 * GiB)),
    swap: measured(capacityOf(0, 0)),
    disks: [{ mount: "/", capacity: measured(capacityOf(290 * GiB, 227 * GiB)) }],
    network: { rxBytesPerSec: measured(1000), txBytesPerSec: measured(500), interfaces: [] },
    uptimeSeconds: measured(3600),
    pressure: { cpu: measured(0.01), memory: measured(0), io: measured(0) },
    processes: {
      runnable: measured(2),
      total: measured(500),
      icos: measured({ rssBytes: 1, heapUsedBytes: 1, cpuRatio: 0 }),
    },
    container: {
      inContainer: false,
      memoryLimitBytes: measured(null),
      memoryUsedBytes: measured(1),
      cpuLimitCores: measured(null),
      differsFromHost: false,
    },
    ...overrides,
  };
}

describe("capacityOf", () => {
  it("dérive used et ratio, bornés", () => {
    expect(capacityOf(100, 25)).toEqual({ total: 100, used: 75, available: 25, ratio: 0.75 });
    expect(capacityOf(100, 150)).toMatchObject({ used: 0, available: 100, ratio: 0 });
    expect(capacityOf(0, 0).ratio).toBe(0);
  });
});

describe("toneFor", () => {
  it("applique les seuils inclusifs", () => {
    expect(toneFor(0.5, [0.75, 0.9])).toBe("ok");
    expect(toneFor(0.75, [0.75, 0.9])).toBe("degraded");
    expect(toneFor(0.9, [0.75, 0.9])).toBe("incident");
  });
});

describe("classifyHostSample", () => {
  it("est vert sur un hôte sain et ne signale pas le swap absent sans tension RAM", () => {
    const result = classifyHostSample(sample());
    expect(result.overall).toBe("ok");
    expect(result.signals.every((s) => s.tone === "ok")).toBe(true);
    expect(result.signals.some((s) => s.key === "swap")).toBe(false);
    expect(result.recommendations).toEqual([]);
  });

  it("passe en incident sur saturation CPU et en dégradé sur RAM", () => {
    expect(
      classifyHostSample(sample({ cpu: { ...sample().cpu, usage: measured(0.95) } })).overall,
    ).toBe("incident");
    expect(classifyHostSample(sample({ memory: measured(capacityOf(100, 15)) })).overall).toBe(
      "degraded",
    );
  });

  it("rapporte la charge par vCPU", () => {
    const loaded = sample({
      cpu: { ...sample().cpu, load: measured({ one: 20, five: 17, fifteen: 9 }) },
    });
    const load = classifyHostSample(loaded).signals.find((s) => s.key === "load");
    expect(load?.tone).toBe("incident");
  });

  it("émet des recommandations violettes sans dégrader l'état global", () => {
    const result = classifyHostSample(
      sample({
        memory: measured(capacityOf(100, 18)),
        disks: [{ mount: "/", capacity: measured(capacityOf(100, 25)) }],
      }),
    );
    expect(result.recommendations.map((r) => r.key).sort()).toEqual(["disk", "swap"]);
    expect(result.recommendations.every((r) => r.tone === "improve")).toBe(true);
    expect(result.overall).toBe("degraded"); // dû à la RAM (82 %), pas aux recommandations
  });

  it("n'invente aucun signal pour une métrique indisponible", () => {
    const reason = "illisible";
    const result = classifyHostSample(
      sample({
        cpu: {
          cores: 8,
          usage: unavailable(reason),
          perCore: unavailable(reason),
          iowait: unavailable(reason),
          load: unavailable(reason),
        },
        memory: unavailable(reason),
        swap: unavailable(reason),
        disks: [{ mount: "/", capacity: unavailable(reason) }],
        pressure: {
          cpu: unavailable(reason),
          memory: unavailable(reason),
          io: unavailable(reason),
        },
        container: {
          inContainer: false,
          memoryLimitBytes: unavailable(reason),
          memoryUsedBytes: unavailable(reason),
          cpuLimitCores: unavailable(reason),
          differsFromHost: false,
        },
      }),
    );
    expect(result.signals).toEqual([]);
    expect(result.overall).toBe("ok");
  });
});

describe("unwiredAiExtensions", () => {
  it("déclare toutes les extensions IA indisponibles avec une raison", () => {
    for (const value of Object.values(unwiredAiExtensions())) {
      expect(value.available).toBe(false);
      expect(value.available ? "" : value.reason).not.toBe("");
    }
  });
});
