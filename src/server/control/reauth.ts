import { randomBytes, randomUUID } from "node:crypto";

import { REAUTH_PROOF_TTL_MS } from "@/core/control/policy";

import { sha256 } from "./command-bus";
import type { ControlStore } from "./ports";

/**
 * BR-18 re-authentication proofs.
 *
 * The password is verified server-side against the CURRENT session and then
 * forgotten. The caller receives a random 256-bit token; only its SHA-256 is
 * stored, bound to user + session, valid 5 minutes, consumable exactly once by
 * an admitted command. Nothing here is ever written to the audit log.
 */
export interface PasswordVerifier {
  /** True only if `password` is the password of the session's user. */
  verifyPassword(headers: Headers, password: string): Promise<boolean>;
}

export type ReauthResult = { ok: true; proof: string; expiresAt: string } | { ok: false };

export class ReauthService {
  constructor(
    private readonly store: Pick<ControlStore, "insertReauthProof">,
    private readonly verifier: PasswordVerifier,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issue(input: {
    headers: Headers;
    userId: string;
    sessionId: string;
    password: string;
  }): Promise<ReauthResult> {
    let verified = false;
    try {
      verified = await this.verifier.verifyPassword(input.headers, input.password);
    } catch {
      verified = false;
    }
    if (!verified) return { ok: false };

    const proof = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + REAUTH_PROOF_TTL_MS).toISOString();
    await this.store.insertReauthProof({
      id: randomUUID(),
      tokenHash: sha256(proof),
      userId: input.userId,
      sessionId: input.sessionId,
      createdAt: createdAt.toISOString(),
      expiresAt,
    });
    return { ok: true, proof, expiresAt };
  }
}
