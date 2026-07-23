# User-Agent Administration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter l’administration interne des humains et de leurs rattachements aux agents IA, puis appliquer ces rattachements comme portée opérationnelle serveur sans confondre identité humaine, rôle ICOS et autonomie d’agent.

**Architecture:** `HumanAdministrationService` orchestre les politiques pures, l’unique `AuthGateway` Better Auth et une `HumanAdministrationUnitOfWork` transactionnelle. Les lectures administratives et de rattachements passent par des ports dédiés ; `OperationalAccessService` calcule une portée globale ou liée que les repositories PostgreSQL appliquent avant toute exposition ou mutation. Le container PostgreSQL compose l’ensemble sur son unique `Database`, tandis que le backend mémoire reste explicitement dépourvu d’administration.

**Tech Stack:** Node.js 24, Next.js 16.2.10 App Router, React 19.2.7, TypeScript 6.0.3 strict, Better Auth 1.6.23, Drizzle ORM 0.45.2, postgres.js 3.4.9, Zod 4.4.3, Vitest 4.1.10, Testcontainers 12.0.4 et PostgreSQL 16.

## Global Constraints

- Exécuter toutes les commandes avec Node.js `>=24 <25` et pnpm `>=11.10.0 <12`.
- `NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST` : chaque comportement suit RED, GREEN, REFACTOR.
- Aucun nouveau package, plugin, MCP, Playwright, SkillsMP, Codex reviewer ou CI.
- Better Auth reste l’autorité unique pour l’identité humaine, les credentials et les sessions.
- ICOS reste l’autorité unique pour les rôles humains, les permissions, le statut métier, les rattachements et l’audit.
- `HumanUser`, `Agent`, `Role`, `Agent.authorizationLevel` et `HumanAgentLink.relation` restent des concepts distincts.
- Toute autorisation et toute portée sont vérifiées côté serveur ; le proxy et l’interface ne sont jamais des barrières de sécurité.
- Réutiliser exactement l’unique `Database`, l’unique instance Better Auth et le container mémoïsé existants.
- Aucune connexion PostgreSQL à l’import, aucun second pool et aucun fallback silencieux vers `memory`.
- Le container mémoire ne compose ni service administratif ni UoW administratif runtime.
- Aucun mot de passe, hash, cookie, token, secret, contenu de session, headers complets, `DATABASE_URL`, SQL brut ou stack trace dans les réponses, logs, audits ou fixtures.
- Ne jamais modifier `drizzle/0000*`, `0001*`, `0002*`, `0003*` ni leurs snapshots historiques.
- Créer uniquement une migration additive `0004` et son snapshot ; ajouter uniquement l’index 4 au journal.
- Les FKs de `human_agent_links` utilisent `ON DELETE RESTRICT` ; aucune cascade destructive.
- Ne jamais travailler sur `main`, ne pas reset, ne pas stash et ne supprimer aucun travail existant.
- Le fichier non suivi `docs/ICOS_MASTER_PLAN.md` reste intact et sera inclus délibérément dans la documentation de la branche, sans modification de contenu.
- Chaque commit se termine par `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Pousser et ouvrir une PR, mais ne jamais fusionner sans autorisation explicite.

## File Map

**Create:**

- `src/core/identity/human-agent-link.ts` — contrat pur du rattachement et enum fermée.
- `src/core/identity/human-agent-link.test.ts` — validation du contrat.
- `src/core/identity/role-management.test.ts` — politiques acteur/cible.
- `src/server/administration/audit.ts` — constructeurs fermés des audits administratifs.
- `src/server/administration/audit.test.ts` — contenu autorisé et assertions anti-secret.
- `src/server/administration/human-administration-service.ts` — orchestration indépendante de Next.js.
- `src/server/administration/human-administration-service.test.ts` — création, compensation, mutations, refus.
- `src/server/administration/operational-access-service.ts` — calcul central de portée.
- `src/server/administration/operational-access-service.test.ts` — portée globale/liée/vide.
- `src/server/repositories/postgres/human-agent-link-repository.ts` — lectures des liens.
- `src/server/uow/postgres-human-administration-uow.ts` — mutations transactionnelles.
- `src/server/administration/user-agent-administration.integration.test.ts` — garanties PostgreSQL 16.
- `src/app/api/users/route.ts` — liste/création d’humains.
- `src/app/api/users/[id]/role/route.ts` — remplacement du rôle.
- `src/app/api/users/[id]/status/route.ts` — activation/désactivation.
- `src/app/api/users/[id]/agent-links/route.ts` — liste/création des liens.
- `src/app/api/users/[id]/agent-links/[agentId]/route.ts` — retrait d’un lien.
- `src/app/api/admin/agents/route.ts` — liste administrative globale des agents.
- `src/server/http/administration-schemas.ts` — corps Zod stricts.
- `src/server/http/administration-schemas.test.ts` — validation et non-réflexion.
- `src/app/admin/users/page.tsx` — page serveur protégée.
- `src/components/administration/user-administration.tsx` — contrôles client accessibles.
- `src/components/administration/user-administration-client.ts` — appels HTTP purs testables.
- `src/components/administration/user-administration-client.test.ts` — mapping des réponses sans token.
- `drizzle/0004_*.sql` — table de liens et extension de la contrainte d’audit.
- `drizzle/meta/0004_snapshot.json` — snapshot généré de la migration.

**Modify:**

- `src/core/identity/permissions.ts`, `identity.test.ts`, `role-management.ts`, `index.ts`.
- `src/core/contracts/audit.ts` et ses tests.
- `src/server/repositories/ports.ts`.
- `src/server/uow/ports.ts`.
- `src/server/repositories/postgres/human-user-repository.ts`, `agent-repository.ts`, `task-repository.ts`, `action-repository.ts`.
- Les repositories mémoire agents/tâches/actions pour satisfaire les nouveaux ports explicites.
- `src/server/database/schema.ts`, `drizzle/meta/_journal.json`.
- `src/server/http/protect-route.ts`, `protect-route.test.ts`, `errors.ts`, `errors.test.ts`.
- `src/server/auth/cockpit-access.ts`, `cockpit-access.test.ts`.
- `src/server/container.ts`, `container.test.ts`.
- Les routes opérationnelles agents/tâches/actions et `src/app/api/routes.test.ts`.
- `src/app/page.tsx`, `src/components/layout/sidebar.tsx`, `src/styles/globals.css`.
- `docs/ICOS_PROGRESS.md` seulement pour consigner l’état du lot et les capacités futures déjà décidées, sans les implémenter.

---

### Task 1: Contrats de domaine, permissions et politique hiérarchique

**Files:**

- Create: `src/core/identity/human-agent-link.ts`
- Create: `src/core/identity/human-agent-link.test.ts`
- Create: `src/core/identity/role-management.test.ts`
- Modify: `src/core/identity/permissions.ts`
- Modify: `src/core/identity/identity.test.ts`
- Modify: `src/core/identity/role-management.ts`
- Modify: `src/core/identity/index.ts`
- Modify: `src/core/contracts/audit.ts`

**Interfaces:**

```ts
export const humanAgentRelationSchema = z.enum(["supervisor", "operator", "observer"]);
export type HumanAgentRelation = z.infer<typeof humanAgentRelationSchema>;
export const humanAgentLinkSchema = z
  .object({
    id: idSchema,
    humanUserId: idSchema,
    agentId: idSchema,
    relation: humanAgentRelationSchema,
    createdAt: isoDateTimeSchema,
    createdByHumanUserId: idSchema,
  })
  .strict();
