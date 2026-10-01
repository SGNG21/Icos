import { describe, expect, it } from "vitest";

import {
  fold,
  intentOf,
  isScopeChange,
  resolveReference,
  type DirectoryEntry,
  type ResolutionInput,
} from "./client-resolution";

const LDS: DirectoryEntry = {
  kind: "client",
  key: "lds-renov",
  name: "LDS Rénov'",
  aliases: ["lds", "lds renov", "lds rénov"],
  clientId: "lds-renov",
  sensitivity: "normal",
};
const MECENE: DirectoryEntry = {
  kind: "client",
  key: "editions-du-mecene",
  name: "Éditions du Mécène",
  aliases: ["mecene", "mécène", "le mécène", "l'éditeur"],
  clientId: "editions-du-mecene",
  sensitivity: "normal",
};
const LDS_SITE: DirectoryEntry = {
  kind: "project",
  key: "lds-site",
  name: "Refonte du site LDS",
  aliases: ["refonte site"],
  clientId: "lds-renov",
  sensitivity: "normal",
};

const NONE = { clientId: null, projectId: null };

const ask = (over: Partial<ResolutionInput> = {}): ResolutionInput => ({
  text: "",
  directory: [LDS, MECENE],
  current: NONE,
  previous: NONE,
  maxSensitivity: "sensitive",
  ...over,
});

describe("fold", () => {
  it("normalises accents, case and apostrophes", () => {
    expect(fold("LDS Rénov'")).toBe("lds renov");
    expect(fold("Éditions du Mécène")).toBe("editions du mecene");
    expect(fold("  l'éditeur  ")).toBe("l editeur");
  });
});

describe("CLIENT_RESOLUTION", () => {
  it("LDS_CASE: « Où en est LDS ? » resolves LDS Rénov' by alias", () => {
    const r = resolveReference(ask({ text: "Où en est LDS ?" }));
    expect(r).toMatchObject({
      kind: "resolved",
      clientId: "lds-renov",
      projectId: null,
      source: "alias",
      entityKey: "lds-renov",
    });
  });

  it("MECENE_CASE: « Et le Mécène ? » resolves Les Éditions du Mécène", () => {
    const r = resolveReference(ask({ text: "Et le Mécène ?" }));
    expect(r).toMatchObject({ kind: "resolved", clientId: "editions-du-mecene", source: "alias" });
  });

  it("resolves « l'éditeur » through its declared alias", () => {
    const r = resolveReference(ask({ text: "Et l'éditeur, on en est où ?" }));
    expect(r).toMatchObject({ kind: "resolved", clientId: "editions-du-mecene" });
  });

  it("ALIAS_RESOLUTION: canonical name outranks an alias of another client", () => {
    const r = resolveReference(ask({ text: "point sur Éditions du Mécène et lds" }));
    // Tier 2 (canonical name) matched, so tier 3 — where « lds » lives — is never consulted.
    expect(r).toMatchObject({
      kind: "resolved",
      clientId: "editions-du-mecene",
      source: "canonical_name",
    });
  });

  it("canonical identifier is the strongest tier", () => {
    const r = resolveReference(ask({ text: "charge le périmètre lds-renov" }));
    expect(r).toMatchObject({ kind: "resolved", source: "canonical_id", entityKey: "lds-renov" });
  });

  it("matches on whole words only: « ldsx » is not LDS", () => {
    const r = resolveReference(ask({ text: "ldsx va bien" }));
    expect(r.kind).toBe("unchanged");
  });
});

describe("PROJECT_RESOLUTION", () => {
  it("a project resolves to its client AND itself", () => {
    const r = resolveReference(
      ask({ text: "où en est la refonte site ?", directory: [LDS, LDS_SITE] }),
    );
    expect(r).toMatchObject({
      kind: "resolved",
      clientId: "lds-renov",
      projectId: "lds-site",
      entityKey: "lds-site",
    });
  });

  it("FAIL_CLOSED: a project with no owning client is not a usable scope", () => {
    const orphan = { ...LDS_SITE, clientId: null };
    const r = resolveReference(ask({ text: "refonte site", directory: [LDS, orphan] }));
    expect(r).toMatchObject({ kind: "ambiguous", reason: "project_without_client" });
  });
});

