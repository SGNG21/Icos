import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalAuthority,
  canonicalJsonStringify,
  ensureAuthorityKeypair,
  generateApprovalNonce,
  signApprovalPayload,
  APPROVAL_SCHEMA_VERSION,
  type ExpectedSignedEffect,
  type SignedApprovalPayload,
} from "./approval-authority";

const exec = promisify(execFile);

/**
 * NF-1 (Phase 2B) — Tests de NON-FORGEABILITÉ de l'autorité d'approbation.
 *
 * Modèle d'attaque : un worker / sous-processus du dépôt avec les
 * permissions NORMALES du workspace. Il peut : lire la clé publique,
 * écrire n'importe quel artefact, générer ses propres paires de clés,
 * altérer/rejouer des artefacts. Il ne possède PAS la clé privée de
 * l'autorité (hors workspace, 0600).
 */

let base: string;
let authorityDir: string; // simule ~/.icos/approval-authority (HORS workspace)
let workspaceDir: string; // tout ce que le worker peut écrire

const NOW = new Date("2026-08-16T12:00:00.000Z");

function expected(overrides?: Partial<ExpectedSignedEffect>): ExpectedSignedEffect {
  return {
    scope: "git-push+pr-create",
    missionId: "mission-001",
    repository: "/canonical/repo",
    branch: "integration/dag-1",
    ...overrides,
  };
}

function makePayload(overrides?: Partial<SignedApprovalPayload>): SignedApprovalPayload {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    scope: "git-push+pr-create",
    missionId: "mission-001",
    repository: "/canonical/repo",
    branch: "integration/dag-1",
    nonce: generateApprovalNonce(),
    approvedBy: "owner@icos",
    approvedAt: "2026-08-16T11:55:00.000Z",
    expiresAt: "2026-08-16T13:00:00.000Z",
    ...overrides,
  };
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "nf1-"));
  authorityDir = path.join(base, "authority");
  workspaceDir = path.join(base, "workspace");
  await ensureAuthorityKeypair(authorityDir);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("ApprovalAuthority — chemin nominal", () => {
  it("accorde un artefact signé par l'autorité, liaisons exactes, fenêtre valide", async () => {
    const artifact = await signApprovalPayload(authorityDir, makePayload());
    const authority = new ApprovalAuthority(authorityDir);

    const decision = await authority.verify(artifact, expected(), NOW);
    expect(decision.granted).toBe(true);
  });

  it("la signature est indépendante de l'ordre des clés du payload (forme canonique)", async () => {
    const payload = makePayload();
    const artifact = await signApprovalPayload(authorityDir, payload);
    // Réordonner les clés du payload sans en changer le contenu.
    const reordered = Object.fromEntries(Object.entries(artifact.payload).reverse());
    const authority = new ApprovalAuthority(authorityDir);

    const decision = await authority.verify({ ...artifact, payload: reordered }, expected(), NOW);
    expect(decision.granted).toBe(true);
  });

  it("consomme le nonce : le MÊME artefact ne peut pas être utilisé deux fois (anti-rejeu)", async () => {
    const artifact = await signApprovalPayload(authorityDir, makePayload());
    const authority = new ApprovalAuthority(authorityDir);

    const first = await authority.verifyAndConsume(artifact, expected(), NOW);
    expect(first.granted).toBe(true);

    const replay = await authority.verifyAndConsume(artifact, expected(), NOW);
    expect(replay.granted).toBe(false);
    if (!replay.granted) expect(replay.code).toBe("replayed_nonce");
  });
});