export type HumanAgentLink = z.infer<typeof humanAgentLinkSchema>;

export type AdministrationOperation = "create" | "role" | "status" | "links";
export type AdministrationDecision = { ok: true } | { ok: false; reason: "forbidden" };
export function canCreateRole(
  actorRoles: readonly Role[],
  requestedRole: Role,
): AdministrationDecision;
export function canAdministerTarget(input: {
  actorUserId: string;
  actorRoles: readonly Role[];
  targetUserId: string;
  targetRoles: readonly Role[];
}): AdministrationDecision;
```

La matrice remplace `users.manage` et `owners.manage` par `users.read`, `users.create`, `users.role.write`, `users.status.write`, `agentLinks.read`, `agentLinks.write`, tous propres à `admin` et hérités par `owner`.

- [ ] **Step 1: Write failing tests** couvrant les six permissions, leur héritage, le schéma strict du lien, les trois relations, l’absence de `updatedAt`, admin→operator/viewer, refus admin→admin/owner, owner→autre cible, auto-administration et rôle acteur/cible absent.
- [ ] **Step 2: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/core/identity/identity.test.ts src/core/identity/human-agent-link.test.ts src/core/identity/role-management.test.ts`; attendre des échecs dus aux permissions, exports et politiques absents.
- [ ] **Step 3: Implement minimally** les contrats et politiques ci-dessus, supprimer l’ancienne politique fondée sur `users.manage`/`owners.manage`, conserver `wouldLeaveNoActiveOwner` pour les tests purs et étendre `auditEventTypeSchema` avec les sept événements administratifs.
- [ ] **Step 4: Run GREEN** avec la même commande, puis `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 5: Commit** avec `git add src/core && git commit -m "feat: define human-agent administration policies" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 2: Ports explicites de lecture, de portée et d’unité de travail

**Files:**

- Modify: `src/server/repositories/ports.ts`
- Modify: `src/server/uow/ports.ts`
- Test: `src/server/repositories/ports.test-d.ts` only if an existing type-test convention exists; otherwise compile through the service tests in Tasks 3–4.

**Interfaces:**

