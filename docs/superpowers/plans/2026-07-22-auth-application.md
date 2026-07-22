# Lot 2B-1b Authentication Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendre la connexion humaine Better Auth utilisable, valider les sessions autoritairement et protéger le cockpit ainsi que les six Route Handlers ICOS.

**Architecture:** Le container PostgreSQL conserve une seule instance Better Auth et l’expose au travers de deux ports ICOS étroits : identité/session et login/logout HTTP. Des guards serveur centralisés appliquent la matrice ICOS ; le proxy ne fait qu’une redirection optimiste fondée sur la présence du cookie.

**Tech Stack:** Next.js 16.2.10 App Router, React 19.2.7, TypeScript 6.0.3 strict, Better Auth 1.6.23, Drizzle ORM 0.45.2, postgres.js 3.4.9, Zod 4.4.3, Vitest 4.1.10, PostgreSQL 16 Testcontainers.

## Global Constraints

- Humains et agents IA restent séparés ; aucune session web pour un agent IA.
- Better Auth gère identité et sessions ; ICOS gère rôles et permissions côté serveur.
- Aucun second pool PostgreSQL, aucune connexion à l’import, aucun fallback vers `memory`.
- Aucun nouveau package et aucune modification de `drizzle/0000*`, `0001*` ou `0002*`.
- Aucun cookie, token, mot de passe, hash, secret, `DATABASE_URL`, erreur SQL brute ou stack trace dans les réponses, logs, audits ou fixtures.
- Les tests unitaires restent indépendants de Docker ; `pnpm test:integration` utilise PostgreSQL 16 réel.
- La fusion dans `main` est interdite.

## File Map

**Create:**

- `src/server/auth/errors.ts` — erreurs de guards indépendantes de Next.js.
- `src/server/auth/guards.ts` — lecture autoritaire et vérification rôle/permission.
- `src/server/auth/http-gateway.ts` — port et adaptateur login/logout Better Auth sans fuite de token.
- `src/server/auth/security-audit.ts` — construction centralisée d’audits sûrs.
- `src/server/http/origin.ts` — vérification de même origine des mutations.
- `src/server/http/auth-response.ts` — conversion des erreurs de guards en réponses stables.
- `src/app/api/auth/[...all]/route.ts` — allowlist publique connexion/déconnexion.
- `src/app/login/page.tsx` — page de connexion et validation serveur de `next`.
- `src/components/auth/login-form.tsx` — formulaire client accessible.
- `src/components/auth/logout-button.tsx` — commande client de déconnexion.
- `src/auth-navigation.ts` — validation pure des destinations locales.
- `src/proxy.ts` — redirection UX optimiste sans autorisation.
- Tests unitaires ciblés à côté des unités ci-dessus.
- `src/server/auth/auth-application.integration.test.ts` — flux PostgreSQL 16 réel.

**Modify:**

- `src/server/auth/ports.ts`, `authentication-service.ts`, `authorization-service.ts`, `better-auth.ts` — ports étroits, projection fail-closed, hiérarchie de rôles, inscription publique désactivée.
- `src/server/container.ts` — composer les façades sur l’unique instance Better Auth et permettre l’injection explicite dans les tests.
- `src/core/contracts/audit.ts` — événements auth réellement produits.
- `src/server/http/errors.ts`, `map-error.ts` — quatre erreurs publiques.
- Les six fichiers `src/app/api/**/route.ts` existants — guards et origine.
- `src/app/api/routes.test.ts` — matrice d’autorisation HTTP sans Docker.
- `src/app/page.tsx`, `src/components/layout/sidebar.tsx`, `src/styles/globals.css` — cockpit protégé, logout et UI login.
- Documentation d’architecture/ADR uniquement si l’implémentation révèle une précision durable non déjà couverte par ADR-0007 et la spécification.

---

### Task 1: Contrats d’erreur et session fail-closed

**Files:**
- Create: `src/server/auth/errors.ts`
- Create: `src/server/auth/authentication-service.test.ts`
- Modify: `src/server/auth/authentication-service.ts:15-29`
- Modify: `src/server/http/errors.ts:4-35`
- Test: `src/server/http/errors.test.ts`

**Interfaces:**
- Produces: `AuthFailureCode = "unauthenticated" | "session_expired" | "forbidden" | "account_disabled"`.
- Produces: `AuthGuardError extends Error` avec propriété `code: AuthFailureCode`.
- Consumes later: `httpStatusFor(code)` retourne 401/403 selon le code.