describe("ApprovalAuthority — NON-FORGEABILITÉ", () => {
  it("REFUSE un artefact auto-signé par une clé attaquant (le worker n'a pas la clé privée)", async () => {
    // L'attaquant génère SA propre paire de clés et signe un payload
    // parfaitement conforme.
    const attacker = generateKeyPairSync("ed25519");
    const payload = makePayload();
    const forgedSignature = sign(
      null,
      Buffer.from(canonicalJsonStringify(payload), "utf-8"),
      attacker.privateKey,
    ).toString("base64");

    const authority = new ApprovalAuthority(authorityDir);
    const decision = await authority.verify(
      { algorithm: "ed25519", payload, signature: forgedSignature },
      expected(),
      NOW,
    );

    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("bad_signature");
  });

  it("REFUSE un payload altéré après signature (ex. branche changée)", async () => {
    const artifact = await signApprovalPayload(
      authorityDir,
      makePayload({ branch: "integration/innocuous" }),
    );
    const tampered = {
      ...artifact,
      payload: { ...artifact.payload, branch: "integration/dag-1" },
    };

    const authority = new ApprovalAuthority(authorityDir);
    const decision = await authority.verify(tampered, expected(), NOW);

    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("bad_signature");
  });

  it("IGNORE toute clé publique embarquée dans l'artefact (seule l'ancre de confiance compte)", async () => {
    const attacker = generateKeyPairSync("ed25519");
    const payload = makePayload();
    const forged = {
      algorithm: "ed25519",
      payload,
      signature: sign(
        null,
        Buffer.from(canonicalJsonStringify(payload), "utf-8"),
        attacker.privateKey,
      ).toString("base64"),
      // Tentative de smuggling : fournir sa propre clé de vérification.
      publicKey: attacker.publicKey.export({ type: "spki", format: "pem" }),
    };

    const authority = new ApprovalAuthority(authorityDir);
    const decision = await authority.verify(forged, expected(), NOW);

    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("bad_signature");
  });

  it("PREUVE SOUS-PROCESSUS : un vrai sous-processus du dépôt, avec le matériel visible du workspace, ne peut pas forger une approbation acceptée", async () => {
    // Le sous-processus reçoit UNIQUEMENT ce qu'un worker voit : le chemin
    // de la clé publique et la liaison attendue. Il fait de son mieux :
    // il génère sa propre paire Ed25519 et signe la forme canonique exacte.
    const payloadJson = JSON.stringify(makePayload());
    const outPath = path.join(workspaceDir, "forged-approval.json");
    await exec("node", [
      "-e",
      `
      const { generateKeyPairSync, sign } = require("node:crypto");
      const fs = require("node:fs");
      const [payloadJson, outPath] = process.argv.slice(1);
      const canonical = (v) => {
        if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
        if (v !== null && typeof v === "object") {
          return "{" + Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
            .join(",") + "}";
        }
        return JSON.stringify(v);
      };
      const payload = JSON.parse(payloadJson);
      const { privateKey } = generateKeyPairSync("ed25519");
      const signature = sign(null, Buffer.from(canonical(payload), "utf-8"), privateKey)
        .toString("base64");
      fs.mkdirSync(require("node:path").dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify({ algorithm: "ed25519", payload, signature }));
      `,
      payloadJson,
      outPath,
    ]);

    const authority = new ApprovalAuthority(authorityDir);
    const decision = await authority.loadVerifyAndConsume(outPath, expected(), NOW);

    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("bad_signature");
  });

  it("la clé privée de l'autorité est en 0600 et HORS du workspace", async () => {
    const st = await stat(path.join(authorityDir, "authority-private.pem"));
    expect(st.mode & 0o777).toBe(0o600);
    // Elle ne vit pas sous le workspace du worker.
    expect(authorityDir.startsWith(workspaceDir)).toBe(false);
  });
});

describe("ApprovalAuthority — liaisons exactes (mismatch → DENY)", () => {
  async function denyCase(
    payloadOverrides: Partial<SignedApprovalPayload>,
    expectedCode: string,
    expectedOverrides?: Partial<ExpectedSignedEffect>,
  ): Promise<void> {
    const artifact = await signApprovalPayload(authorityDir, makePayload(payloadOverrides));
    const authority = new ApprovalAuthority(authorityDir);
    const decision = await authority.verify(artifact, expected(expectedOverrides), NOW);
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe(expectedCode);
  }

  it("périmètre différent → scope_mismatch", async () => {
    await denyCase({ scope: "git-push-only" }, "scope_mismatch");
  });

  it("mission différente → mission_mismatch", async () => {
    await denyCase({ missionId: "mission-OTHER" }, "mission_mismatch");
  });

  it("tâche différente (quand exigée) → task_mismatch", async () => {
    await denyCase({ taskId: "task-B" }, "task_mismatch", { taskId: "task-A" });
  });

  it("dépôt différent → repository_mismatch", async () => {
    await denyCase({ repository: "/other/repo" }, "repository_mismatch");
  });

  it("branche différente → branch_mismatch (correspondance EXACTE uniquement)", async () => {
    await denyCase({ branch: "integration/dag-2" }, "branch_mismatch");
  });

  it("NF-6 : un joker de branche est REJETÉ au niveau du schéma (malformed)", async () => {
    const authority = new ApprovalAuthority(authorityDir);
    // Impossible de signer un joker (le schéma refuse) — un attaquant qui
    // contourne la signature côté artefact est de toute façon refusé.
    await expect(
      signApprovalPayload(authorityDir, makePayload({ branch: "integration/*" })),
    ).rejects.toThrow();

    const decision = await authority.verify(
      {
        algorithm: "ed25519",
        payload: makePayload({ branch: "integration/*" }),
        signature: "AAAA",
      },
      expected(),
      NOW,
    );
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("malformed");
  });
});