```ts
export interface AdminHumanUser {
  id: string;
  email: string;
  name?: string;
  status: UserStatus;
  role: Role | null;
}

export type AgentScope = { kind: "global" } | { kind: "linked"; agentIds: ReadonlySet<string> };

export interface HumanUserAdministrationRepository {
  list(): Promise<AdminHumanUser[]>;
  findById(id: string): Promise<AdminHumanUser | null>;
  findByEmail(email: string): Promise<AdminHumanUser | null>;
}

export interface HumanAgentLinkRepository {
  listForHuman(humanUserId: string): Promise<HumanAgentLink[]>;
  listAgentIdsForHuman(humanUserId: string): Promise<ReadonlySet<string>>;
}

// Existing global methods remain explicit for trusted administration/internal use.
export interface AgentRepository extends AgentLookup {
  list(): Promise<Agent[]>;
  listForScope(scope: AgentScope): Promise<Agent[]>;
  getByIdForScope(id: string, scope: AgentScope): Promise<Agent | null>;
}
export interface TaskRepository {
  list(): Promise<Task[]>;
  listForScope(scope: AgentScope): Promise<Task[]>;
  getById(id: string): Promise<Task | null>;
  getByIdForScope(id: string, scope: AgentScope): Promise<Task | null>;
  create(input: CreateTaskInput): Promise<CreateTaskResult>;
  transition(taskId: string, to: TaskStatus): Promise<TransitionTaskResult>;
}
export interface ActionRepository {
  list(filter?: ActionQuery): Promise<AgentAction[]>;
  listForScope(scope: AgentScope, filter?: ActionQuery): Promise<AgentAction[]>;
  getById(id: string): Promise<AgentAction | null>;
  getByIdForScope(id: string, scope: AgentScope): Promise<AgentAction | null>;
}

export type HumanAdministrationFailureReason =
  "not_found" | "already_exists" | "last_owner" | "audit_failed";
export type HumanAdministrationResult<T> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; reason: HumanAdministrationFailureReason; message: string };

export interface HumanAdministrationUnitOfWork {
  finalizeHumanCreation(input: {
    targetUserId: string;
    role: Role;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<AdminHumanUser>>;
  replaceRole(input: {
    targetUserId: string;
    nextRole: Role;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<AdminHumanUser>>;
  setStatus(input: {
    targetUserId: string;
    nextStatus: UserStatus;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<AdminHumanUser>>;
  createAgentLink(input: {
    id: string;
    targetUserId: string;
    agentId: string;
    relation: HumanAgentRelation;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<HumanAgentLink>>;
  removeAgentLink(input: {
    targetUserId: string;
    agentId: string;
    actorUserId: string;
    auditId: string;
    occurredAt: string;
  }): Promise<HumanAdministrationResult<HumanAgentLink>>;
}
```

- [ ] **Step 1: Write compile-consuming tests** at the beginning of Task 3 and Task 4 using fakes that implement every signature exactly; observe TypeScript failures against the current ports.
- [ ] **Step 2: Run RED** with `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`; attendre les imports et propriétés absents dans les nouveaux tests.
- [ ] **Step 3: Add the exact contracts** above without persistence or runtime behavior.
- [ ] **Step 4: Run GREEN for contract compilation** with `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`; behavior remains RED in Tasks 3–4.
- [ ] **Step 5: Do not commit separately**; include these contracts with the first consuming service so no interface-only commit is published.

### Task 3: Audits fermés et service d’administration humaine

**Files:**

- Create: `src/server/administration/audit.ts`
- Create: `src/server/administration/audit.test.ts`
- Create: `src/server/administration/human-administration-service.ts`
- Create: `src/server/administration/human-administration-service.test.ts`
- Modify: `src/server/repositories/ports.ts`
- Modify: `src/server/uow/ports.ts`

**Interfaces:**

```ts
export type HumanAdministrationServiceResult<T> =
  | { ok: true; value: T; changed: boolean }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "already_exists"
        | "last_owner"
        | "audit_failed"
        | "invalid_input"
        | "internal_error";
      message: string;
    };

export class HumanAdministrationService {
  constructor(input: {
    auth: AuthGateway;
    users: HumanUserAdministrationRepository;
    links: HumanAgentLinkRepository;
    agents: AgentRepository;
    audit: AuditRepository;
    uow: HumanAdministrationUnitOfWork;
  });
  listUsers(): Promise<AdminHumanUser[]>;
  createHuman(input: {
    actorUserId: string;
    actorRoles: readonly Role[];
    email: string;
    password: string;
    name?: string;
    role: Role;
  }): Promise<HumanAdministrationServiceResult<AdminHumanUser>>;
  replaceRole(input: {
    actorUserId: string;
    actorRoles: readonly Role[];
    targetUserId: string;
    role: Role;
  }): Promise<HumanAdministrationServiceResult<AdminHumanUser>>;
  setStatus(input: {
    actorUserId: string;
    actorRoles: readonly Role[];
    targetUserId: string;
    status: UserStatus;
  }): Promise<HumanAdministrationServiceResult<AdminHumanUser>>;
  listLinks(input: {
    actorUserId: string;
    actorRoles: readonly Role[];
    targetUserId: string;
  }): Promise<HumanAdministrationServiceResult<HumanAgentLink[]>>;
  createLink(input: {
    actorUserId: string;
    actorRoles: readonly Role[];
    targetUserId: string;
    agentId: string;
    relation: HumanAgentRelation;
  }): Promise<HumanAdministrationServiceResult<HumanAgentLink>>;
  removeLink(input: {
    actorUserId: string;
    actorRoles: readonly Role[];
    targetUserId: string;
    agentId: string;
  }): Promise<HumanAdministrationServiceResult<HumanAgentLink>>;
}
```

