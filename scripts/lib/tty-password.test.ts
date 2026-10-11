/**
 * THE DECODER, PINNED AGAINST THE THREE CORRUPTIONS MEASURED IN A REAL PTY.
 *
 * Each case below was produced by the previous reader with a fake password, and each one
 * reached Better Auth as a wrong value whose only trace was `WARN [Better Auth]: Invalid
 * password` — a message indistinguishable from a genuinely wrong credential.
 *
 * These are pure-function tests: no terminal, no network, no credential. The pty-level
 * behaviours (no echo, Enter terminates, Ctrl+C restores the terminal) stay where only a
 * pty can judge them, in the harness's own run.
 */
import { describe, expect, it } from "vitest";

import { emptyKeyState, feedKeys, type KeyState } from "./tty-password";

const FAKE = "ZzFakePwd_991";
/** Feeds the keys the terminal would actually send, as one or more chunks. */
const type_ = (...chunks: string[]): KeyState =>
  chunks.reduce((state, chunk) => feedKeys(state, chunk), emptyKeyState);

describe("feedKeys — what the terminal sends is not what was typed", () => {
  it("plain typing, then Enter", () => {
    const s = type_(`${FAKE}\r`);
    expect(s.value).toBe(FAKE);
    expect(s.done).toBe(true);
    expect(s.cancelled).toBe(false);
  });

  it("REGRESSION: a PASTE arrives wrapped in bracketed-paste markers — old reader added `[200~`", () => {
    const s = type_(`\u001b[200~${FAKE}\u001b[201~\r`);
    expect(s.value).toBe(FAKE);
    expect(s.stripped).toBe(2);
  });

  it("REGRESSION: Ctrl+U clears the line — old reader kept the typo", () => {
    const s = type_(`WRONG\u0015${FAKE}\r`);
    expect(s.value).toBe(FAKE);
  });

  it("REGRESSION: an arrow key is consumed whole — old reader added `[D`", () => {
    const s = type_(`Zz\u001b[DFakePwd_991\r`);
    expect(s.value).toBe(FAKE);
    expect(s.stripped).toBe(1);
  });

  it("an escape sequence split across two chunks is still consumed whole", () => {
    const s = type_("\u001b[20", `0~${FAKE}\u001b`, "[201~\r");
    expect(s.value).toBe(FAKE);
    expect(s.stripped).toBe(2);
  });

  it("backspace and Ctrl+W edit, and spaces inside the value survive", () => {
    expect(type_("abX\u007fc\r").value).toBe("abc");
    expect(type_("one two\u0017three\r").value).toBe("onethree");
    expect(type_("  pad ded  \r").value).toBe("  pad ded  ");
  });

  it("Ctrl+C cancels and Ctrl+D on an empty line gives up", () => {
    expect(type_(`${FAKE}\u0003`).cancelled).toBe(true);
    expect(type_("\u0004").cancelled).toBe(true);
    expect(type_(`${FAKE}\u0004`)).toMatchObject({ done: true, value: FAKE });
  });

  it("nothing after Enter can join the value", () => {
    const s = type_(`${FAKE}\rleaked`);
    expect(s.value).toBe(FAKE);
  });

  it("accented and non-ASCII characters are kept", () => {
    expect(type_("mot-dé-passé-£€\r").value).toBe("mot-dé-passé-£€");
  });

  it("a lone control byte is never part of the value", () => {
    expect(type_(`\u0000\u0001${FAKE}\u0002\r`).value).toBe(FAKE);
  });
});