describe("ApprovalAuthority — fraîcheur (NF-6)", () => {
  async function denyTime(
    payloadOverrides: Partial<SignedApprovalPayload>,
    expectedCode: string,
  ): Promise<void> {
    const artifact = await signApprovalPayload(authorityDir, makePayload(payloadOverrides));
    const authority = new ApprovalAuthority(authorityDir);
    const decision = await authority.verify(artifact, expected(), NOW);
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe(expectedCode);
  }

  it("expirée → expired", async () => {
    await denyTime(
      { approvedAt: "2026-08-16T09:00:00.000Z", expiresAt: "2026-08-16T10:00:00.000Z" },
      "expired",
    );
  });

  it("approvedAt dans le futur (au-delà de la tolérance d'horloge) → future_dated", async () => {
    await denyTime(
      { approvedAt: "2026-08-16T13:00:00.000Z", expiresAt: "2026-08-16T14:00:00.000Z" },
      "future_dated",
    );
  });

  it("fenêtre > TTL max (24 h) → ttl_exceeded", async () => {
    await denyTime(
      { approvedAt: "2026-08-16T11:00:00.000Z", expiresAt: "2026-08-19T11:00:00.000Z" },
      "ttl_exceeded",
    );
  });

  it("expiresAt ≤ approvedAt → invalid_window", async () => {
    await denyTime(
      { approvedAt: "2026-08-16T11:59:00.000Z", expiresAt: "2026-08-16T11:58:00.000Z" },
      "invalid_window",
    );
  });
});

describe("ApprovalAuthority — conditions invérifiables (fail-closed)", () => {
  it("clé publique de l'autorité absente → missing_authority_key", async () => {
    const emptyAuthority = new ApprovalAuthority(path.join(base, "no-authority"));
    const artifact = await signApprovalPayload(authorityDir, makePayload());

    const decision = await emptyAuthority.verify(artifact, expected(), NOW);
    expect(decision.granted).toBe(false);
    if (!decision.granted) expect(decision.code).toBe("missing_authority_key");
  });

  it("artefact absent → missing ; non-JSON → malformed", async () => {
    const authority = new ApprovalAuthority(authorityDir);

    const missing = await authority.loadVerifyAndConsume(
      path.join(workspaceDir, "nope.json"),
      expected(),
      NOW,
    );
    expect(missing.granted).toBe(false);
    if (!missing.granted) expect(missing.code).toBe("missing");

    const badPath = path.join(base, "bad.json");
    await writeFile(badPath, "{not json");
    const malformed = await authority.loadVerifyAndConsume(badPath, expected(), NOW);
    expect(malformed.granted).toBe(false);
    if (!malformed.granted) expect(malformed.code).toBe("malformed");
  });

  it("artefact sans signature / nonce invalide → malformed", async () => {
    const authority = new ApprovalAuthority(authorityDir);

    const noSig = await authority.verify(
      { algorithm: "ed25519", payload: makePayload() },
      expected(),
      NOW,
    );
    expect(noSig.granted).toBe(false);
    if (!noSig.granted) expect(noSig.code).toBe("malformed");

    const badNonce = await authority.verify(
      {
        algorithm: "ed25519",
        payload: makePayload({ nonce: "short" as never }),
        signature: "AAAA",
      },
      expected(),
      NOW,
    );
    expect(badNonce.granted).toBe(false);
    if (!badNonce.granted) expect(badNonce.code).toBe("malformed");
  });

  it("ensureAuthorityKeypair n'écrase JAMAIS une clé privée existante", async () => {
    const before = await readFile(path.join(authorityDir, "authority-private.pem"), "utf-8");
    const second = await ensureAuthorityKeypair(authorityDir);
    const after = await readFile(path.join(authorityDir, "authority-private.pem"), "utf-8");

    expect(second.created).toBe(false);
    expect(after).toBe(before);
  });
});
