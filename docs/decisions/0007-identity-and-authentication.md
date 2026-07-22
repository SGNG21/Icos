# ADR-0007 — Fondation d'identité et d'authentification humaine (Lot 2B-1a)

- Statut : accepté (sous-lot 2B-1a)
- Date : 2026-07-22

## Contexte

ICOS doit distinguer strictement l'identité **humaine** (utilisateur) de
l'identité **agent IA**, et « qui est connecté » (authentification) de « ce que
l'utilisateur peut faire » (autorisation applicative), sans confondre les rôles
humains avec `Agent.authorizationLevel`.

## Décision

- **Moteur** : `better-auth@1.6.23` (adaptateur Drizzle intégré, hachage scrypt,
  sessions en base révocables, cookies préfixés `icos`, CSRF). Compatible Node 24,
  Next 16, Drizzle 0.45.2, TS 6 (typecheck vert). Aucun nouveau driver DB.
- **Frontière** : Better Auth répond à « qui est connecté » ; ICOS conserve les
  rôles, permissions, l'audit sécurité, le bootstrap et la séparation humain/agent.
  Une **façade ICOS** (`AuthenticationService`, `AuthorizationService`) isole
  Better Auth ; les routes ne dépendront que d'interfaces ICOS.
- **Schéma** (`auth-schema.ts`, généré par `auth generate` puis revu) : tables
  Better Auth `user`/`session`/`account`/`verification` **conservées telles quelles**
  (noms singuliers, `timestamp` sans fuseau — convention de la bibliothèque). Champ
  ICOS `user.status` (`active`/`disabled`, `CHECK`, `input:false`). Table ICOS
  **`user_roles`** (multi-rôles, PK `(user_id, role)`, `CHECK`, FK cascade, index) —
  **distincte** d'`agents.authorization_level`. Le hash de mot de passe réside
  UNIQUEMENT dans `account.password` (aucune table `credentials` ni hasher ICOS).
- **Token de session** : stocké NATIVEMENT par Better Auth dans `session.token`
  (non haché au repos ; cookie signé). **Divergence assumée** avec le souhait
  initial de token haché — modèle standard Better Auth (token haute entropie +
  cookie signé + validation autoritaire en base, `cookieCache` désactivé). Le
  token n'apparaît jamais dans les logs, l'audit, les réponses ou les fixtures.
- **Sessions** : `expiresIn` 7 j, `updateAge` 24 h, `cookieCache` désactivé
  (validation en base), révocation par suppression de session en base.
- **Rôles/permissions** : `owner ⊇ admin ⊇ operator ⊇ viewer`, matrice PURE
  (`core/identity`), sans I/O. Un utilisateur `disabled` n'a aucune permission.
- **Dernier owner** : gardes transactionnelles (`SELECT … FOR UPDATE` sur les
  owners actifs) refusant retrait de rôle owner et désactivation du dernier owner ;
  un `admin` ne peut ni promouvoir en owner ni modifier un owner (règles pures +
  garde repo).
- **Bootstrap** : `bootstrapOwner` idempotent (créé / réparé / already_present),
  création via l'API serveur Better Auth (jamais de hash manuel), compensation
  (suppression cascade) si l'attribution du rôle échoue après création. Audit
  `user.created` / `role.changed` / `auth.bootstrap.succeeded|failed` sans secret.
- **Backend** : l'auth réelle exige PostgreSQL ; le container ne compose l'auth
  que si `BETTER_AUTH_SECRET`/`URL` sont fournis. `PERSISTENCE=memory` n'ouvre
  aucune connexion et ne compose pas d'auth (aucun mode permissif).

## Bootstrap exécutable

`pnpm auth:bootstrap` = `tsx scripts/auth-bootstrap.ts` (dépendance dev
`tsx@4.22.5`, ajoutée pour exécuter le graphe TS avec « parameter properties » et
alias `@/`). Le script est un adaptateur MINCE autour de `bootstrapOwner` : il
valide la configuration **avant** toute écriture (refuse un backend non-PostgreSQL,
exige `ICOS_OWNER_EMAIL` et `ICOS_OWNER_PASSWORD`), ouvre **un seul** client
PostgreSQL partagé par Better Auth, exécute le bootstrap, affiche un résultat non
sensible (`owner_created` / `owner_repaired` / `owner_already_present`), ferme le
client dans un `finally`, et retourne un code non nul en cas d'échec. Le mot de
passe est fourni **ponctuellement** via `ICOS_OWNER_PASSWORD` puis retiré de
l'environnement (jamais dans un `.env` partagé, un fichier shell ou l'historique).
`emailAndPassword.autoSignIn` est désactivé : le bootstrap ne crée **aucune
session durable**. Better Auth calcule lui-même le hash ; le script n'écrit jamais
dans `account.password`.

## Hors périmètre

Aucune route existante n'est protégée (Lot 2B-1b) ; `/api/auth/*`, `/login`,
`src/proxy.ts`, guards, `user_agent_links`, reset mot de passe, OAuth/MFA/passkeys
restent hors périmètre.
