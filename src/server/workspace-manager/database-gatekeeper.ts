import net from "node:net";

/**
 * THE ONLY DOOR FROM THE GATE'S POSTGRES STEP TO A DATABASE (residual risk H1, ADR 0075).
 *
 * The step runs worker-authored code with the network namespace UNSHARED: it cannot open a
 * socket to anything on the host or beyond. ICOS opens this one door for it — a UNIX socket in
 * a directory bind-mounted into the sandbox — and the door is not a plain pipe. It reads the
 * PostgreSQL startup packet and forwards the connection to the test cluster only when it asks
 * for exactly the disposable database of this run, as exactly its disposable role:
 *
 *   - a test cluster may run with `trust` authentication (the local one does): without this
 *     check, any client reaching the cluster could log in as its superuser. The identity check
 *     is HERE, not delegated to `pg_hba.conf`;
 *   - `replication` connections, cancel requests and unknown protocol versions are refused
 *     (a cancel request carries no identity to check);
 *   - SSL/GSS encryption requests are answered `N`: the hop is a local socket, and an
 *     encrypted startup packet could not be inspected.
 *
 * Nothing else is reachable through it: the upstream address is fixed by ICOS, never chosen by
 * the client.
 */

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
const PROTOCOL_3_0 = 196608;
/** PostgreSQL's own MAX_STARTUP_PACKET_LENGTH. */
const MAX_STARTUP_PACKET = 10_000;

export interface DatabaseGatekeeperOptions {
  /** UNIX socket path to listen on (its directory is what the sandbox sees). */
  readonly socketPath: string;
  /** The test cluster. Fixed by ICOS; a client cannot pick another destination. */
  readonly upstream: { readonly host: string; readonly port: number };
  /** The only role a client may present. */
  readonly user: string;
  /** The only database a client may open. */
  readonly database: string;
  readonly handshakeTimeoutMs?: number;
}

export interface DatabaseGatekeeper {
  /** Why each refused connection was refused, in order (evidence; holds no secret). */
  readonly refusals: readonly string[];
  /** Number of connections forwarded to the cluster. */
  readonly forwarded: number;
  /** Stops listening and cuts every live connection, both sides. */
  close(): Promise<void>;
}

/** `key\0value\0…\0` → map; `null` if the body is not a well-formed parameter list. */
export function parseStartupParameters(body: Buffer): Map<string, string> | null {
  const params = new Map<string, string>();
  let offset = 0;
  const readCString = (): string | null => {
    const end = body.indexOf(0, offset);
    if (end < 0) return null;
    const value = body.toString("utf8", offset, end);
    offset = end + 1;
    return value;
  };
  for (;;) {
    if (offset >= body.length) return null;
    if (body[offset] === 0) return offset === body.length - 1 ? params : null;
    const key = readCString();
    if (key === null) return null;
    const value = readCString();
    if (value === null) return null;
    params.set(key, value);
  }
}

/** A FATAL `ErrorResponse` (SQLSTATE 28000, invalid authorization), as a server would send. */
export function startupErrorResponse(message: string): Buffer {
  const field = (code: string, value: string) => Buffer.from(`${code}${value}\0`, "utf8");
  const fields = Buffer.concat([
    field("S", "FATAL"),
    field("V", "FATAL"),
    field("C", "28000"),
    field("M", message),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(5);
  head.write("E", 0, "ascii");
  head.writeInt32BE(fields.length + 4, 1);
  return Buffer.concat([head, fields]);
}

const shown = (v: string | undefined) => JSON.stringify((v ?? "").slice(0, 64));

export async function startDatabaseGatekeeper(
  options: DatabaseGatekeeperOptions,
): Promise<DatabaseGatekeeper> {
  const sockets = new Set<net.Socket>();
  const refusals: string[] = [];
  let forwarded = 0;
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  };

  const server = net.createServer((client) => {
    track(client);
    client.on("error", () => client.destroy());
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => {
      refusals.push("handshake timeout");
      client.destroy();
    }, options.handshakeTimeoutMs ?? 10_000);
    timer.unref();

    const refuse = (why: string) => {
      clearTimeout(timer);
      client.off("data", onData);
      refusals.push(why);
      client.end(startupErrorResponse(`ICOS gate: ${why}`));
    };

    const forward = () => {
      clearTimeout(timer);
      client.off("data", onData);
      client.pause();
      const upstream = net.connect(options.upstream.port, options.upstream.host);
      track(upstream);
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("connect", () => {
        forwarded++;
        /* The startup packet and anything the client already pipelined after it. */
        upstream.write(pending);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
    };

    function onData(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const length = pending.readInt32BE(0);
        if (length < 8 || length > MAX_STARTUP_PACKET) return refuse("invalid startup packet");
        if (pending.length < length) return;
        const code = pending.readInt32BE(4);
        if (length === 8 && (code === SSL_REQUEST || code === GSSENC_REQUEST)) {
          client.write("N");
          pending = pending.subarray(8);
          continue;
        }
        if (code === CANCEL_REQUEST) return refuse("cancel requests are not forwarded");
        if (code !== PROTOCOL_3_0) return refuse("unsupported protocol version");
        const params = parseStartupParameters(pending.subarray(8, length));
        if (!params) return refuse("malformed startup packet");
        if (params.has("replication")) return refuse("replication connections are refused");
        const user = params.get("user");
        const database = params.get("database") || user;
        if (user !== options.user || database !== options.database) {
          return refuse(
            `only database ${options.database} as role ${options.user} (asked ${shown(database)} as ${shown(user)})`,
          );
        }
        return forward();
      }
    }
    client.on("data", onData);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    refusals,
    get forwarded() {
      return forwarded;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