- [ ] **Step 1: Write failing tests** vérifiant les statuts 401/403 et qu’un utilisateur Better Auth avec `status` absent, nul ou inconnu n’est jamais projeté comme actif.
- [ ] **Step 2: Run** `pnpm vitest run src/server/http/errors.test.ts src/server/auth/authentication-service.test.ts` et confirmer un échec dû aux codes absents et au fallback `active`.
- [ ] **Step 3: Implement minimally** l’union, les statuts et une projection stricte avec `userStatusSchema.safeParse`; retourner `null` pour toute projection invalide plutôt que d’activer implicitement le compte.
- [ ] **Step 4: Run** la même commande et attendre tous les tests verts.
- [ ] **Step 5: Commit** `git add src/server/auth src/server/http && git commit -m "feat: enforce fail-closed auth sessions"`.

### Task 2: Guards centralisés et hiérarchie de rôles

**Files:**
- Create: `src/server/auth/guards.ts`
- Create: `src/server/auth/guards.test.ts`
- Modify: `src/server/auth/authorization-service.ts`
- Modify: `src/server/auth/ports.ts`

**Interfaces:**
- Produces: `requireSession(container: Pick<Container, "auth">, headers: Headers): Promise<AuthenticatedSession>`.
- Produces: `requireRole(container, headers, requiredRole: Role): Promise<AuthenticatedSession>`.
- Produces: `requirePermission(container, headers, permission: Permission): Promise<AuthenticatedSession>`.
- Consumes: `getSessionCookie(headers, { cookiePrefix: "icos" })` réduit immédiatement en booléen.
- Consumes: `ROLE_RANK` et `AuthorizationService.can` ; aucune matrice dupliquée.

- [ ] **Step 1: Write failing guard tests** pour auth non composée, cookie absent, cookie présent/session nulle, statut disabled, hiérarchie viewer/operator/admin/owner et permissions effectives.
- [ ] **Step 2: Run** `pnpm vitest run src/server/auth/guards.test.ts` et confirmer l’absence des guards.
- [ ] **Step 3: Implement** les trois guards, en levant uniquement `AuthGuardError`, et rendre `AuthorizationService.hasRole` hiérarchique via `ROLE_RANK`.
- [ ] **Step 4: Run** `pnpm vitest run src/server/auth/guards.test.ts src/core/identity/identity.test.ts` et attendre le succès.
- [ ] **Step 5: Commit** `git add src/server/auth && git commit -m "feat: add authoritative auth guards"`.

### Task 3: Audits de sécurité et conversion HTTP

**Files:**
- Create: `src/server/auth/security-audit.ts`
- Create: `src/server/auth/security-audit.test.ts`
- Create: `src/server/http/auth-response.ts`
- Create: `src/server/http/auth-response.test.ts`
- Modify: `src/core/contracts/audit.ts`

**Interfaces:**
- Produces: `appendSecurityAudit(audit, input)` dont `input.reason` est une enum sûre et dont les détails acceptés sont limités à méthode, route, permission/rôle et raison.
- Produces: `authErrorResponse(error: AuthGuardError): Response`.
- Produit les événements `auth.login.succeeded`, `auth.login.rejected`, `auth.logout.succeeded`, `auth.access.denied`.

- [ ] **Step 1: Write failing tests** qui valident chaque événement, acteur, code HTTP, `no-store`, et rejettent au niveau type/schéma toute clé `password`, `cookie`, `token`, `secret`, `hash` ou `headers`.
- [ ] **Step 2: Run** `pnpm vitest run src/server/auth/security-audit.test.ts src/server/http/auth-response.test.ts` et confirmer l’échec attendu.
- [ ] **Step 3: Implement** des constructeurs étroits générant UUID et date côté serveur, sans accepter de blob arbitraire.
- [ ] **Step 4: Run** les tests ciblés puis `pnpm typecheck`.
- [ ] **Step 5: Commit** `git add src/core/contracts/audit.ts src/server/auth src/server/http && git commit -m "feat: add security audit events"`.

### Task 4: Vérification d’origine

**Files:**
- Create: `src/server/http/origin.ts`
- Create: `src/server/http/origin.test.ts`

**Interfaces:**
- Produces: `isSameOriginMutation(request: Request): boolean`.
- Produces: `requireSameOrigin(request: Request): void`, levant `AuthGuardError("forbidden")`.

