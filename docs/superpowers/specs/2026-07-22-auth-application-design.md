# Lot 2B-1b — Authentification applicative

## Statut et objectif

Ce lot rend l’authentification humaine réellement utilisable et protège le cockpit ainsi que l’API interne ICOS. Better Auth 1.6.23 reste l’autorité de l’identité et des sessions. ICOS reste l’unique autorité des rôles et permissions.

Le lot n’ajoute ni inscription publique, ni administration des utilisateurs, ni identité web pour les agents IA. Il ne modifie aucune migration existante et n’ajoute aucune dépendance.

## Contraintes invariantes

- Les humains et les agents IA restent deux concepts séparés. Un `Agent.authorizationLevel` ne participe jamais à l’autorisation d’un humain.
- Les contrats du domaine restent indépendants de Next.js, Better Auth, Drizzle et PostgreSQL.
- L’unique instance Better Auth utilise le handle Drizzle et le pool postgres.js déjà possédés par le container.
- Il n’existe ni second pool PostgreSQL, ni connexion à l’import, ni fallback silencieux vers `memory`.
- Les sessions sont validées autoritairement en base ; `session.cookieCache` reste désactivé.
- Le proxy n’est qu’une optimisation de navigation. Toutes les autorisations sont vérifiées côté serveur.
- La matrice de permissions existante dans `src/core/identity/permissions.ts` n’est ni copiée ni remplacée.
- Les migrations `0000`, `0001` et `0002` restent inchangées. Aucune migration additive n’est nécessaire.
- Aucun cookie, token, mot de passe, hash, secret, `DATABASE_URL`, en-tête sensible, erreur SQL brute ou stack trace n’est exposé ou audité.

## Architecture retenue

### 1. Façades d’authentification étroites

Le container PostgreSQL construit une seule instance Better Auth. Cette instance alimente deux façades ICOS :

1. `AuthGateway`, déjà utilisé pour la gestion interne de l’identité, la lecture de session et la révocation ;
2. `AuthHttpGateway`, nouveau port étroit destiné au handler public et limité à `signInEmail` et `signOut`.

L’instance Better Auth elle-même n’est jamais exposée par le container. Le backend mémoire de production ne reçoit aucune fausse authentification : si une route protégée est exécutée sans auth composée, elle échoue explicitement.

### 2. Handler public avec allowlist

`src/app/api/auth/[...all]/route.ts` reste le point d’entrée demandé, mais ne délègue pas aveuglément à `toNextJsHandler`.

Le route handler accepte exclusivement :

- `POST /api/auth/sign-in/email` ;
- `POST /api/auth/sign-out`.

Toute autre méthode ou sous-route reçoit une réponse contrôlée 404. En particulier, `/sign-up/email`, les routes OAuth, la lecture publique de session et les autres capacités Better Auth ne sont pas exposées.

Pour la connexion, l’adaptateur appelle `auth.api.signInEmail` avec les en-têtes de la requête et les options Better Call `returnHeaders` et `returnStatus`. Il propage les en-têtes de session nécessaires, notamment `Set-Cookie`, mais reconstruit le corps en `{ "success": true }`. Le token natif Better Auth reste une donnée éphémère côté serveur et n’est jamais sérialisé.

Pour la déconnexion, l’identité courante est résolue avant révocation pour produire un audit humain, puis Better Auth révoque la session et expire le cookie. Une défaillance d’audit postérieure ne doit pas annuler la révocation.

### 3. Absence d’inscription publique

`emailAndPassword.disableSignUp` est activé dans la configuration Better Auth. La création de comptes reste possible uniquement par la façade interne ICOS utilisée par le bootstrap. Celle-ci utilise une API Better Auth serveur explicitement autorisée à créer l’utilisateur sans exposer de route HTTP d’inscription.

Cette défense est doublée par l’allowlist du handler public.

## Session autoritaire et guards

### Classification des refus

Les guards réduisent immédiatement la présence du cookie de session à un booléen ; sa valeur n’est ni conservée ni journalisée.

- aucun credential attendu : `unauthenticated`, HTTP 401 ;
- credential présent mais aucune session Better Auth autoritaire : `session_expired`, HTTP 401 ;
- session valide dont l’utilisateur est absent, mal projeté ou désactivé : `account_disabled`, HTTP 403 ;
- session active sans rôle ou permission requis : `forbidden`, HTTP 403.

Un statut utilisateur absent ou invalide n’est jamais converti en `active`. La projection est fail-closed.

### API des guards

Les guards centralisés consomment un `Container` et des `Headers` :

- `requireSession(container, headers)` retourne la session active ou une erreur typée ;
- `requireRole(container, headers, role)` applique la hiérarchie `owner ⊇ admin ⊇ operator ⊇ viewer` définie par `ROLE_RANK` ;
- `requirePermission(container, headers, permission)` appelle uniquement `AuthorizationService.can` et donc la matrice ICOS existante.

Les guards existent en deux formes d’usage : un résultat typé testable sans Next.js et une conversion HTTP uniforme. Les refus de compte désactivé et d’accès interdit sont audités avec une raison normalisée. Un échec de cet audit ne transforme jamais un refus en autorisation.

## Protection du cockpit et des routes

Le cockpit exécute `requirePermission("cockpit.read")` avant toute lecture de repository. Une absence ou expiration de session redirige vers `/login?next=...`. Un compte désactivé ou un utilisateur authentifié sans permission reçoit une réponse interdite contrôlée, sans données métier.

Matrice des routes existantes :