describe("AMBIGUITY_HANDLING", () => {
  it("never guesses between two equally specific matches", () => {
    const twin: DirectoryEntry = {
      ...MECENE,
      key: "lds-group",
      name: "LDS Group",
      aliases: ["lds"],
    };
    const r = resolveReference(ask({ text: "où en est lds ?", directory: [LDS, twin] }));
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(r.reason).toBe("multiple_matches");
    expect(r.candidates).toEqual(["LDS Group", "LDS Rénov'"]);
    expect(r.question).toContain("Précisez");
  });

  it("a strictly more specific match wins and is not ambiguous", () => {
    const twin: DirectoryEntry = {
      ...MECENE,
      key: "lds-group",
      name: "LDS Group",
      aliases: ["lds"],
    };
    const r = resolveReference(ask({ text: "où en est lds renov ?", directory: [LDS, twin] }));
    expect(r).toMatchObject({ kind: "resolved", clientId: "lds-renov" });
  });

  it("a qualified reference to an unknown client asks instead of picking the active one", () => {
    const r = resolveReference(
      ask({
        text: "et le client de Cannes ?",
        current: { clientId: "lds-renov", projectId: null },
      }),
    );
    expect(r).toMatchObject({ kind: "ambiguous", reason: "unknown_reference" });
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(r.candidates).toEqual(["LDS Rénov'", "Éditions du Mécène"]);
  });

  it("an unqualified mention of « clients » is not a reference", () => {
    const r = resolveReference(ask({ text: "combien de clients avons-nous ?" }));
    expect(r.kind).toBe("unchanged");
  });
});

describe("CURRENT_CONTEXT_RESOLUTION / PRONOUN_REFERENCE_RESOLUTION", () => {
  const current = { clientId: "lds-renov", projectId: null };

  it("« ce client » uses the current pointer", () => {
    const r = resolveReference(ask({ text: "relance ce client", current }));
    expect(r).toMatchObject({ kind: "resolved", clientId: "lds-renov", source: "current_context" });
  });

  it("« ça » uses the current pointer", () => {
    const r = resolveReference(ask({ text: "occupe-toi de ça", current }));
    expect(r).toMatchObject({ kind: "resolved", clientId: "lds-renov", source: "current_context" });
  });

  it("« continue » falls back to the most recent durable scope when nothing is active", () => {
    const r = resolveReference(
      ask({
        text: "continue ce qu'on faisait",
        recent: { clientId: "editions-du-mecene", projectId: null },
      }),
    );
    expect(r).toMatchObject({
      kind: "resolved",
      clientId: "editions-du-mecene",
      source: "recent_context",
    });
  });

  it("FAIL_CLOSED: a STRONG deictic with no context asks rather than choosing", () => {
    const r = resolveReference(ask({ text: "relance ce client" }));
    expect(r).toMatchObject({ kind: "ambiguous", reason: "no_current_context" });
  });

  it("a bare pronoun with no context stays unscoped instead of interrogating the user", () => {
    // Regression: « ça » appears in ordinary French. Asking « de quel client ? » on every such
    // sentence would make unscoped conversations unusable. Unscoped is still fail-safe: no
    // client knowledge can enter the prompt.
    for (const text of ["ça va ?", "j'ai fait ça hier", "occupe-toi de ça"]) {
      expect(resolveReference(ask({ text }))).toEqual({
        kind: "unchanged",
        clientId: null,
        projectId: null,
      });
    }
  });

  it("ordinary French does not trigger a return or a continuation reference", () => {
    for (const text of ["retourne-moi la liste des devis", "go back to the report"]) {
      expect(resolveReference(ask({ text })).kind).toBe("unchanged");
    }
  });
});

describe("PROJECT scope is not silently dropped", () => {
  it("naming the client we are already on confirms it and keeps the project", () => {
    const current = { clientId: "lds-renov", projectId: "lds-site" };
    const r = resolveReference(
      ask({ text: "où en est LDS ?", current, directory: [LDS, LDS_SITE] }),
    );
    expect(r).toMatchObject({ kind: "resolved", clientId: "lds-renov", projectId: "lds-site" });
    expect(isScopeChange(r, current)).toBe(false);
  });

  it("naming a DIFFERENT client still replaces the whole scope", () => {
    const current = { clientId: "lds-renov", projectId: "lds-site" };
    const r = resolveReference(
      ask({ text: "et le Mécène ?", current, directory: [LDS, LDS_SITE, MECENE] }),
    );
    expect(r).toMatchObject({ kind: "resolved", clientId: "editions-du-mecene", projectId: null });
  });
});

