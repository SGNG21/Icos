---
name: icos-security
description: Use when touching authentication, sessions, roles, permissions, secrets, audit entries, CSRF/origin checks, or any action marked sensitive/requiring human approval
---

# icos-security

## Objectif

Garantir que toute fonctionnalité touchant à l'identité, l'autorisation, les
secrets ou l'audit respecte les invariants de sécurité ICOS : séparation
stricte humain/agent, refus par défaut, approbation humaine non
contournable, audit immuable sans donnée sensible.

## Contexte d'utilisation

- Ajout ou modification d'une route protégée, d'une garde (`requireSession`,
  `requireRole`, `requirePermission`).
- Toute action marquée `sensitive` ou `requiresHumanApproval`.
- Ajout d'un nouvel événement d'audit ou modification du contenu audité.
- Gestion de secrets, variables d'environnement, jetons, cookies.
- Vérification CSRF / origine pour une mutation.

**Ne doit PAS s'activer quand** la question porte uniquement sur _comment_
la donnée est stockée ou rendue atomique sans dimension autorisation/audit
(→ `icos-postgresql`), ou sur le substrat d'exécution d'un processus long
sans question de permission nouvelle (→ `icos-workflows-temporal`).

## Invariants ICOS

- Les humains (`user_roles` : owner ⊇ admin ⊇ operator ⊇ viewer) et les
  agents IA (`Agent.authorizationLevel` 0–3) sont deux concepts séparés ; un
  `authorizationLevel` d'agent ne participe jamais à l'autorisation d'un
  humain, et inversement.
- Le niveau d'autorisation est nécessaire mais jamais suffisant pour une
  action sensible : `requiresHumanApproval` ne peut jamais être contourné,
  même si une action sensible le déclare `false`.
- Une capacité déclarée par un agent, outil ou skill est une exigence à
  vérifier, jamais un grant. Sa découverte, son import ou son exécution ne
  modifie automatiquement aucune permission, policy ou hard gate ; les
  capacités dangereuses exigent une revue explicite et restent soumises à
  `requiresHumanApproval`.
- La provenance, la signature et le niveau de trust d'un skill sont des
  preuves distinctes, persistées et vérifiables ; aucune ne constitue à elle
  seule une autorisation d'installation, d'activation ou d'exécution.
- Toute décision est typée (`allowed`/`awaiting_approval`/`refused` + raison
  typée) — jamais de logique métier sur une chaîne libre.
- Un rejet explicite est prioritaire et définitif ; une information
  manquante conduit au refus ou à l'attente, jamais à l'autorisation
  implicite (fail-closed).
- Les guards suivent une classification stricte des refus :
  `unauthenticated` (401), `session_expired` (401), `account_disabled` (403),
  `forbidden` (403). Un statut utilisateur absent ou invalide n'est jamais
  converti en `active`.
- Les sessions sont validées de manière autoritaire en base ;
  `session.cookieCache` reste désactivé. Le proxy ne fait qu'une optimisation
  UX (présence de cookie) et ne remplace jamais la validation serveur.
- Toute mutation métier applique l'ordre : container → session → permission
  → origine → corps JSON → validation métier → exécution.
- Une action expirée ou rejetée ne peut jamais être exécutée par un message
  tardif (protection contre les retries/replays).
- L'audit est append-only (garantie SQL en plus de la garantie applicative) ;
  aucune entrée d'audit n'est jamais mise à jour ou supprimée.
- Aucun secret, cookie, token, mot de passe, hash, `DATABASE_URL`, en-tête
  sensible, erreur SQL brute ou stack trace n'est exposé en réponse HTTP ou
  journalisé en audit.
- Les secrets proviennent uniquement de l'environnement, jamais du dépôt.

## Ce qu'elle doit vérifier avant d'agir

1. La nouvelle route ou mutation a-t-elle une garde `requireSession` /
   `requireRole` / `requirePermission` correspondant à sa sensibilité ?
2. La matrice de permissions (`src/core/identity/permissions.ts`) est-elle
   consultée plutôt que dupliquée ou contournée ?
3. Une action sensible a-t-elle bien `requiresHumanApproval` non contournable
   quelle que soit sa configuration ?
4. Le contenu prévu pour un nouvel événement d'audit contient-il un secret,
   un corps de requête brut, ou un en-tête sensible ? Si oui, le retirer.
5. Une vérification d'origine/CSRF est-elle nécessaire pour cette mutation ?
6. La transition d'état proposée peut-elle laisser une action
   `approved`-mais-jamais-`executed`, ou `executed` sans exécution réelle
   (cf. anti-patterns Holding IA ci-dessous) ?

## Technologies autorisées

Better Auth 1.6.23 (email/mot de passe, sessions en base), matrice de rôles
ICOS interne (`core/identity`). Toute nouvelle méthode d'authentification
(OAuth, MFA, passkeys) est hors périmètre actuel et nécessite une décision
explicite (changement de sécurité/permissions).

## Anti-patterns

Issus des invariants ICOS et confirmés par l'audit Holding IA (voir
`icos-legacy-reuse` pour le détail des preuves) :

- Marquer une action `executed` après un simple stub qui ne l'exécute pas
  réellement (constaté dans le WF-B `action-dispatch.json` de Holding IA).
- Laisser une décision `approved` sans route d'exécution branchée (constaté
  dans le WF-C `action-decision.json` de Holding IA — six routes vides).
- Politique d'autonomie dispersée dans du code plutôt que centralisée et
  versionnée (constaté : `hard_gate` protégé uniquement dans du code n8n).
- Absence d'idempotence sur les webhooks/mutations, permettant qu'un retry
  crée ou exécute une action plusieurs fois.
- Croire qu'un cookie présent suffit à autoriser un accès (le proxy ICOS ne
  fait qu'une redirection UX, jamais une décision de sécurité).
- Journaliser un email, un mot de passe, un en-tête `Authorization`, ou un
  corps de requête brut dans l'audit.
- Copier un secret, un credential ou un identifiant historique depuis
  Holding IA (interdiction absolue, cf. `icos-legacy-reuse`).

## Sécurité

Cette compétence EST la compétence sécurité — voir invariants ci-dessus.
Point d'attention transversal : toute nouvelle capacité (RAG, orchestration
d'agents, intégration MCP) doit repasser par `icos-security` pour vérifier
que son chemin d'exécution respecte `approved` → `execution_requested` →
`executed`/`failed` sans raccourci.

## Stratégie TDD

- Écrire d'abord un test qui échoue pour chaque code de refus
  (`unauthenticated`, `session_expired`, `account_disabled`, `forbidden`)
  avant d'implémenter la garde correspondante.
- Tester la hiérarchie de rôles réelle (owner ⊇ admin ⊇ operator ⊇ viewer)
  avec des cas limites (dernier owner, admin tentant de promouvoir un owner).
- Tester l'absence de fuite de données sensibles dans les réponses d'erreur
  et les entrées d'audit (assertion négative explicite).
- Tests d'intégration Postgres réels (Testcontainers) pour le flux complet
  session → permission → décision → audit, jamais remplacés par des mocks.

## Définition de done

- `pnpm test` et `pnpm test:integration` (si Docker disponible) passent.
- Chaque nouveau code de refus est couvert par un test explicite.
- Aucune donnée sensible dans les assertions d'audit ou les réponses HTTP.
- La revue de sécurité correspondant à la phase roadmap concernée est
  déclenchée avant activation (cf. `docs/roadmap/initial-roadmap.md`).
