import { describe, expect, it } from "vitest";

import {
  HostTelemetrySampler,
  type CgroupFile,
  type HostSource,
  type ProcPath,
} from "./host-sampler";

function statFor(busy: number, idle: number): string {
  // 2 vCPU identiques ; l'agrégat est la somme.
  return [
    `cpu  ${busy * 2} 0 0 ${idle * 2} 0 0 0 0 0 0`,
    `cpu0 ${busy} 0 0 ${idle} 0 0 0 0 0 0`,
    `cpu1 ${busy} 0 0 ${idle} 0 0 0 0 0 0`,
  ].join("\n");
}

function netFor(rx: number, tx: number): string {
  return [
    "Inter-| header",
    " face | header",
    `    lo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0`,
    `  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`,
  ].join("\n");
}

class FakeSource implements HostSource {
  clock = 1_000_000;
  stat = statFor(0, 0);
  net = netFor(0, 0);
  reads = 0;
  files: Partial<Record<ProcPath, string | null>> = {
    "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
    "/proc/loadavg": "1.00 2.00 3.00 1/100 42\n",
    "/proc/uptime": "3600.00 1000.00\n",
    "/proc/pressure/memory": "some avg10=40.00 avg60=1.00 avg300=1.00 total=1\n",
  };
  disk: { total: number; available: number } | null = { total: 1000, available: 400 };
  cgroup: Partial<Record<CgroupFile, string>> = {
    "memory.max": "max\n",
    "memory.current": "102400\n",
    "cpu.max": "max 100000\n",
  };
  inContainer = false;
  cpuMicros = 0;

  async readProc(path: ProcPath) {
    if (path === "/proc/stat") {
      this.reads += 1;
      return this.stat;
    }
    if (path === "/proc/net/dev") return this.net;
    return this.files[path] ?? null;
  }
  async readCgroup(file: CgroupFile) {
    return this.cgroup[file] ?? null;
  }
  async containerMarker() {
    return this.inContainer;
  }
  processUsage() {
    return { rssBytes: 2048, heapUsedBytes: 1024, cpuMicros: this.cpuMicros };
  }
  async diskUsage() {
    return this.disk;
  }
  async linkSpeed() {
    return null;
  }
  hostname() {
    return "vps-test";
  }
  now() {
    return this.clock;
  }
  async sleep(ms: number) {
    // Le second relevé du préchauffage voit 50 % d'occupation et 1 kB/s en réception.
    this.clock += ms;
    this.stat = statFor(50, 50);
    this.net = netFor(1000, 500);
    this.cpuMicros += ms * 1000 * 0.5; // ICOS occupe ½ vCPU → 25 % de 2 vCPU
  }
}

describe("HostTelemetrySampler", () => {
  it("préchauffe au premier appel pour produire des deltas réels", async () => {
    const source = new FakeSource();
    const snapshot = await new HostTelemetrySampler({ source, warmupMs: 1000 }).snapshot();

    expect(snapshot.schema).toBe(1);
    expect(snapshot.hostname).toEqual({ available: true, value: "vps-test" });
    expect(snapshot.current.cpu.cores).toBe(2);
    expect(snapshot.current.cpu.usage).toEqual({ available: true, value: 0.5 });
    expect(snapshot.current.cpu.perCore).toEqual({ available: true, value: [0.5, 0.5] });
    expect(snapshot.current.memory).toMatchObject({ available: true, value: { ratio: 0.75 } });
    expect(snapshot.current.swap).toMatchObject({ available: true, value: { total: 0 } });
    expect(snapshot.current.disks[0]).toMatchObject({
      mount: "/",
      capacity: { value: { used: 600 } },
    });
    // lo exclu : seul eth0 compte.
    expect(snapshot.current.network.rxBytesPerSec).toEqual({ available: true, value: 1000 });
    expect(snapshot.current.network.interfaces.map((i) => i.name)).toEqual(["eth0"]);
    expect(snapshot.current.network.interfaces[0]?.linkSpeedBitsPerSec.available).toBe(false);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({ cpu: 0.5, memory: 0.75, swap: null, disk: 0.6 });
    expect(snapshot.extensions.tokensPerSecond.available).toBe(false);
  });

  it("sert le cache sous la demi-période et partage une lecture concurrente", async () => {
    const source = new FakeSource();
    const sampler = new HostTelemetrySampler({ source, warmupMs: 0, sampleIntervalSeconds: 10 });
    await Promise.all([sampler.snapshot(), sampler.snapshot(), sampler.snapshot()]);
    const readsAfterFirst = source.reads;
    source.clock += 4_000;
    await sampler.snapshot();
    expect(source.reads).toBe(readsAfterFirst);

    source.clock += 2_000;
    source.stat = statFor(60, 140);
    const next = await sampler.snapshot();
    expect(source.reads).toBe(readsAfterFirst + 1);
    // delta : busy +20, idle +180 sur 2 vCPU → 10 %.
    expect(next.current.cpu.usage.available && next.current.cpu.usage.value).toBeCloseTo(0.1);
    expect(next.history).toHaveLength(2);
  });

  it("borne l'historique", async () => {
    const source = new FakeSource();
    const sampler = new HostTelemetrySampler({
      source,
      warmupMs: 0,
      historySize: 3,
      sampleIntervalSeconds: 2,
    });
    for (let i = 0; i < 5; i += 1) {
      source.clock += 2_000;
      await sampler.snapshot();
    }
    expect((await sampler.snapshot()).history).toHaveLength(3);
  });

  it("déclare indisponible ce qui ne peut pas être lu, sans échouer", async () => {
    const source = new FakeSource();
    source.files = {};
    source.disk = null;
    const snapshot = await new HostTelemetrySampler({ source, warmupMs: 0 }).snapshot();
    expect(snapshot.current.memory.available).toBe(false);
    expect(snapshot.current.swap.available).toBe(false);
    expect(snapshot.current.cpu.load.available).toBe(false);
    expect(snapshot.current.uptimeSeconds.available).toBe(false);
    expect(snapshot.current.disks[0]?.capacity.available).toBe(false);
    expect(snapshot.history[0]).toMatchObject({ memory: null, disk: null });
  });
});