- [ ] **Step 1: Write failing tests** pour Origin identique, Origin absent, origine différente, `Sec-Fetch-Site: cross-site`, ports différents et valeurs malformées.
- [ ] **Step 2: Run** `pnpm vitest run src/server/http/origin.test.ts` et confirmer l’absence de l’unité.
- [ ] **Step 3: Implement** la comparaison `new URL(origin).origin === new URL(request.url).origin`, en refusant par défaut les mutations sans `Origin` et tout `cross-site`.
- [ ] **Step 4: Run** le test ciblé et attendre le succès.
- [ ] **Step 5: Commit** `git add src/server/http/origin* && git commit -m "feat: enforce same-origin mutations"`.

### Task 5: Façade HTTP Better Auth et inscription privée

**Files:**
- Create: `src/server/auth/http-gateway.ts`
- Create: `src/server/auth/http-gateway.test.ts`
- Modify: `src/server/auth/better-auth.ts`
- Modify: `src/server/auth/ports.ts`
- Modify: `src/server/container.ts`

**Interfaces:**
- Produces: `AuthHttpGateway.signIn(input: { email: string; password: string; headers: Headers }): Promise<{ headers: Headers; userId: string }>`.
- Produces: `AuthHttpGateway.signOut(headers: Headers): Promise<{ headers: Headers; success: boolean }>`.
- Le résultat public ne contient jamais de token, mais l’adaptateur peut le garder dans une variable éphémère sans le journaliser.
- `Container` expose `authHttp?: AuthHttpGateway` construit sur la même `IcosBetterAuth` que `auth`.

- [ ] **Step 1: Write failing tests** avec une fausse API Better Auth qui retourne un token sentinelle ; vérifier que le type/résultat de façade ne le contient pas et que `Set-Cookie` est conservé.
- [ ] **Step 2: Run** `pnpm vitest run src/server/auth/http-gateway.test.ts` et confirmer l’échec.
- [ ] **Step 3: Implement** les appels `signInEmail({ body, headers, returnHeaders: true, returnStatus: true })` et `signOut` équivalent ; activer `disableSignUp: true` et autoriser explicitement la création interne via l’option serveur Better Auth prévue à cet effet.
- [ ] **Step 4: Add container tests** vérifiant une seule construction Better Auth/DB et aucune façade auth en mémoire.
- [ ] **Step 5: Run** `pnpm vitest run src/server/auth/http-gateway.test.ts src/server/container.test.ts` puis `pnpm typecheck`.
- [ ] **Step 6: Commit** `git add src/server/auth src/server/container* && git commit -m "feat: add restricted Better Auth gateway"`.

### Task 6: Handler `/api/auth/[...all]`

**Files:**
- Create: `src/app/api/auth/[...all]/route.ts`
- Create: `src/app/api/auth/[...all]/route.test.ts`

**Interfaces:**
- Consumes: `container.authHttp`, `container.auth`, `appendSecurityAudit`.
- Produces: `POST(request, { params }): Promise<Response>`.
- Allowlist exacte: `sign-in/email`, `sign-out`; toute autre route/méthode est 404.

- [ ] **Step 1: Write failing HTTP tests** pour connexion réussie, credentials invalides normalisés, compte désactivé, déconnexion, inscription refusée, route inconnue, réponse sans token et audits sans données sensibles.
- [ ] **Step 2: Run** `pnpm vitest run 'src/app/api/auth/[...all]/route.test.ts'` et confirmer l’absence du handler.
- [ ] **Step 3: Implement login** : lire JSON, valider email/password avec Zod local strict, appeler la façade, relire autoritairement la session avec les cookies retournés, refuser/révoquer un compte non actif, auditer, répondre `{ success: true }` avec les en-têtes Better Auth sûrs.
- [ ] **Step 4: Implement logout** : résoudre l’acteur avant révocation, révoquer, auditer sans faire échouer la révocation en cas d’échec d’audit, retourner le cookie expiré.
- [ ] **Step 5: Run** le test ciblé puis `pnpm typecheck`.
- [ ] **Step 6: Commit** `git add src/app/api/auth src/server/auth && git commit -m "feat: expose restricted auth endpoints"`.

### Task 7: Protéger les six Route Handlers

**Files:**
- Modify: `src/app/api/agents/route.ts`
- Modify: `src/app/api/tasks/route.ts`
- Modify: `src/app/api/tasks/[id]/transition/route.ts`
- Modify: `src/app/api/actions/route.ts`
- Modify: `src/app/api/actions/[id]/decision/route.ts`
- Modify: `src/app/api/audit/route.ts`
- Modify: `src/app/api/routes.test.ts`

**Interfaces:**
- Consumes: `requirePermission`, `requireSameOrigin`, `authErrorResponse`, audits d’accès refusé.
- Permissions exactes documentées dans la spécification.