describe("RETURN_TO_PREVIOUS_CLIENT", () => {
  it("« reviens à LDS » resolves by name, not by pointer", () => {
    const r = resolveReference(
      ask({
        text: "reviens à LDS",
        current: { clientId: "editions-du-mecene", projectId: null },
        previous: { clientId: "lds-renov", projectId: null },
      }),
    );
    expect(r).toMatchObject({ kind: "resolved", clientId: "lds-renov", source: "alias" });
  });

  it("« reviens en arrière » uses the previous pointer", () => {
    const r = resolveReference(
      ask({
        text: "reviens en arrière",
        current: { clientId: "editions-du-mecene", projectId: null },
        previous: { clientId: "lds-renov", projectId: "lds-site" },
      }),
    );
    expect(r).toMatchObject({
      kind: "resolved",
      clientId: "lds-renov",
      projectId: "lds-site",
      source: "previous_context",
    });
  });

  it("FAIL_CLOSED: nothing to return to asks instead of guessing", () => {
    const r = resolveReference(ask({ text: "reviens en arrière" }));
    expect(r).toMatchObject({ kind: "ambiguous", reason: "no_previous_context" });
  });

  it("FAIL_CLOSED: a pointer to a client this actor can no longer resolve is not adopted", () => {
    // The client became `sensitive`; a viewer must not re-enter it through « reviens ».
    const sensitive: DirectoryEntry = { ...LDS, sensitivity: "sensitive" };
    const r = resolveReference(
      ask({
        text: "reviens en arrière",
        directory: [sensitive, MECENE],
        previous: { clientId: "lds-renov", projectId: null },
        maxSensitivity: "normal",
      }),
    );
    expect(r).toMatchObject({ kind: "ambiguous", reason: "no_previous_context" });
  });

  it("FAIL_CLOSED: « continue » does not adopt an unresolvable recent scope", () => {
    const sensitive: DirectoryEntry = { ...LDS, sensitivity: "sensitive" };
    const r = resolveReference(
      ask({
        text: "continue ce qu'on faisait",
        directory: [sensitive, MECENE],
        recent: { clientId: "lds-renov", projectId: null },
        maxSensitivity: "normal",
      }),
    );
    expect(r).toMatchObject({ kind: "ambiguous", reason: "no_current_context" });
  });
});

describe("SCOPE_ISOLATION: sensitivity ceiling", () => {
  it("a restricted client is never resolvable, at any ceiling", () => {
    const secret: DirectoryEntry = { ...LDS, sensitivity: "restricted" };
    const r = resolveReference(
      ask({ text: "où en est LDS ?", directory: [secret, MECENE], maxSensitivity: "restricted" }),
    );
    // `unchanged`, not a clarification listing it: the answer must not even disclose that a
    // restricted client matching « LDS » exists.
    expect(r).toEqual({ kind: "unchanged", clientId: null, projectId: null });
  });

  it("a sensitive client is invisible to a normal actor", () => {
    const sensitive: DirectoryEntry = { ...LDS, sensitivity: "sensitive" };
    const r = resolveReference(
      ask({ text: "où en est LDS ?", directory: [sensitive, MECENE], maxSensitivity: "normal" }),
    );
    expect(r.kind).toBe("unchanged");
  });
});

describe("isScopeChange", () => {
  it("is false when the resolution confirms the current scope", () => {
    const current = { clientId: "lds-renov", projectId: null };
    const r = resolveReference(ask({ text: "où en est LDS ?", current }));
    expect(isScopeChange(r, current)).toBe(false);
  });

  it("is true when the client changes", () => {
    const current = { clientId: "lds-renov", projectId: null };
    const r = resolveReference(ask({ text: "et le Mécène ?", current }));
    expect(isScopeChange(r, current)).toBe(true);
  });

  it("is false for an ambiguous or unchanged resolution", () => {
    expect(isScopeChange({ kind: "unchanged", clientId: null, projectId: null }, NONE)).toBe(false);
    expect(
      isScopeChange(
        { kind: "ambiguous", question: "?", candidates: [], reason: "unknown_reference" },
        NONE,
      ),
    ).toBe(false);
  });
});

describe("intentOf", () => {
  it("classifies the referential intents the runtime depends on", () => {
    expect(intentOf(fold("reviens à LDS"))).toBe("return");
    expect(intentOf(fold("relance ce client"))).toBe("deictic");
    expect(intentOf(fold("occupe-toi de ça"))).toBe("weak_deictic");
    expect(intentOf(fold("continue"))).toBe("continue");
    expect(intentOf(fold("le client de Cannes"))).toBe("descriptive");
    expect(intentOf(fold("bonjour"))).toBe("none");
  });
});