Les constructeurs d’audit n’acceptent que les champs fermés de la spécification et produisent toujours `{ kind: "human", id: actorUserId }`.

- [ ] **Step 1: Write failing audit tests** pour chaque événement et chaque refus, puis vérifier que le JSON ne matche pas `/password|cookie|token|secret|hash|headers|database_url|sql/i`.
- [ ] **Step 2: Write failing service tests** pour listes, politiques, création Better Auth, doublon avant création, compensation après échec UoW, compensation échouée, rôle/statut idempotents, révocation déléguée à l’UoW, cible/agent absent, lien dupliqué, retrait absent et audit des refus métier.
- [ ] **Step 3: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/server/administration/audit.test.ts src/server/administration/human-administration-service.test.ts`; attendre l’absence des modules.
- [ ] **Step 4: Implement minimally** les constructeurs et le service. Vérifier les doublons via `users.findByEmail` avant `auth.createHumanUser`; après création réussie, appeler `uow.finalizeHumanCreation`; pour tout résultat échoué ou exception de finalisation, appeler `auth.deleteHumanUser`; si la compensation échoue retourner `internal_error` sans détail.
- [ ] **Step 5: Preserve refusal attribution** : les refus de politique ou ressource après authentification appellent `audit.append(human_user.administration_denied)` ; si cet append échoue, retourner `audit_failed`.
- [ ] **Step 6: Run GREEN** avec les tests ciblés puis `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 7: Commit** avec `git add src/server/administration src/server/repositories/ports.ts src/server/uow/ports.ts && git commit -m "feat: add human administration service" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 4: Calcul central de portée opérationnelle

**Files:**

- Create: `src/server/administration/operational-access-service.ts`
- Create: `src/server/administration/operational-access-service.test.ts`

**Interfaces:**

```ts
export class OperationalAccessService {
  constructor(private readonly links: HumanAgentLinkRepository);
  async resolveScope(session: AuthenticatedSession): Promise<AgentScope>;
}
export function scopeContainsAgent(scope: AgentScope, agentId: string): boolean;
export function canCreateTaskInScope(input: {
  scope: AgentScope;
  assignedAgentId?: string;
}): boolean;
```

- [ ] **Step 1: Write failing tests** : owner/admin→global, operator/viewer→set des liens, rôle absent→set vide, lien absent→set vide, relations sans effet, global accepte une tâche non assignée, linked exige un `assignedAgentId` présent dans le set.
- [ ] **Step 2: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/server/administration/operational-access-service.test.ts`; attendre l’absence du module.
- [ ] **Step 3: Implement minimally** avec `highestRole(session.roles)` et sans matrice de permissions dupliquée.
- [ ] **Step 4: Run GREEN** avec le test ciblé et `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 5: Commit** avec `git add src/server/administration && git commit -m "feat: define linked operational scope" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 5: Schéma Drizzle et migration additive 0004

**Files:**

- Modify: `src/server/database/schema.ts`
- Create: `drizzle/0004_*.sql`
- Create: `drizzle/meta/0004_snapshot.json`
- Modify: `drizzle/meta/_journal.json`
- Test: `src/server/administration/user-agent-administration.integration.test.ts`

**Interfaces:**

`humanAgentLinks` mappe exactement `human_agent_links(id, human_user_id, agent_id, relation, created_at, created_by_human_user_id)` avec PK `id`, unique `(human_user_id, agent_id)`, checks fermés, index sur chaque FK de lecture et trois FKs `ON DELETE RESTRICT`.