- [ ] **Step 1: Refactor the test fixture** pour injecter explicitement un fake `AuthGateway` dans le container global de test, avec sessions viewer/operator/admin/owner/disabled/expired.
- [ ] **Step 2: Write failing matrix tests** : toutes les lectures cockpit pour viewer+, écritures pour operator+, audit complet refusé au viewer, compte disabled refusé, cookie absent/expiré, origine croisée refusée avant lecture du corps.
- [ ] **Step 3: Run** `pnpm vitest run src/app/api/routes.test.ts` et confirmer les réponses non protégées actuelles.
- [ ] **Step 4: Modify each handler** pour obtenir le container puis vérifier auth/permission avant query/body ; ajouter `Request` aux GET sans paramètre ; pour POST vérifier l’origine avant `readJson`.
- [ ] **Step 5: Add denial audit assertions** sans corps, email ni headers.
- [ ] **Step 6: Run** `pnpm vitest run src/app/api/routes.test.ts` et attendre tous les cas verts.
- [ ] **Step 7: Commit** `git add src/app/api src/server/auth src/server/http && git commit -m "feat: protect internal API routes"`.

### Task 8: Navigation locale, proxy UX et cockpit serveur

**Files:**
- Create: `src/auth-navigation.ts`
- Create: `src/auth-navigation.test.ts`
- Create: `src/proxy.ts`
- Create: `src/proxy.test.ts`
- Modify: `src/app/page.tsx`
- Create: `src/app/page.test.tsx` si le projet permet un test de composant sans nouvelle dépendance ; sinon couvrir le guard via test unitaire et le build Next.

**Interfaces:**
- Produces: `safeNextPath(candidate: string | null): string`.
- Le proxy ne consomme que `request.cookies.has("icos.session_token")` et ne dépend d’aucun module DB/auth serveur.
- Le cockpit consomme `requirePermission(container, headers(), "cockpit.read")` avant tout repository.

- [ ] **Step 1: Write failing pure tests** de `safeNextPath` pour `/tasks?x=1`, valeur vide, URL absolue, `//evil`, backslash et encodages ambigus.
- [ ] **Step 2: Write failing proxy tests** : cookie absent redirigé avec `next`, cookie présent laissé passer, `/login` jamais bouclé.
- [ ] **Step 3: Run** `pnpm vitest run src/auth-navigation.test.ts src/proxy.test.ts` et confirmer l’absence des unités.
- [ ] **Step 4: Implement** validation locale stricte et proxy sans import de container, Drizzle ou Better Auth API.
- [ ] **Step 5: Protect `Home`** en appelant le guard avec `await headers()` avant `agents.list()`, puis rediriger les 401 vers `/login?next=/`; ne jamais rendre les données après un 403.
- [ ] **Step 6: Run** les tests ciblés, `pnpm typecheck`, puis `pnpm build` pour valider le contrat proxy Next.js 16.
- [ ] **Step 7: Commit** `git add src/auth-navigation* src/proxy* src/app/page.tsx && git commit -m "feat: protect cockpit navigation"`.

