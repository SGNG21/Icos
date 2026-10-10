import { describe, expect, it } from "vitest";

import { DEFAULT_CHUNKING, renderSpeech, SpeechChunker, splitLong } from "./speech-text";

describe("renderSpeech — the spoken copy, display untouched", () => {
  it("removes markdown emphasis and headings", () => {
    expect(renderSpeech("**Bonjour**")).toBe("Bonjour");
    expect(renderSpeech("## Statut\n_tout_ va ~~mal~~ bien")).toBe("Statut tout va mal bien");
  });

  it("reads a link's label, never its URL; raw URLs are dropped", () => {
    expect(renderSpeech("Voir [OpenAI](https://openai.com/x?y=1).")).toBe("Voir OpenAI.");
    // The sentence's own period survives the URL it followed.
    expect(renderSpeech("Docs : https://example.com/a/b. Fin")).toBe("Docs. Fin");
    expect(renderSpeech("<https://a.b> et www.c.d/e")).toBe("et");
  });

  it("does not read code blocks by default (closed or still open)", () => {
    expect(renderSpeech("Lance ceci :\n```bash\nrm -rf /tmp/x\n```\nPuis attends.")).toBe(
      "Lance ceci : Puis attends.",
    );
    expect(renderSpeech("Exemple :\n```ts\nconst x = 1;")).toBe("Exemple :");
    expect(renderSpeech("la commande `pnpm test`")).toBe("la commande pnpm test");
  });

  it("turns lists into natural enumerations", () => {
    expect(renderSpeech("1. étape\n2. suite")).toBe("1, étape 2, suite");
    expect(renderSpeech("- pommes\n* poires\n• prunes")).toBe("pommes poires prunes");
  });

  it("drops machine identifiers and internal codes", () => {
    expect(renderSpeech("Mission 3f2b1c9a-1111-4222-8333-444455556666 lancée")).toBe(
      "Mission lancée",
    );
    expect(renderSpeech("commit dec9fcb7227c84123dd81d55f81c2fbfc7a871a5 ok")).toBe("commit ok");
    expect(renderSpeech("token run_8f7A6b5C4d3E2f1G0h9I8j7K6 ok")).toBe("token ok");
    expect(renderSpeech("Le moteur n'est pas connecté (NOT_CONNECTED) : réessaie")).toBe(
      "Le moteur n'est pas connecté : réessaie",
    );
  });

  it("collapses repetitive punctuation", () => {
    expect(renderSpeech("Quoi ?!?! Non!!! Bon.... Ok,,")).toBe("Quoi ? Non! Bon… Ok");
  });

  it("keeps numbers, dates, decimals and acronyms as written", () => {
    expect(renderSpeech("Le 10/10/2026, ICOS a fait 3,14 % ou 3.14 € à 14h30.")).toBe(
      "Le 10/10/2026, ICOS a fait 3,14 % ou 3.14 € à 14h30.",
    );
  });

  it("tables read as phrases, not pipes", () => {
    expect(renderSpeech("| Nom | Valeur |\n|---|---|\n| a | 1 |")).toBe("Nom, Valeur, a, 1");
  });
});

describe("SpeechChunker — natural boundaries, bounded chunks", () => {
  const all = (deltas: string[], options = DEFAULT_CHUNKING) => {
    const chunker = new SpeechChunker(options);
    const out = deltas.flatMap((d) => chunker.push(d));
    return [...out, ...chunker.flush()];
  };

  it("never one request per token: short sentences are merged up to the minimum", () => {
    const tokens = "Oui. Bien sûr. Je regarde. Voilà le résultat de la recherche demandée.".split(
      /(?<= )/,
    );
    const chunks = all(tokens);
    expect(chunks).toEqual([
      "Oui. Bien sûr. Je regarde.",
      "Voilà le résultat de la recherche demandée.",
    ]);
  });

  it("the first chunk may be shorter than the others: first audio sooner", () => {
    const chunker = new SpeechChunker({ minChars: 40, firstMinChars: 20, maxChars: 220 });
    expect(chunker.push("Bonjour Geoffrey, voici. ")).toEqual(["Bonjour Geoffrey, voici."]);
    expect(chunker.push("Court. ")).toEqual([]); // later chunks wait for 40 chars
  });

  it("does not split abbreviations, initials, decimals or URLs", () => {
    expect(
      all(["M. Dupont a vu le Dr. Martin, etc. puis J. Doe à 3.14 h sur https://x.y/a.b ok. "], {
        minChars: 0,
        firstMinChars: 0,
        maxChars: 400,
      }),
    ).toEqual(["M. Dupont a vu le Dr. Martin, etc. puis J. Doe à 3.14 h sur ok."]);
  });

  it("splits at ; : , or spaces when a sentence is too long, never mid-word", () => {
    const long = `${"mot ".repeat(30)}; ${"autre ".repeat(30)}fin.`;
    const chunks = all([long], { minChars: 40, firstMinChars: 20, maxChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      for (const word of chunk.split(" ")) expect(["mot", "autre", "fin.", ";"]).toContain(word);
    }
    // Every word is spoken once; a cut at the ";" is itself the pause.
    const words = (text: string) => text.split(/[\s;]+/).filter(Boolean);
    expect(words(chunks.join(" "))).toEqual(words(long));
  });

  it("does not wait for a whole paragraph: a long run without punctuation is spoken in pieces", () => {
    const chunker = new SpeechChunker({ minChars: 40, firstMinChars: 20, maxChars: 100 });
    const out = chunker.push("et ".repeat(60));
    expect(out.length).toBeGreaterThan(0);
  });

  it("holds an open code fence until it closes, and never reads it", () => {
    const chunker = new SpeechChunker({ minChars: 0, firstMinChars: 0, maxChars: 400 });
    expect(chunker.push("Voici. ``")).toEqual(["Voici."]);
    expect(chunker.push("`ts\nconst secret = 1;\n")).toEqual([]);
    expect(chunker.push("``` Et voilà. ")).toEqual(["Et voilà."]);
    expect(chunker.flush()).toEqual([]);
  });

  it("an unclosed fence at the end of the answer is dropped", () => {
    expect(all(["Exemple :\n```py\nprint(1)\n"])).toEqual(["Exemple :"]);
  });

  it("headings and list lines get a pause", () => {
    expect(
      all(["# Plan\n- un\n- deux\n"], { minChars: 0, firstMinChars: 0, maxChars: 400 }),
    ).toEqual(["Plan.", "un.", "deux."]);
  });

  it("splitLong keeps every word", () => {
    const text = "alpha beta gamma, delta epsilon; zeta eta theta iota kappa";
    expect(splitLong(text, 20).join(" ")).toBe(text);
  });
});