- [ ] **Step 1: Record historical hashes** avec `/usr/bin/shasum -a 256 drizzle/000{0,1,2,3}_*.sql drizzle/meta/000{0,1,2,3}_snapshot.json > /tmp/icos-migrations-before.sha256`.
- [ ] **Step 2: Write failing PostgreSQL migration test** qui applique les migrations, inspecte `human_agent_links`, vérifie l’unicité, les trois FKs restrictives, l’enum relation et l’acceptation des sept nouveaux événements d’audit.
- [ ] **Step 3: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm test:integration -- src/server/administration/user-agent-administration.integration.test.ts`; attendre l’absence de la table/valeurs audit sous `postgres:16-alpine`.
- [ ] **Step 4: Modify Drizzle schema** puis exécuter `env -u NODE_ENV -u PERSISTENCE pnpm db:generate` exactement une fois. Vérifier que seul `0004`, son snapshot et l’entrée 4 du journal sont produits.
- [ ] **Step 5: Inspect generated SQL** : remplacer uniquement `audit_event_type_check` par la liste historique plus les sept événements, sans réécriture de table historique ni cascade.
- [ ] **Step 6: Run GREEN** avec le test d’intégration ciblé.
- [ ] **Step 7: Verify immutable history** avec `/usr/bin/shasum -a 256 -c /tmp/icos-migrations-before.sha256` et `git diff -- drizzle/0000* drizzle/0001* drizzle/0002* drizzle/0003* drizzle/meta/0000_snapshot.json drizzle/meta/0001_snapshot.json drizzle/meta/0002_snapshot.json drizzle/meta/0003_snapshot.json`; attendre `OK` et aucun diff.
- [ ] **Step 8: Commit** avec `git add src/server/database/schema.ts drizzle/0004* drizzle/meta/0004_snapshot.json drizzle/meta/_journal.json src/server/administration/user-agent-administration.integration.test.ts && git commit -m "feat: persist human-agent links" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 6: Repositories PostgreSQL scope-aware et lectures administratives

**Files:**

- Modify: `src/server/repositories/postgres/human-user-repository.ts`
- Create: `src/server/repositories/postgres/human-agent-link-repository.ts`
- Modify: `src/server/repositories/postgres/agent-repository.ts`
- Modify: `src/server/repositories/postgres/task-repository.ts`
- Modify: `src/server/repositories/postgres/action-repository.ts`
- Modify: `src/server/services/in-memory/agent-repository.ts`
- Modify: `src/server/services/in-memory/task-repository.ts`
- Modify: `src/server/services/in-memory/action-repository.ts`
- Test: `src/server/administration/user-agent-administration.integration.test.ts`

**Interfaces:** exactes signatures de Task 2.

- [ ] **Step 1: Extend failing integration tests** pour liste humains triée email/id avec `highestRole`, liens triés `createdAt/id`, IDs liés, listes agents/tâches/actions globales et liées, tâche non assignée cachée, `getByIdForScope` hors portée retournant `null`.
- [ ] **Step 2: Run RED** avec le test d’intégration ciblé et attendre les méthodes absentes.
- [ ] **Step 3: Implement PostgreSQL filters in SQL** : `inArray` pour les sets liés non vides et une condition impossible/retour `[]` pour les sets vides ; ne jamais charger globalement puis filtrer dans une route/UI.
- [ ] **Step 4: Implement memory methods** avec filtrage local uniquement pour satisfaire le port opérationnel existant ; ne pas y ajouter users, links, UoW ou administration runtime.
- [ ] **Step 5: Run GREEN** avec le test ciblé, les tests repositories existants et `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 6: Commit** avec `git add src/server/repositories src/server/services/in-memory src/server/administration/user-agent-administration.integration.test.ts && git commit -m "feat: apply linked scope in repositories" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 7: UoW administrative PostgreSQL et garanties concurrentes

**Files:**

- Create: `src/server/uow/postgres-human-administration-uow.ts`
- Modify: `src/server/administration/user-agent-administration.integration.test.ts`

**Interfaces:** exact `HumanAdministrationUnitOfWork` de Task 2.

- [ ] **Step 1: Add failing integration tests** pour finalisation rôle+audit, remplacement de toutes les lignes de rôle, révocation de toutes les sessions sur changement effectif, idempotence sans révocation, désactivation+révocation, réactivation sans session, last owner, deux mutations concurrentes du dernier owner, lien+audit atomiques, doublon et retrait absent.
- [ ] **Step 2: Run RED** et attendre l’absence de l’UoW.
- [ ] **Step 3: Implement transaction helpers** qui projettent `AdminHumanUser`, verrouillent tous les owners actifs par `SELECT ... FOR UPDATE`, réévaluent la cible dans la transaction et construisent les détails d’audit fermés à partir de l’état transactionnel.
- [ ] **Step 4: Implement role/status semantics** : si inchangé, aucun update/delete session et audit `changed:false`; sinon remplacer les rôles ou le statut, supprimer les sessions lorsque requis et auditer dans la même transaction.
- [ ] **Step 5: Implement link semantics** : insert/delete exact et audit dans la même transaction ; mapper les violations d’unicité vers `already_exists`, les absences vers `not_found`, sans exposer le message SQL.
- [ ] **Step 6: Run GREEN** avec le test ciblé plusieurs fois pour le cas concurrent, puis `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 7: Commit** avec `git add src/server/uow src/server/administration/user-agent-administration.integration.test.ts && git commit -m "feat: transact human administration changes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 8: Session unique dans les guards et composition PostgreSQL fail-closed