describe("HostTelemetrySampler — processus, pression, cgroup et services", () => {
  it("mesure le processus ICOS, la pression et les tâches", async () => {
    const source = new FakeSource();
    const snapshot = await new HostTelemetrySampler({ source, warmupMs: 1000 }).snapshot();
    const { processes, pressure } = snapshot.current;
    expect(processes.runnable).toEqual({ available: true, value: 1 });
    expect(processes.total).toEqual({ available: true, value: 100 });
    expect(processes.icos).toEqual({
      available: true,
      value: { rssBytes: 2048, heapUsedBytes: 1024, cpuRatio: 0.25 },
    });
    expect(pressure.memory).toEqual({ available: true, value: 0.4 });
    expect(pressure.cpu.available).toBe(false);
    expect(snapshot.signals.find((s) => s.key === "pressure")?.tone).toBe("incident");
  });

  it("ne signale aucune différence hôte/cgroup quand le cgroup n'est pas borné", async () => {
    const snapshot = await new HostTelemetrySampler({
      source: new FakeSource(),
      warmupMs: 0,
    }).snapshot();
    expect(snapshot.current.container).toMatchObject({
      inContainer: false,
      memoryLimitBytes: { available: true, value: null },
      cpuLimitCores: { available: true, value: null },
      differsFromHost: false,
    });
    expect(snapshot.headroom.memoryAvailableBytes).toEqual({ available: true, value: 250 * 1024 });
  });

  it("distingue un conteneur borné et réduit la marge à sa limite", async () => {
    const source = new FakeSource();
    source.inContainer = true;
    source.cgroup = {
      "memory.max": `${200 * 1024}\n`,
      "memory.current": `${170 * 1024}\n`,
      "cpu.max": "50000 100000\n",
    };
    const snapshot = await new HostTelemetrySampler({ source, warmupMs: 1000 }).snapshot();
    expect(snapshot.current.container).toMatchObject({
      inContainer: true,
      cpuLimitCores: { value: 0.5 },
      differsFromHost: true,
    });
    expect(snapshot.headroom.memoryAvailableBytes).toEqual({ available: true, value: 30 * 1024 });
    expect(snapshot.headroom.idleVcpu).toEqual({ available: true, value: 0.5 });
    expect(snapshot.workers.additionalWorkers.available).toBe(false);
    expect(snapshot.signals.find((s) => s.key === "container")?.tone).toBe("degraded");
  });

  it("ne publie que les services observables depuis ce processus (les dépendances relèvent des sondes)", async () => {
    const snapshot = await new HostTelemetrySampler({
      source: new FakeSource(),
      warmupMs: 0,
    }).snapshot();
    expect(snapshot.services.map((s) => [s.key, s.state])).toEqual([
      ["cockpit-api", "operational"],
      ["telemetry", "operational"],
    ]);
    expect(snapshot.services[0]).toMatchObject({
      mission: null,
      process: { state: "operational" },
    });
    expect(snapshot.workers.activeJobs.available).toBe(false); // runtime inspecté par la route
  });

  it("dégrade le collecteur si une source essentielle est illisible", async () => {
    const source = new FakeSource();
    source.files = {};
    const snapshot = await new HostTelemetrySampler({ source, warmupMs: 0 }).snapshot();
    expect(snapshot.services.find((s) => s.key === "telemetry")?.state).toBe("degraded");
  });
});
