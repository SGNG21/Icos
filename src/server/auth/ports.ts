import type { AuthenticatedSession, HumanUser, Role, UserStatus } from "@/core/identity";

/** Lecture des identités humaines (table `user` Better Auth). */
export interface HumanUserRepository {
  findById(id: string): Promise<HumanUser | null>;
  findByEmail(email: string): Promise<HumanUser | null>;
}

export type GuardedResult = { ok: true } | { ok: false; reason: "last_owner" | "not_found" };

/**
 * Rôles applicatifs ICOS (table `user_roles`). Les opérations touchant le statut
 * d'owner (retrait, désactivation) doivent être garanties transactionnellement
 * contre le retrait du dernier owner actif.
 */
export interface RoleRepository {
  listRoles(userId: string): Promise<Role[]>;
  grantRole(userId: string, role: Role): Promise<void>;
  listActiveOwnerIds(): Promise<string[]>;
  revokeRole(userId: string, role: Role): Promise<GuardedResult>;
  setUserStatus(userId: string, status: UserStatus): Promise<GuardedResult>;
}

export type CreateHumanUserResult =
  { ok: true; userId: string } | { ok: false; reason: "already_exists" | "invalid_input" };

/** Façade HTTP étroite : les réponses ICOS ne transportent jamais le token natif. */
export interface AuthHttpGateway {
  signIn(input: {
    email: string;
    password: string;
    headers: Headers;
  }): Promise<{ headers: Headers; userId: string }>;
  signOut(headers: Headers): Promise<{ headers: Headers; success: boolean }>;
}

/**
 * Façade étroite ICOS au-dessus de Better Auth. Les routes et guards ICOS ne
 * dépendent que de cette interface, jamais des internes de Better Auth.
 */
export interface AuthGateway {
  createHumanUser(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<CreateHumanUserResult>;
  readHumanUser(userId: string): Promise<HumanUser | null>;
  readHumanUserByEmail(email: string): Promise<HumanUser | null>;
  /** Suppression (cascade compte/sessions/rôles) — utilisée en compensation. */
  deleteHumanUser(userId: string): Promise<void>;
  /**
   * Session projetée ICOS, `null` si elle n'existe plus, ou erreur
   * `account_disabled` si l'identité associée est absente ou invalide.
   */
  readSession(headers: Headers): Promise<AuthenticatedSession | null>;
  revokeSession(headers: Headers): Promise<void>;
  revokeUserSessions(userId: string): Promise<void>;
}