**Files:**

- Modify: `src/server/http/protect-route.ts`
- Modify: `src/server/http/protect-route.test.ts`
- Modify: `src/server/auth/cockpit-access.ts`
- Modify: `src/server/auth/cockpit-access.test.ts`
- Modify: `src/server/container.ts`
- Modify: `src/server/container.test.ts`

**Interfaces:**

```ts
export type ProtectedRouteResult =
  | { ok: true; session: AuthenticatedSession }
  | { ok: false; response: Response };

export type CockpitAccess =
  | { kind: "allowed"; session: AuthenticatedSession }
  | { kind: "redirect"; code: "unauthenticated" | "session_expired" }
  | { kind: "forbidden"; code: "forbidden" | "account_disabled" };

// PostgreSQL-only optional capabilities on Container:
users?: HumanUserAdministrationRepository;
agentLinks?: HumanAgentLinkRepository;
humanAdministration?: HumanAdministrationService;
operationalAccess?: OperationalAccessService;
humanAdministrationUow?: HumanAdministrationUnitOfWork;
```

- [ ] **Step 1: Write failing tests** : `protectRoute` renvoie la session, appelle `readSession` une seule fois, refuse same-origin avant body, cockpit allowed renvoie la même session, container PostgreSQL partage le même `db`/auth, memory laisse toutes les capacités administratives `undefined`.
- [ ] **Step 2: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/server/http/protect-route.test.ts src/server/auth/cockpit-access.test.ts src/server/container.test.ts`.
- [ ] **Step 3: Implement result unions** et adapter les assertions/tests existants sans affaiblir les audits de refus.
- [ ] **Step 4: Compose PostgreSQL capabilities** avec `PostgresHumanUserRepository`, `PostgresHumanAgentLinkRepository`, `PostgresHumanAdministrationUnitOfWork`, `HumanAdministrationService`, `OperationalAccessService` sur le même `handle.db` et la même façade `authentication.auth` ; si l’auth est absente, ne pas composer le service administratif.
- [ ] **Step 5: Run GREEN** avec les tests ciblés puis `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 6: Commit** avec `git add src/server/http/protect-route* src/server/auth/cockpit-access* src/server/container* && git commit -m "feat: compose authoritative administration services" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 9: Schémas HTTP et Route Handlers administratifs

**Files:**

- Create: `src/server/http/administration-schemas.ts`
- Create: `src/server/http/administration-schemas.test.ts`
- Modify: `src/server/http/errors.ts`
- Modify: `src/server/http/errors.test.ts`
- Create: six Route Handler files listed in File Map.
- Modify: `src/app/api/routes.test.ts`

**Interfaces:**

```ts
createHumanBodySchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(12),
    name: z.string().trim().min(1).optional(),
    role: roleSchema,
  })
  .strict();
replaceRoleBodySchema = z.object({ role: roleSchema }).strict();
setStatusBodySchema = z.object({ status: userStatusSchema }).strict();
createAgentLinkBodySchema = z
  .object({ agentId: idSchema, relation: humanAgentRelationSchema })
  .strict();
