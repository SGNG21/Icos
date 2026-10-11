import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseStartupParameters,
  startDatabaseGatekeeper,
  startupErrorResponse,
  type DatabaseGatekeeper,
} from "./database-gatekeeper";

/**
 * H1 — the gatekeeper is the only door from the sandboxed PostgreSQL step to the test cluster.
 * A fake upstream records what reaches it: only a startup packet naming exactly the run's
 * database and role may get there.
 */

function startup(params: Record<string, string>, version = 196608): Buffer {
  const body = Buffer.concat([
    ...Object.entries(params).map(([k, v]) => Buffer.from(`${k}\0${v}\0`)),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(8);
  head.writeInt32BE(body.length + 8, 0);
  head.writeInt32BE(version, 4);
  return Buffer.concat([head, body]);
}

function shortRequest(code: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeInt32BE(8, 0);
  b.writeInt32BE(code, 4);
  return b;
}

let dir: string;
let upstream: net.Server;
let upstreamPort: number;
let received: Buffer[];
let keeper: DatabaseGatekeeper;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "gatekeeper-"));
  received = [];
  upstream = net.createServer((s) => {
    s.on("data", (d) => {
      received.push(d);
      s.write("UPSTREAM");
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
  keeper = await startDatabaseGatekeeper({
    socketPath: path.join(dir, ".s.PGSQL.5432"),
    upstream: { host: "127.0.0.1", port: upstreamPort },
    user: "icos_test_gate_a_1",
    database: "icos_test_gate_a_1",
    handshakeTimeoutMs: 500,
  });
});
afterEach(async () => {
  await keeper.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

/** Sends `chunks`, returns everything the gatekeeper answered until it closed (or 1 s). */
async function exchange(chunks: Buffer[], waitFor?: string): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(path.join(dir, ".s.PGSQL.5432"));
    let out = "";
    const done = () => {
      c.destroy();
      resolve(out);
    };
    c.on("data", (d) => {
      out += d.toString("latin1");
      if (waitFor && out.includes(waitFor)) done();
    });
    c.on("close", done);
    c.on("error", done);
    c.on("connect", () => {
      for (const chunk of chunks) c.write(chunk);
    });
    setTimeout(done, 1000);
  });
}

describe("gatekeeper — protocole de démarrage", () => {
  it("transmet la connexion de la bonne base sous le bon rôle (et ce qui suit)", async () => {
    const pkt = startup({ user: "icos_test_gate_a_1", database: "icos_test_gate_a_1" });
    /* Split across writes: the gatekeeper must reassemble. */
    const out = await exchange([pkt.subarray(0, 5), pkt.subarray(5)], "UPSTREAM");
    expect(out).toContain("UPSTREAM");
    expect(Buffer.concat(received).subarray(0, pkt.length).equals(pkt)).toBe(true);
    expect(keeper.forwarded).toBe(1);
  });

  it("database absente = nom du rôle (comportement PostgreSQL)", async () => {
    const out = await exchange([startup({ user: "icos_test_gate_a_1" })], "UPSTREAM");
    expect(out).toContain("UPSTREAM");
  });

  it("répond N à SSLRequest / GSSENCRequest puis accepte le démarrage en clair", async () => {
    const out = await exchange(
      [
        shortRequest(80877103),
        shortRequest(80877104),
        startup({ user: "icos_test_gate_a_1", database: "icos_test_gate_a_1" }),
      ],
      "UPSTREAM",
    );
    expect(out.startsWith("NN")).toBe(true);
    expect(out).toContain("UPSTREAM");
  });

  it.each([
    ["le superutilisateur", { user: "icos", database: "icos_test_gate_a_1" }],
    ["une autre base", { user: "icos_test_gate_a_1", database: "icos_test" }],
    ["la base d'un autre run", { user: "icos_test_gate_b_2", database: "icos_test_gate_b_2" }],
    ["la base de maintenance", { user: "icos_test_gate_a_1", database: "postgres" }],
    [
      "une connexion de réplication",
      { user: "icos_test_gate_a_1", database: "icos_test_gate_a_1", replication: "database" },
    ],
  ])("refuse %s, sans rien transmettre", async (_label, params) => {
    const out = await exchange([startup(params)]);
    expect(out[0]).toBe("E");
    expect(out).toContain("28000");
    expect(received).toEqual([]);
    expect(keeper.refusals).toHaveLength(1);
    expect(keeper.forwarded).toBe(0);
  });

  it("refuse cancel, version inconnue, paquet invalide ou trop long", async () => {
    const cancel = Buffer.alloc(16);
    cancel.writeInt32BE(16, 0);
    cancel.writeInt32BE(80877102, 4);
    for (const chunk of [
      cancel,
      startup({ user: "icos_test_gate_a_1" }, 131072),
      Buffer.from([0, 0, 0, 4, 0, 0, 0, 0]),
      Buffer.from([0, 1, 0, 0, 0, 3, 0, 0]),
    ]) {
      const out = await exchange([chunk]);
      expect(out[0]).toBe("E");
    }
    expect(received).toEqual([]);
    expect(keeper.refusals).toHaveLength(4);
  });

  it("une poignée de main jamais terminée est coupée", async () => {
    await exchange([Buffer.from([0, 0])]);
    expect(keeper.refusals).toContain("handshake timeout");
    expect(received).toEqual([]);
  });

  it("close coupe aussi les connexions déjà transmises", async () => {
    const c = net.connect(path.join(dir, ".s.PGSQL.5432"));
    const closed = new Promise<void>((r) => c.on("close", () => r()));
    c.on("error", () => {});
    await new Promise<void>((r) => c.on("connect", () => r()));
    c.write(startup({ user: "icos_test_gate_a_1" }));
    await new Promise<void>((r) => c.once("data", () => r()));
    await keeper.close();
    await closed;
  });
});

describe("parseStartupParameters / startupErrorResponse", () => {
  it("lit une liste bien formée, refuse le reste", () => {
    expect(parseStartupParameters(Buffer.from("user\0u\0database\0d\0\0"))).toEqual(
      new Map([
        ["user", "u"],
        ["database", "d"],
      ]),
    );
    expect(parseStartupParameters(Buffer.from("user\0u\0"))).toBeNull();
    expect(parseStartupParameters(Buffer.from("user\0u\0\0extra"))).toBeNull();
    expect(parseStartupParameters(Buffer.from(""))).toBeNull();
  });

  it("produit un ErrorResponse FATAL de longueur exacte", () => {
    const e = startupErrorResponse("no");
    expect(e.toString("latin1", 0, 1)).toBe("E");
    expect(e.readInt32BE(1)).toBe(e.length - 1);
  });
});
