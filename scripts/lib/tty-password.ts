/**
 * READING A PASSWORD FROM A TERMINAL — THE PART THAT WAS WRONG.
 *
 * Hiding the echo was never the hard part. Decoding the keys was, and the first version got
 * it wrong in a way that looked like a rejected credential. Measured in a real pty, with a
 * fake password, against the previous reader:
 *
 *   typed by hand                 -> "ZzFakePwd_991"            (correct)
 *   PASTED (bracketed paste)      -> "[200~ZzFakePwd_991[201~"  (+10 chars)
 *   typo, Ctrl+U to clear, retype -> "WRONGZzFakePwd_991"       (the typo stayed)
 *   left arrow pressed mid-entry  -> "Zz[DFakePwd_991"          (+2 chars)
 *
 * The cause of all three: the old loop dropped characters below space — so it dropped the
 * ESC that *introduces* an escape sequence — and then appended the sequence's printable
 * tail as if it were typed. `\x1b[200~` lost its ESC and contributed `[200~`. The same loop
 * silently ignored Ctrl+U, so a user clearing a typo kept the typo.
 *
 * Every one of those produces a correct-looking prompt and an HTTP 401 whose server-side
 * log says "Invalid password" — indistinguishable from a wrong password, which is exactly
 * how it cost an evening.
 *
 * So the decoder is a pure function over (state, chunk), unit-tested without a terminal, and
 * escape sequences are consumed WHOLE instead of partially dropped.
 */

/** Terminal input decoded so far. `pending` holds an escape sequence split across chunks. */
export interface KeyState {
  readonly value: string;
  readonly pending: string;
  readonly done: boolean;
  readonly cancelled: boolean;
  /** How many escape sequences were swallowed — reported as a count, never as content. */
  readonly stripped: number;
}

export const emptyKeyState: KeyState = Object.freeze({
  value: "",
  pending: "",
  done: false,
  cancelled: false,
  stripped: 0,
});

const ESC = "\u001b";
/** A CSI sequence ends at the first byte in @..~ — which covers `\x1b[200~` and arrows. */
const csiFinal = (ch: string) => ch >= "@" && ch <= "~";

/**
 * Feeds one raw-mode chunk. Pure: same state in, same state out, no terminal involved.
 */
export function feedKeys(state: KeyState, chunk: string): KeyState {
  let { value, pending, done, cancelled, stripped } = state;

  for (const ch of chunk) {
    if (done || cancelled) break;

    /* Inside an escape sequence: consume it WHOLE. This is the fix. */
    if (pending) {
      pending += ch;
      const isCsi = pending.startsWith(`${ESC}[`) || pending.startsWith(`${ESC}O`);
      if (!isCsi && pending.length === 2) {
        pending = "";
        stripped += 1;
      } else if (isCsi && pending.length > 2 && csiFinal(ch)) {
        pending = "";
        stripped += 1;
      } else if (pending.length > 32) {
        /* Not a sequence we recognise; refuse to accumulate forever. */
        pending = "";
        stripped += 1;
      }
      continue;
    }

    if (ch === ESC) {
      pending = ESC;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      done = true;
      continue;
    }
    if (ch === "\u0003") {
      cancelled = true;
      continue;
    }
    if (ch === "\u0004") {
      /* Ctrl+D: end of input. On an empty entry it means "give up". */
      if (value === "") cancelled = true;
      else done = true;
      continue;
    }
    if (ch === "\u0015") {
      /* Ctrl+U: clear the line. Ignoring this is what kept a typo in the credential. */
      value = "";
      continue;
    }
    if (ch === "\u0017") {
      /* Ctrl+W: drop the last word. */
      value = value.replace(/\S+$/, "").replace(/\s+$/, "");
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      value = value.slice(0, -1);
      continue;
    }
    if (ch >= " ") {
      value += ch;
      continue;
    }
    /* Any other control byte is not part of a password. */
  }

  return { value, pending, done, cancelled, stripped };
}

/** What was read, plus non-revealing shape so a failure can be attributed. */
export interface TypedSecret {
  readonly value: string;
  readonly source: "env" | "tty";
  readonly strippedSequences: number;
}

/**
 * Reads a secret from the TERMINAL with no echo, or takes `ICOS_OWNER_PASSWORD` when set so
 * CI needs no terminal. No shell in the path: `read -rs` strips leading and trailing IFS
 * whitespace, invisibly, which produces exactly the 401 this file exists to stop.
 */
export async function readSecretFromTty(
  prompt: string,
  envValue = process.env.ICOS_OWNER_PASSWORD,
): Promise<TypedSecret> {
  if (envValue) return { value: envValue, source: "env", strippedSequences: 0 };

  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error(
      "no ICOS_OWNER_PASSWORD and stdin is not a terminal: run this from an interactive shell",
    );
  }

  const wasRaw = stdin.isRaw;
  const restore = () => {
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* the terminal is already gone; nothing to restore */
    }
    stdin.pause();
  };
  process.once("exit", restore);

  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  let state = emptyKeyState;
  try {
    const final = await new Promise<KeyState>((resolve) => {
      const onData = (chunk: string) => {
        state = feedKeys(state, chunk);
        if (state.done || state.cancelled) {
          stdin.off("data", onData);
          resolve(state);
        }
      };
      stdin.on("data", onData);
    });
    if (final.cancelled) throw new Error("saisie annulee (Ctrl+C)");
    return { value: final.value, source: "tty", strippedSequences: final.stripped };
  } finally {
    restore();
    process.removeListener("exit", restore);
    /* Length, not content: the only feedback a no-echo prompt can honestly give. */
    process.stdout.write(
      `\n(${state.value.length} caracteres lus` +
        (state.stripped ? `, ${state.stripped} sequence(s) terminal ignoree(s)` : "") +
        ")\n",
    );
  }
}