### Task 9: Page de connexion et déconnexion accessible

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/components/auth/login-form.tsx`
- Create: `src/components/auth/logout-button.tsx`
- Create: `src/components/auth/login-form.test.tsx` seulement si l’infrastructure React existante suffit ; sinon tester les fonctions extraites sans nouveau package.
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `src/styles/globals.css`

**Interfaces:**
- `LoginForm({ nextPath: string })` POSTe uniquement `{ email, password }` vers `/api/auth/sign-in/email`.
- `LogoutButton` POSTe vers `/api/auth/sign-out` puis appelle `router.replace("/login")`.
- Aucun composant client ne décide un rôle ou une permission.

- [ ] **Step 1: Write failing tests** des fonctions client extraites : double soumission bloquée, réponse 401 affichée génériquement, destination sûre utilisée, aucun token attendu/stocké.
- [ ] **Step 2: Run** le test ciblé et confirmer l’échec.
- [ ] **Step 3: Implement login page/form** avec `<label>`, `type=email`, `autocomplete=email/current-password`, `aria-live`, état pending et erreur contrôlée.
- [ ] **Step 4: Implement logout button** et l’intégrer dans `Sidebar` sans changer les contrôles serveur.
- [ ] **Step 5: Add CSS** cohérent avec `src/styles/globals.css`, incluant focus visible, erreur, disabled/pending et responsive.
- [ ] **Step 6: Run** tests ciblés, `pnpm lint`, `pnpm typecheck`, `pnpm build`.
- [ ] **Step 7: Commit** `git add src/app/login src/components/auth src/components/layout/sidebar.tsx src/styles/globals.css && git commit -m "feat: add human login experience"`.

### Task 10: Intégration PostgreSQL 16 complète

**Files:**
- Create: `src/server/auth/auth-application.integration.test.ts`
- Modify: helpers de test existants uniquement si nécessaire, sans secret réel.

**Interfaces:**
- Consumes: `startPostgres`, migrations existantes, `buildPostgresContainer`, handler auth et handlers protégés.
- Utilise des secrets factices déterministes (`"x".repeat(40)`) et ne place jamais un token en fixture persistante ou snapshot.

- [ ] **Step 1: Write failing integration tests** pour création interne, attribution de chacun des quatre rôles, login HTTP, présence de `Set-Cookie`, absence de token JSON, accès selon matrice, session supprimée, session expirée, compte disabled, logout/révocation, inscription refusée et audits sûrs.
- [ ] **Step 2: Run** `pnpm test:integration -- src/server/auth/auth-application.integration.test.ts` et confirmer les échecs fonctionnels attendus avec PostgreSQL 16 réellement démarré.
- [ ] **Step 3: Correct only integration gaps** révélés par ce test, par petits changements couverts ; ne pas ajouter de fallback ni modifier les migrations.
- [ ] **Step 4: Run** le test d’intégration ciblé puis `pnpm test:integration` ; vérifier qu’aucun test n’est ignoré.
- [ ] **Step 5: Commit** `git add src/server/auth src/app/api src/server/database/testing && git commit -m "test: cover auth application with postgres"`.

### Task 11: Documentation et vérification complète

**Files:**
- Modify: `docs/architecture/overview.md` et/ou `docs/decisions/0007-identity-and-authentication.md` seulement pour refléter le comportement désormais livré.
- Review: tous les fichiers modifiés.

**Interfaces:** aucune nouvelle interface ; tâche de fermeture.

- [ ] **Step 1: Scan secrets and forbidden data** dans le diff, les audits et fixtures ; retirer toute valeur ou message Better Auth brut.
- [ ] **Step 2: Run sequentially** :

```bash
env -u NODE_ENV -u PERSISTENCE pnpm typecheck
env -u NODE_ENV -u PERSISTENCE pnpm lint
env -u NODE_ENV -u PERSISTENCE pnpm format:check
env -u NODE_ENV -u PERSISTENCE pnpm test
env -u NODE_ENV -u PERSISTENCE pnpm test:integration
env -u NODE_ENV -u PERSISTENCE pnpm build
git diff --check
git status --short --branch
```

Attendu : toutes les commandes réussissent ; aucun test ignoré ; PostgreSQL 16 Testcontainers tourne réellement. Rapporter séparément l’avertissement si Node n’est pas dans `>=24 <25`.

- [ ] **Step 3: Use `superpowers:verification-before-completion`** et conserver les sorties factuelles.
- [ ] **Step 4: Use `superpowers:requesting-code-review`** dans la session principale si les sous-agents ne sont pas utilisables ; vérifier chaque constat avant correction.
- [ ] **Step 5: Re-run affected tests and full verification** après toute correction.
- [ ] **Step 6: Commit documentation/final corrections** avec un message précis et le trailer requis.

### Task 12: Push et pull request sans fusion

**Files:** aucun fichier obligatoire.

- [ ] **Step 1: Verify branch and diff** avec `git branch --show-current`, `git status`, `git log --oneline main..HEAD`.
- [ ] **Step 2: Push** `git push -u origin feat/auth-application`.
- [ ] **Step 3: Create PR** via `gh pr create --repo SGNG21/Icos --base main --head feat/auth-application` avec résumé, sécurité, résultats exacts des tests, PostgreSQL 16 réel et avertissement Node éventuel.
- [ ] **Step 4: Verify PR state** avec `gh pr view` et ne pas exécuter de commande de fusion.

## Self-review

- Couverture : handler, absence d’inscription publique, login/logout, session autoritaire, trois guards, cockpit, six routes/sept méthodes, proxy UX, erreurs, origine/CSRF, audits, matrice quatre rôles et PostgreSQL 16 sont chacun rattachés à une tâche.
- Types : `AuthGuardError`, `AuthHttpGateway`, `safeNextPath`, `requirePermission` et `appendSecurityAudit` sont définis avant consommation.
- Scope : aucun package, OAuth/MFA/passkey/reset/invitation/admin utilisateur/user-agent link/impersonation/CI/migration existante.
- Exécution : la session principale implémente le plan directement car les modèles de sous-agents OmniRoute non qualifiés échouent avec HTTP 400 et l’agent `fork` n’est pas disponible.