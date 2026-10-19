import { describe, expect, it } from "vitest";

import {
  busyRatio,
  iowaitRatio,
  isPhysicalInterface,
  parseLoadAvg,
  parseLoadAvgTasks,
  parsePressureSome,
  parseCgroupV2Path,
  parseCgroupBytes,
  parseCpuMax,
  parseMemInfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
  ratePerSecond,
} from "./proc-parsers";

const STAT = `cpu  100 0 100 700 100 0 0 0 0 0
cpu0 50 0 50 350 50 0 0 0 0 0
cpu1 50 0 50 350 50 0 0 0 0 0
intr 12345
ctxt 999
`;

describe("parseProcStat", () => {
  it("lit l'agrégat et chaque vCPU", () => {
    const stat = parseProcStat(STAT);
    expect(stat?.aggregate).toEqual({ total: 1000, idle: 800, iowait: 100 });
    expect(stat?.cores).toHaveLength(2);
  });

  it("refuse un contenu sans ligne cpu agrégée", () => {
    expect(parseProcStat("intr 1\n")).toBeNull();
  });

  it("calcule busy et iowait sur un delta", () => {
    const a = { total: 1000, idle: 800, iowait: 100 };
    const b = { total: 2000, idle: 1300, iowait: 150 };
    expect(busyRatio(a, b)).toBeCloseTo(0.5);
    expect(iowaitRatio(a, b)).toBeCloseTo(0.05);
    expect(busyRatio(a, a)).toBeNull();
  });
});

describe("parseMemInfo", () => {
  it("convertit les kB en octets", () => {
    const mem = parseMemInfo(
      "MemTotal:       1000 kB\nMemFree: 10 kB\nMemAvailable:    400 kB\nActive(anon): 5 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n",
    );
    expect(mem).toEqual({
      memTotal: 1024000,
      memAvailable: 409600,
      swapTotal: 204800,
      swapFree: 153600,
    });
  });

  it("exige MemAvailable", () => {
    expect(parseMemInfo("MemTotal: 1000 kB\n")).toBeNull();
  });
});

describe("parseLoadAvg / parseUptime", () => {
  it("lit les trois moyennes", () => {
    expect(parseLoadAvg("3.08 2.59 2.33 8/1329 2764831\n")).toEqual({
      one: 3.08,
      five: 2.59,
      fifteen: 2.33,
    });
    expect(parseLoadAvg("garbage")).toBeNull();
  });

  it("lit l'uptime en secondes", () => {
    expect(parseUptime("12345.67 99999.00\n")).toBeCloseTo(12345.67);
    expect(parseUptime("")).toBeNull();
  });
});

describe("parseNetDev", () => {
  const NET = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1223 73 0 0 0 0 0 0 1223 73 0 0 0 0 0 0
  eth0: 19033 10 0 0 0 0 0 0 2784 7 0 0 0 0 0 0
docker0: 1201 131 0 0 0 0 0 0 1016 84 0 0 0 0 0 0
`;

  it("lit rx/tx et ignore l'en-tête", () => {
    expect(parseNetDev(NET)).toEqual([
      { name: "lo", rxBytes: 1223, txBytes: 1223 },
      { name: "eth0", rxBytes: 19033, txBytes: 2784 },
      { name: "docker0", rxBytes: 1201, txBytes: 1016 },
    ]);
  });

  it("exclut boucle locale, ponts et veth du total", () => {
    expect(
      ["lo", "docker0", "br-03a3ee4b1fca", "veth1a2b3c", "tailscale0", "wg0"].some(
        isPhysicalInterface,
      ),
    ).toBe(false);
    expect(["eth0", "ens3", "enp1s0"].every(isPhysicalInterface)).toBe(true);
  });

  it("calcule un débit et refuse un compteur réinitialisé", () => {
    expect(ratePerSecond(1000, 3000, 10)).toBe(200);
    expect(ratePerSecond(3000, 1000, 10)).toBeNull();
    expect(ratePerSecond(0, 10, 0)).toBeNull();
  });
});

describe("parseurs PSI, tâches et cgroup", () => {
  it("lit la pression some avg10", () => {
    expect(
      parsePressureSome("some avg10=15.96 avg60=10.94 avg300=5.80 total=1\nfull avg10=0.00\n"),
    ).toBeCloseTo(0.1596);
    expect(parsePressureSome("garbage")).toBeNull();
  });

  it("lit les tâches exécutables/totales", () => {
    expect(parseLoadAvgTasks("3.08 2.59 2.33 8/1329 2764831")).toEqual({
      runnable: 8,
      total: 1329,
    });
    expect(parseLoadAvgTasks("3.08 2.59")).toBeNull();
  });

  it("extrait un chemin cgroup v2 sûr", () => {
    expect(parseCgroupV2Path("0::/user.slice/user-1001.slice/session-1.scope\n")).toBe(
      "/user.slice/user-1001.slice/session-1.scope",
    );
    expect(parseCgroupV2Path("0::/\n")).toBe("");
    expect(parseCgroupV2Path("0::/a/../../etc\n")).toBeNull();
    expect(parseCgroupV2Path("12:memory:/docker/abc\n")).toBeNull(); // cgroup v1 non pris en charge
  });

  it("lit memory.max et cpu.max", () => {
    expect(parseCgroupBytes("max\n")).toBeNull();
    expect(parseCgroupBytes("2147483648\n")).toBe(2147483648);
    expect(parseCgroupBytes("nope")).toBeUndefined();
    expect(parseCpuMax("max 100000\n")).toBeNull();
    expect(parseCpuMax("200000 100000\n")).toBe(2);
    expect(parseCpuMax("x y")).toBeUndefined();
  });
});