```

`ApiErrorCode` ajoute `already_exists` et `last_owner`, tous deux 409.

- [ ] **Step 1: Write failing schema/error tests** pour valeurs valides, mot de passe <12, champs supplémentaires, status/relation arbitraires, erreurs sans valeur entrée et deux mappings 409.
- [ ] **Step 2: Write failing HTTP matrix tests** pour chaque route : auth/permission, capabilities absentes→réponse fermée, same-origin avant `request.json`, admin/owner/cible/auto-administration, statuts 201/204/400/403/404/409/500 et absence de secrets dans toutes les réponses/audits.
- [ ] **Step 3: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/server/http/administration-schemas.test.ts src/server/http/errors.test.ts src/app/api/routes.test.ts`.
- [ ] **Step 4: Implement thin handlers** dans l’ordre container→guard→same-origin→body→strict schema→service→typed response. Si une capacité PostgreSQL manque, retourner `persistence_unavailable` sans fallback.
- [ ] **Step 5: Ensure exact permissions** : `users.read`, `users.create`, `users.role.write`, `users.status.write`, `agentLinks.read`, `agentLinks.write`; `/api/admin/agents` utilise la liste globale seulement après `agentLinks.read`.
- [ ] **Step 6: Run GREEN** avec les tests ciblés puis `env -u NODE_ENV -u PERSISTENCE pnpm typecheck`.
- [ ] **Step 7: Commit** avec `git add src/server/http src/app/api/users src/app/api/admin src/app/api/routes.test.ts && git commit -m "feat: expose human administration routes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 10: Portée dans les routes opérationnelles avant mutation

**Files:**

- Modify: `src/app/api/agents/route.ts`
- Modify: `src/app/api/tasks/route.ts`
- Modify: `src/app/api/tasks/[id]/transition/route.ts`
- Modify: `src/app/api/actions/route.ts`
- Modify: `src/app/api/actions/[id]/decision/route.ts`
- Modify: `src/app/api/routes.test.ts`

**Interfaces:** consomme `protected.session`, `container.operationalAccess.resolveScope`, les méthodes `*ForScope` et `canCreateTaskInScope`.

- [ ] **Step 1: Add failing route tests** pour listes globales owner/admin, listes liées operator/viewer, set vide, tâche non assignée cachée, création operator sans assignation/hors portée, transition hors portée et décision hors portée retournant `not_found` avant l’appel de mutation.
- [ ] **Step 2: Run RED** avec `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/app/api/routes.test.ts`.
- [ ] **Step 3: Modify GET handlers** pour résoudre une fois la portée depuis la session déjà validée et appeler `listForScope`.
- [ ] **Step 4: Modify POST handlers** pour contrôler assignation/ressource via la portée avant `create`, `transition` ou `recordActionDecision`; masquer toute ressource hors portée sous `not_found`.
- [ ] **Step 5: Run GREEN** avec le test HTTP et les tests usecase concernés.
- [ ] **Step 6: Commit** avec `git add src/app/api/agents src/app/api/tasks src/app/api/actions src/app/api/routes.test.ts && git commit -m "feat: enforce linked operational access" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 11: Cockpit filtré et administration accessible

**Files:**

- Modify: `src/app/page.tsx`
- Create: `src/app/admin/users/page.tsx`
- Create: `src/components/administration/user-administration.tsx`
- Create: `src/components/administration/user-administration-client.ts`
- Create: `src/components/administration/user-administration-client.test.ts`
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/styles/globals.css`

**Interfaces:**

```ts
export function Sidebar({
  showAdministration = false,
}: {
  showAdministration?: boolean;
}): JSX.Element;
export interface UserAdministrationProps {
  initialUsers: AdminHumanUser[];
  agents: Agent[];
}
```

- [ ] **Step 1: Write failing pure client tests** pour les sept appels API, confirmation requise pour rôle/statut/retrait, erreurs génériques, aucune attente/stockage de token et conservation d’un état immutable.
- [ ] **Step 2: Add failing cockpit/page tests where existing infrastructure permits**; sinon couvrir `resolveCockpitAccess`, portée et repositories puis exiger un build Next réel comme preuve du Server Component.
- [ ] **Step 3: Run RED** avec le test client et les tests cockpit ciblés.
- [ ] **Step 4: Modify Home** pour utiliser `access.session`, résoudre une seule portée et charger `agents/tasks/actions.listForScope` en parallèle ; transmettre `showAdministration` calculé serveur via la matrice centrale.
- [ ] **Step 5: Implement admin server page** : exiger `users.read` avant toute lecture, refuser si service absent, charger humains et agents administratifs sans exposer credentials/sessions.
- [ ] **Step 6: Implement client controls** avec labels, confirmations explicites, `aria-live`, états pending/success/error, boutons disabled et rafraîchissement local à partir des réponses contrôlées.
- [ ] **Step 7: Add focused CSS** réutilisant couleurs, focus visible et disabled existants, sans refonte générale.
- [ ] **Step 8: Run GREEN** avec tests ciblés, `env -u NODE_ENV -u PERSISTENCE pnpm lint`, `pnpm typecheck` et `pnpm build`.
- [ ] **Step 9: Commit** avec `git add src/app/page.tsx src/app/admin src/components/administration src/components/layout/sidebar.tsx src/styles/globals.css && git commit -m "feat: add user-agent administration cockpit" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`.

### Task 12: Intégration PostgreSQL 16 bout en bout

**Files:**

- Modify: `src/server/administration/user-agent-administration.integration.test.ts`
- Modify production files only through new RED/GREEN cycles for gaps proven by this suite.

- [ ] **Step 1: Extend RED integration flow** : Better Auth user/account sans auto-session, rôle+audit, doublon email, compensation, rôle+session, status+session/login, réactivation, concurrence last owner, liens/FKs/audits, portée réelle, container unique et fermeture.
- [ ] **Step 2: Run targeted RED/GREEN cycles** avec `env -u NODE_ENV -u PERSISTENCE pnpm test:integration -- src/server/administration/user-agent-administration.integration.test.ts`; pour chaque gap, vérifier l’échec attendu avant toute correction.
- [ ] **Step 3: Run the full integration suite** avec `env -u NODE_ENV -u PERSISTENCE pnpm test:integration`; vérifier explicitement `postgres:16-alpine`, zéro échec et aucun test ignoré présenté comme réussi.
- [ ] **Step 4: Commit** avec `git add src/server/administration src/server/uow src/server/repositories src/server/container.ts src/app/api && git commit -m "test: verify user-agent administration with postgres" -m "Co-Authored-By: Claude <noreply@anthropic.com>"` si le diff contient de nouveaux tests/corrections.

### Task 13: Documentation, revue, vérification et publication

**Files:**

- Create: `docs/ICOS_PROGRESS.md` if absent.
- Include unchanged: `docs/ICOS_MASTER_PLAN.md`.
- Review: all branch changes against the specification and this plan.

- [ ] **Step 1: Write progress document** avec lot 2B-2, branche/PR/SHA à compléter après publication et dettes futures décidées : CI adaptée Node24/pnpm/PostgreSQL16, tests navigateur Playwright, MCP, Codex reviewer et SkillsMP — toutes explicitement non commencées.
- [ ] **Step 2: Run secret/forbidden-data scans** sur le diff et les audits ; vérifier qu’aucune valeur sensible, erreur SQL brute ou fixture réelle n’est présente.
- [ ] **Step 3: Verify migration/dependency scope** : historiques 0000–0003 inchangés, seulement 0004 ajoutée, `package.json`/`pnpm-lock.yaml` inchangés hors état initial.
- [ ] **Step 4: Run sequential verification under Node 24** :

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
node --version
env -u NODE_ENV -u PERSISTENCE pnpm typecheck
env -u NODE_ENV -u PERSISTENCE pnpm lint
env -u NODE_ENV -u PERSISTENCE pnpm format:check
env -u NODE_ENV -u PERSISTENCE pnpm test
env -u NODE_ENV -u PERSISTENCE pnpm test:integration
env -u NODE_ENV -u PERSISTENCE pnpm build
/usr/bin/git diff --check
/usr/bin/git status --short --branch
```