| Route | Permission |
| --- | --- |
| `GET /api/agents` | `cockpit.read` |
| `GET /api/tasks` | `cockpit.read` |
| `POST /api/tasks` | `tasks.write` |
| `POST /api/tasks/[id]/transition` | `tasks.write` |
| `GET /api/actions` | `cockpit.read` |
| `POST /api/actions/[id]/decision` | `approvals.decide` |
| `GET /api/audit` | `audit.read.full` |

`audit.read.limited` n’autorise pas la réponse complète de la route d’audit. Une vue réduite n’est pas définie dans ce lot.

L’ordre des mutations est : container, session, permission, origine, corps JSON, validation métier, exécution. Un appel non autorisé ne peut donc pas sonder les validations métier.

## Origine et CSRF

Better Auth conserve ses protections natives pour ses endpoints ; aucune option de désactivation CSRF ou de vérification d’origine n’est activée.

Toutes les mutations métier ICOS ajoutent une vérification explicite de même origine :

- `Origin` doit être présent ;
- son origine normalisée doit correspondre à celle de la requête ;
- `Sec-Fetch-Site: cross-site` est refusé ;
- aucune valeur soumise n’est reflétée dans l’erreur ou l’audit.

Un refus produit `forbidden` et un audit `auth.access.denied` avec méthode, identifiant de route, permission requise et raison normalisée.

## Interface de connexion et déconnexion

`/login` est une page accessible sans session. Le paramètre `next` n’est accepté que s’il représente un chemin local absolu commençant par `/`, sans schéma, hôte ni `//`; sinon la destination devient `/`.

Le formulaire client :

- contient des labels explicites et des attributs d’autocomplétion adaptés ;
- soumet l’email et le mot de passe uniquement à `/api/auth/sign-in/email` ;
- affiche un état de chargement ;
- désactive la double soumission ;
- affiche des erreurs contrôlées sans distinguer un email inconnu d’un mauvais mot de passe ;
- remplace la navigation par la destination locale validée après succès.

Le bouton de déconnexion est intégré à la barre latérale. Il appelle `/api/auth/sign-out`, puis navigue vers `/login`. Aucun état de permission n’est décidé côté client.

## Proxy UX

`src/proxy.ts` ne consulte jamais PostgreSQL et ne valide ni session, ni rôle, ni permission. Pour les pages cockpit, il vérifie uniquement la présence du nom de cookie Better Auth préfixé `icos`. En son absence, il redirige vers `/login?next=<chemin local>`.

La présence d’un cookie n’autorise rien : le Server Component et les Route Handlers refont toujours la validation autoritaire. `/login` n’est pas redirigé automatiquement sur la seule présence d’un cookie, ce qui évite une boucle avec un cookie expiré.

## Erreurs publiques

Les codes stables ajoutés à l’union HTTP sont :

- `unauthenticated` → 401, message contrôlé ;
- `session_expired` → 401, message contrôlé ;
- `forbidden` → 403, message contrôlé ;
- `account_disabled` → 403, message contrôlé.

Les réponses sont JSON, `Cache-Control: no-store`, sans erreur interne. Le handler de connexion normalise les erreurs Better Auth en identifiants invalides ou erreur interne sans en recopier le message.

## Audit de sécurité

Les nouveaux événements sont :

- `auth.login.succeeded` ;
- `auth.login.rejected` ;
- `auth.logout.succeeded` ;
- `auth.access.denied`.

Données permises : identifiant utilisateur lorsqu’il est connu, méthode, route logique, permission ou rôle requis, et raison issue d’une enum locale (`invalid_credentials`, `account_disabled`, `missing_session`, `expired_session`, `forbidden`, `cross_origin`).

La connexion rejetée utilise un acteur système et n’a pas besoin de stocker l’email soumis. La connexion réussie, la déconnexion et les refus d’un utilisateur connu utilisent un acteur humain. Les corps et en-têtes de requête ne sont jamais copiés.

## Tests

### Tests unitaires et HTTP sans Docker

Des doubles de `AuthGateway` et `AuthHttpGateway` sont injectés uniquement dans les containers de test. Ils ne constituent pas un backend auth mémoire de production.

Les tests couvrent :

- les quatre codes et statuts HTTP ;
- la projection fail-closed ;
- absence de credential, expiration/révocation, compte désactivé ;
- hiérarchie réelle des rôles ;
- matrice owner/admin/operator/viewer pour chaque route ;
- ordre auth/origine/validation des mutations ;
- refus cross-origin ;
- allowlist login/logout et indisponibilité de l’inscription ;
- absence de token dans le JSON ;
- validation de `next` ;
- redirection UX du proxy sans prétention de sécurité ;
- contenu des audits et absence de clés sensibles.

### Intégration PostgreSQL 16 réelle

La suite Testcontainers utilise `postgres:16-alpine`, applique les migrations existantes et vérifie le flux complet : création interne, rôle, connexion HTTP, `Set-Cookie`, accès autorisé, refus par permission, session expirée/supprimée, compte désactivé, déconnexion autoritaire et audits persistés.

Les tests d’intégration ne sont jamais remplacés par des mocks ni présentés comme réussis s’ils sont ignorés.

## Hors périmètre

OAuth, MFA, passkeys, reset de mot de passe, vérification email, invitations, administration des utilisateurs, `user_agent_links`, impersonation, hash ou rotation personnalisée des tokens de session, modification de la hiérarchie des rôles, GitHub Actions, nouveau package et modification des migrations `0000`–`0002`.