Attendu : Node 24, chaque commande exit 0, zéro test échoué, PostgreSQL 16 réellement démarré, aucun test ignoré présenté comme succès.

- [ ] **Step 5: Perform strict inline code review** puisque les sous-agents OmniRoute non qualifiés sont indisponibles : examiner sécurité, politiques, transactions, concurrence, erreurs, scope, UI, migration et tests ; tout défaut confirmé reçoit d’abord un test RED, puis la correction minimale et la re-vérification complète.
- [ ] **Step 6: Commit documentation/final corrections** avec un message précis et le trailer requis, en ajoutant délibérément `docs/ICOS_MASTER_PLAN.md` seulement après vérification de son hash `a8031e6c06de75b0a39b6171e0dbfcad9d113decf78ddea107272d2fc8fcab9c`.
- [ ] **Step 7: Verify branch history** avec `/usr/bin/git branch --show-current`, `/usr/bin/git status`, `/usr/bin/git log --oneline main..HEAD`; attendre `feat/user-agent-administration`, arbre propre et commits du lot uniquement.
- [ ] **Step 8: Push** avec `/usr/bin/git push -u origin feat/user-agent-administration`.
- [ ] **Step 9: Create PR** via `gh pr create --repo SGNG21/Icos --base main --head feat/user-agent-administration` avec résumé, invariants de sécurité, migration 0004, résultats exacts unitaires/intégration/build et mention PostgreSQL 16 réel.
- [ ] **Step 10: Verify PR** avec `gh pr view --repo SGNG21/Icos --json number,url,state,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus`; ne lancer aucune commande de fusion.

## Self-review

- **Spec coverage:** les 15 critères d’acceptation sont couverts : autorités séparées, six permissions, hiérarchie, dernier owner concurrent, révocation, compensation, liens restrictifs, audits fermés, portée route/cockpit, liste admin globale, memory fail-closed, migration 0004, vérifications complètes, composition unique et PR sans fusion.
- **Type consistency:** `AdminHumanUser`, `AgentScope`, les repositories, `HumanAdministrationUnitOfWork`, `ProtectedRouteResult` et les résultats de service sont définis avant consommation et portent les mêmes noms dans toutes les tâches.
- **Security order:** chaque mutation suit guard→same-origin→JSON→Zod strict→service→transaction/audit→réponse ; aucun refus pré-auth ne lit le corps.
- **Transactional boundary:** rôle, statut, sessions, lien et audit partagent le même `Database`; Better Auth n’est appelé directement que par l’`AuthGateway` existant pour créer/compenser.
- **Scope:** aucune invitation, reset de mot de passe, OAuth/MFA/passkey, suppression humaine, mutation d’agent, sémantique de relation, nouvelle intégration, package, CI, MCP, Playwright, SkillsMP ou refonte générale.
- **Execution:** la session principale exécute le plan directement ; aucun alias de modèle ambigu, aucun agent fork et aucune boucle sur erreur HTTP 400 OmniRoute.
