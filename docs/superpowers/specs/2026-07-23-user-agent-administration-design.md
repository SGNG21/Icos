# Lot 2B-2 — Administration des humains et rattachements humains-agents

## 1. Objet

Le Lot 2B-2 ajoute une administration interne des identités humaines déjà portées par Better Auth et des rattachements opérationnels explicites entre humains et agents IA.

Il doit permettre à un humain autorisé de :

- consulter les comptes humains ;
- créer un compte interne avec un rôle ICOS effectif ;
- remplacer le rôle effectif d'un compte ;
- activer ou désactiver un compte ;
- consulter les agents IA administrables ;
- créer et retirer un rattachement humain-agent ;
- utiliser le rattachement pour limiter côté serveur les données et opérations du cockpit lorsque le rôle humain n'a pas une portée globale ;
- obtenir une trace d'audit fermée et non sensible pour chaque mutation administrative.

Ce lot ne crée aucune nouvelle source d'identité, ne transforme pas un agent en utilisateur et ne confond jamais rôle humain, permission applicative, niveau d'autonomie d'un agent et relation opérationnelle.

## 2. Contraintes non négociables

- Node.js `>=24 <25` ; toutes les commandes du lot s'exécutent sous Node 24.
- Aucun nouveau package.
- Better Auth reste l'autorité pour l'identité humaine, les credentials et les sessions.
- ICOS reste l'autorité pour les rôles humains, les permissions, le statut métier, les rattachements et l'audit.
- `HumanUser` et `Agent` restent deux agrégats distincts.
- `Role` humain ne devient jamais `Agent.authorizationLevel`.
- `HumanAgentLink.relation` n'accorde aucune permission applicative et ne modifie pas l'autonomie de l'agent.
- Toute autorisation et tout filtrage sont appliqués côté serveur ; l'interface n'est jamais une barrière de sécurité.
- `src/proxy.ts` reste une aide UX optimiste et ne participe à aucune décision métier.
- Un seul pool PostgreSQL, une seule instance Better Auth et le container mémoïsé existant sont réutilisés.
- Aucune connexion PostgreSQL à l'import et aucun fallback silencieux vers le backend mémoire.
- Les contrats du domaine restent indépendants de Next.js, Better Auth, Drizzle et PostgreSQL.
- Aucune donnée sensible dans une réponse, une erreur, un log ou un audit : mot de passe, hash, cookie, token, secret, contenu de session, headers complets, `DATABASE_URL`, erreur SQL brute ou stack trace.
- Les migrations `0000`, `0001`, `0002`, `0003` et leurs snapshots historiques ne sont jamais modifiés.
- La persistance nouvelle est introduite uniquement par une migration additive `0004` et son snapshot.
- Aucune cascade destructive n'est ajoutée pour les rattachements.
- Aucune fusion dans `main` sans autorisation explicite.

## 3. Vocabulaire et autorités

### 3.1 Identité humaine

`HumanUser` est la projection canonique ICOS de la table Better Auth `user` :

- `id` ;
- `email` ;
- `name` ;
- `status: active | disabled`.

Le mot de passe n'appartient jamais au modèle ICOS. La création du compte et du credential passe exclusivement par l'instance Better Auth existante derrière `AuthGateway`.

### 3.2 Identité d'agent

`Agent` reste le contrat existant : nom, rôle fonctionnel, statut, description et `authorizationLevel`. Ce dernier décrit l'autonomie technique de l'agent et n'est jamais dérivé d'un rôle humain ou d'un rattachement.

### 3.3 Rôle et permissions humaines

Un humain possède un rôle ICOS effectif parmi :

- `owner` ;
- `admin` ;
- `operator` ;
- `viewer`.

La table `user_roles` reste physiquement compatible avec plusieurs lignes, mais les API administratives exposent un seul rôle effectif, calculé avec `highestRole`. Une mutation de rôle remplace transactionnellement toutes les lignes de rôles administrés de la cible par le rôle demandé.

La matrice unique de `src/core/identity/permissions.ts` ajoute :

- `users.read` ;
- `users.create` ;
- `users.role.write` ;
- `users.status.write` ;
- `agentLinks.read` ;
- `agentLinks.write`.

Ces permissions appartiennent à `admin` et sont héritées par `owner`. Les permissions historiques `users.manage` et `owners.manage` sont retirées : la recherche de leurs consommateurs confirme qu'elles ne servent qu'à la politique `canManageRoleChange` et à ses tests, tous remplacés dans ce lot, et qu'aucune Route Handler ne les consomme. La capacité de toucher une cible `owner` ou `admin` relève des politiques métier pures, pas d'une deuxième matrice.

### 3.4 Rattachement humain-agent

Le contrat pur `HumanAgentLink` contient exactement :

- `id` ;
- `humanUserId` ;
- `agentId` ;
- `relation: supervisor | operator | observer` ;
- `createdAt` ;
- `createdByHumanUserId`.

L'unicité métier est `(humanUserId, agentId)`. Un rattachement signifie uniquement que l'agent appartient au périmètre opérationnel de l'humain. Les trois relations sont des métadonnées explicites pour l'administration et l'audit ; dans ce lot, elles ne changent ni les permissions de l'humain ni les opérations autorisées. Les permissions applicatives restent la seule autorité sur le type d'opération.

Une relation existante n'est pas mise à jour implicitement : un second `POST` retourne `already_exists`. La modification d'une relation se fait par retrait puis nouvelle création, ce qui produit deux événements d'audit clairs. Aucun `updatedAt` n'est donc nécessaire.

## 4. Invariants métier

### 4.1 Hiérarchie et auto-administration

- Un `admin` peut créer et administrer uniquement des cibles dont le rôle effectif est `operator` ou `viewer`.
- Un `admin` ne peut pas créer, promouvoir, rétrograder, désactiver, réactiver ou modifier les rattachements d'un `owner` ou d'un autre `admin`.
- Un `owner` peut administrer un autre compte de tout rôle, y compris un autre `owner`, sous réserve de la protection du dernier owner actif.
- Aucun humain ne peut modifier son propre rôle, son propre statut ou ses propres rattachements par les API administratives.
- L'auto-promotion est donc toujours interdite.
- Un agent IA n'est jamais un acteur accepté par le service administratif.

Ces décisions sont exprimées par des fonctions pures dans `src/core/identity/role-management.ts`, puis réévaluées dans le service applicatif à partir du rôle effectif de l'acteur et de la cible. L'absence de rôle effectif est un refus fermé.

### 4.2 Dernier owner actif

Aucune mutation ne peut retirer le rôle `owner` du dernier owner actif ni désactiver le dernier owner actif.

La règle n'est jamais implémentée par un simple comptage suivi d'une écriture. L'unité de travail PostgreSQL verrouille les lignes des owners actifs avec `SELECT ... FOR UPDATE`, réévalue l'invariant, puis effectue la mutation dans la même transaction.

### 4.3 Sessions et statut

- Un changement de rôle, même vers un rôle moins privilégié, supprime toutes les sessions Better Auth de la cible dans la transaction de mutation.
- Une désactivation met `user.status` à `disabled`, supprime toutes les sessions de la cible et conserve l'identité, le credential, les rôles, les rattachements et l'historique.
- Une réactivation remet uniquement le statut à `active` ; elle ne crée aucune session.
- Better Auth et les guards existants continuent d'interdire une connexion ou une session d'un compte désactivé.
- Une mutation répétée vers le même rôle ou le même statut est idempotente. Elle n'écrit ni rôle ni statut et ne révoque pas de session ; elle retourne l'état courant et écrit seulement l'événement administratif avec `changed: false`, afin que la tentative sensible reste auditée.

### 4.4 Création interne

`POST /api/users` accepte un email, un mot de passe, un nom facultatif et un rôle effectif.

Le flux est :

1. guard serveur et same-origin ;
2. validation stricte sans refléter les valeurs rejetées ;
3. décision hiérarchique sur le rôle demandé ;
4. création de l'identité et du credential par `AuthGateway.createHumanUser` ;
5. transaction ICOS qui attribue le rôle et écrit `human_user.created` ;
6. réponse sans mot de passe, hash, token, cookie ou contenu de session.

Better Auth utilise déjà `autoSignIn: false` : la création ne connecte ni le créateur ni le compte créé.

Si l'étape ICOS échoue après la création Better Auth, le service appelle `AuthGateway.deleteHumanUser` en compensation. Si la compensation échoue, l'API retourne une erreur fermée `internal_error` sans détail sensible ; l'échec n'est jamais transformé en succès.

Le bootstrap owner existant reste le seul mécanisme de bootstrap. L'API normale ne déclenche jamais le bootstrap et ne crée aucun owner implicite.

### 4.5 Rattachements

- La cible humaine doit exister et posséder un rôle effectif.
- L'agent doit exister.
- La relation doit appartenir à l'enum fermée.
- L'acteur doit pouvoir administrer la cible selon la même hiérarchie que les mutations de statut.
- La paire `(humanUserId, agentId)` est unique.
- Le créateur est toujours l'identifiant de la session humaine authentifiée.
- La création ou le retrait du lien et son audit sont atomiques.
- Les clés étrangères utilisent `ON DELETE RESTRICT` pour conserver l'historique et empêcher une suppression destructive implicite.

## 5. Architecture retenue

### 5.1 Approches comparées

#### A. Orchestration dans les Route Handlers

Cette option étendrait directement les repositories depuis chaque route. Elle crée peu de fichiers, mais disperse les politiques hiérarchiques, épaissit les handlers et rend difficile l'atomicité rôle/statut/session/audit. Elle est rejetée.

#### B. Service applicatif avec transactions réparties

Cette option centralise les cas d'usage dans un service, mais laisse chaque repository gérer sa transaction. Elle améliore la lisibilité HTTP sans garantir une transaction commune pour les rôles, les sessions Better Auth, les liens et l'audit. Elle est rejetée pour les mutations sensibles.

#### C. Service applicatif et unité de travail administrative dédiée

Cette option est retenue :

- `HumanAdministrationService` orchestre les cas d'usage sans dépendre de Next.js ;
- des politiques pures déterminent qui peut administrer quelle cible ;
- `HumanAdministrationUnitOfWork` applique les mutations multi-écritures dans une transaction PostgreSQL commune ;
- `AuthGateway` reste l'unique porte de création/suppression compensatoire Better Auth ;
- les Route Handlers ne font que guard, same-origin, parsing, appel de service et mapping de réponse ;
- le même handle Drizzle du container est injecté partout.

Cette séparation garde les règles testables sans Docker et réserve à PostgreSQL les garanties de concurrence et d'atomicité.

### 5.2 Unités et responsabilités

#### Domaine pur

- `permissions.ts` : enum et matrice unique des permissions.
- `role-management.ts` : politiques acteur/cible, changement de rôle, statut et rattachements.
- `human-agent-link.ts` : contrat et relation fermée.
- `audit.ts` : événements administratifs fermés.

#### Lecture et service applicatif

- `HumanUserAdministrationRepository` : liste des humains avec rôle effectif et lecture d'une projection administrative.
- `HumanAgentLinkRepository` : lecture des liens et des identifiants d'agents accessibles ; les écritures restent dans l'UoW.
- `HumanAdministrationService` : listes et orchestration des créations/mutations.
- `OperationalAccessService` : calcule la portée globale ou l'ensemble d'agents rattachés d'une session et protège les ressources opérationnelles.

#### Unité de travail

`HumanAdministrationUnitOfWork` expose des opérations ciblées :

- finaliser la création d'un humain avec son rôle et son audit ;
- remplacer un rôle, révoquer les sessions et auditer ;
- changer un statut, révoquer les sessions uniquement lors d'une désactivation effective et auditer ;
- créer un rattachement et auditer ;
- retirer un rattachement et auditer.

Son implémentation PostgreSQL utilise exclusivement le `Database` existant. Elle importe les tables Better Auth existantes pour modifier `user`, `user_roles` et `session` dans la même transaction, sans instancier Better Auth ni ouvrir une connexion supplémentaire.

#### HTTP

`protectRoute` retourne une union discriminée :

```ts
type ProtectedRouteResult =
  { ok: true; session: AuthenticatedSession } | { ok: false; response: Response };
```

Les handlers réutilisent ainsi la session déjà validée pour attribuer l'acteur et calculer sa portée, sans seconde lecture. Les refus continuent d'être audités par le mécanisme de sécurité existant.

#### Composition

Le container PostgreSQL compose les repositories, l'UoW et les services avec le même `handle.db` et la même façade `auth`. Le container mémoire n'expose aucun service administratif : une route appelée avec ce backend échoue fermée. Des doubles mémoire locaux aux tests peuvent implémenter les ports, mais ne deviennent jamais un backend runtime.

## 6. Persistance PostgreSQL

### 6.1 Nouvelle table

La migration `0004` crée `human_agent_links` :

- `id text primary key` ;
- `human_user_id text not null references user(id) on delete restrict` ;
- `agent_id text not null references agents(id) on delete restrict` ;
- `relation text not null` avec check `supervisor | operator | observer` ;
- `created_at timestamptz not null` ;
- `created_by_human_user_id text not null references user(id) on delete restrict` ;
- contrainte unique `(human_user_id, agent_id)` ;
- index par `human_user_id` et par `agent_id`.

### 6.2 Audit

L'enum Zod et la contrainte SQL `audit_event_type_check` sont étendues de façon additive avec :

- `human_user.created` ;
- `human_user.role_changed` ;
- `human_user.enabled` ;
- `human_user.disabled` ;
- `human_agent_link.created` ;
- `human_agent_link.removed` ;
- `human_user.administration_denied`.

La migration remplace uniquement la contrainte de check courante par une contrainte incluant les anciennes et nouvelles valeurs. Elle ne modifie aucune donnée historique.

### 6.3 Contenu fermé des audits

Les détails sont construits par une fonction typée, jamais depuis un objet de requête arbitraire :

- création : `targetUserId`, `role` ;
- rôle : `targetUserId`, `previousRole`, `nextRole`, `changed` ;
- statut : `targetUserId`, `previousStatus`, `nextStatus`, `changed` ;
- lien créé/retiré : `targetUserId`, `agentId`, `relation` ;
- refus métier : `operation`, `targetUserId` facultatif, `reason` parmi `forbidden | last_owner | already_exists | not_found`.

L'acteur est `{ kind: "human", id: session.user.id }`. Aucun email, nom, mot de passe, credential, cookie, token, header, hash, secret, SQL ou contenu de session n'est copié dans `details`.

Les audits des mutations réussies sont écrits dans la transaction de la mutation. Un refus métier après authentification écrit `human_user.administration_denied` avant de répondre. Si cet audit échoue, aucune mutation n'est appliquée et la réponse devient `audit_failed`. Les refus de session, permission ou origine restent couverts par `auth.access.denied` et ne sont pas dupliqués.

## 7. API administrative

Toutes les routes sont Node.js, dynamiques, protégées par les guards centraux et indépendantes du proxy.

### 7.1 `GET /api/users`

- permission : `users.read` ;
- retourne `{ users: AdminHumanUser[] }` ;
- chaque projection contient uniquement `id`, `email`, `name`, `status`, `role` ;
- ordre stable par email puis id ;
- aucune donnée de credential ou session.

### 7.2 `POST /api/users`

- permission : `users.create` ;
- same-origin obligatoire ;
- corps strict : `{ email, password, name?, role }` ;
- mot de passe d'au moins 12 caractères, cohérent avec Better Auth ;
- applique la hiérarchie acteur/rôle demandé ;
- retourne `201` avec `{ user }` ;
- doublon : `409 already_exists` ;
- validation : `400 invalid_input` sans valeur rejetée.

### 7.3 `PATCH /api/users/[id]/role`

- permission : `users.role.write` ;
- same-origin obligatoire ;
- corps strict : `{ role }` ;
- interdit toute auto-modification ;
- applique hiérarchie et garde du dernier owner ;
- remplace le rôle et révoque toutes les sessions dans la transaction ;
- retourne `{ user }` ;
- dernier owner : `409 last_owner`.

### 7.4 `PATCH /api/users/[id]/status`

- permission : `users.status.write` ;
- same-origin obligatoire ;
- corps strict : `{ status: active | disabled }` ;
- interdit toute auto-modification ;
- applique hiérarchie et garde du dernier owner ;
- révoque toutes les sessions lors d'une désactivation ;
- retourne `{ user }` ;
- dernier owner : `409 last_owner`.

### 7.5 `GET /api/users/[id]/agent-links`

- permission : `agentLinks.read` ;
- applique la hiérarchie de cible afin qu'un admin ne consulte pas l'administration d'un owner/admin ;
- retourne `{ links: HumanAgentLink[] }` dans un ordre stable ;
- cible absente : `404 not_found`.

### 7.6 `POST /api/users/[id]/agent-links`

- permission : `agentLinks.write` ;
- same-origin obligatoire ;
- corps strict : `{ agentId, relation }` ;
- applique la hiérarchie de cible ;
- retourne `201` avec `{ link }` ;
- paire existante : `409 already_exists` ;
- agent ou humain absent : `404 not_found`.

### 7.7 `DELETE /api/users/[id]/agent-links/[agentId]`

- permission : `agentLinks.write` ;
- same-origin obligatoire ;
- applique la hiérarchie de cible ;
- supprime exactement la paire et retourne `204` ;
- paire absente : `404 not_found`.

### 7.8 `GET /api/admin/agents`

Cette route est distincte de la vue opérationnelle :

- permission : `agentLinks.read` ;
- retourne la liste globale des agents à owner/admin pour administrer les rattachements ;
- ne modifie pas `Agent.authorizationLevel` ;
- aucune mutation d'agent n'est ajoutée dans ce lot.

### 7.9 Codes d'erreur

L'union API existante ajoute uniquement :

- `already_exists` → 409 ;
- `last_owner` → 409.

Les autres cas réutilisent `invalid_input`, `not_found`, `forbidden`, `audit_failed`, `persistence_unavailable`, `transient_conflict` et `internal_error`. Les réponses n'exposent jamais une erreur SQL brute. Une ressource opérationnelle hors périmètre est présentée comme `not_found` afin de ne pas révéler son existence.

## 8. Portée opérationnelle par rattachement

### 8.1 Calcul central

`OperationalAccessService` calcule une portée à partir de la session :

```ts
type AgentScope = { kind: "global" } | { kind: "linked"; agentIds: ReadonlySet<string> };
```

- `owner` et `admin` obtiennent `global` ;
- `operator` et `viewer` obtiennent uniquement les agents liés à leur `user.id` ;
- aucune relation ou aucun rôle effectif produit un ensemble vide, jamais une portée globale.

La relation du lien n'altère pas ce calcul dans ce lot.

### 8.2 Routes existantes

- `GET /api/agents` devient la liste opérationnelle : globale pour owner/admin, filtrée pour operator/viewer.
- `GET /api/tasks` retourne toutes les tâches pour owner/admin ; pour operator/viewer, uniquement celles dont `assignedAgentId` est lié. Les tâches non assignées sont cachées aux rôles à portée liée.
- `POST /api/tasks` conserve `tasks.write`. Owner/admin peuvent créer une tâche assignée ou non. Un operator doit fournir un `assignedAgentId` lié ; une cible absente ou hors périmètre est refusée.
- `POST /api/tasks/[id]/transition` conserve `tasks.write` et refuse comme `not_found` une tâche non assignée ou assignée à un agent non lié pour un operator.
- `GET /api/actions` retourne les actions dont `initiatedByAgentId` est dans la portée.
- `POST /api/actions/[id]/decision` conserve `approvals.decide` et refuse comme `not_found` une action hors portée avant toute décision ou exposition de données.

Le filtrage est réalisé par des méthodes de repository acceptant la portée ou les identifiants d'agents. Il n'est pas appliqué uniquement après une lecture globale dans l'interface.

### 8.3 Cockpit serveur

`resolveCockpitAccess` retourne la session avec le résultat autorisé. `src/app/page.tsx` calcule ensuite une seule portée et charge en parallèle des listes cohérentes d'agents, tâches et actions.

Le rendu serveur n'expose donc jamais à operator/viewer un agent, une tâche ou une action hors rattachement. Les composants client continuent d'appeler les routes filtrées ; ils n'embarquent ni matrice de permissions ni liste globale cachée.

## 9. Interface utilisateur

Une page serveur ciblée `GET /admin/users` est ajoutée sans refonte du cockpit :

- protection serveur `users.read` avant toute lecture métier ;
- tableau accessible des humains avec rôle et statut ;
- formulaire de création interne ;
- contrôles de rôle et statut ;
- panneau de rattachements pour une cible sélectionnée ;
- liste des agents issue de `/api/admin/agents` ;
- confirmation explicite avant désactivation, changement de rôle et retrait d'un lien ;
- état occupé, succès et erreur annoncé avec `aria-live` ;
- labels associés aux champs, focus visible et boutons désactivés pendant une mutation ;
- messages génériques ne contenant aucune donnée sensible.

La navigation peut afficher « Administration » uniquement lorsque la session possède `users.read`, mais cette visibilité reste une commodité. La page et chaque Route Handler refont le contrôle côté serveur. Pour éviter de dupliquer la matrice côté client, le composant serveur calcule et transmet un booléen de capacité ou rend directement l'entrée autorisée.

## 10. Ordre de traitement et sécurité HTTP

Chaque mutation suit l'ordre suivant :

1. obtenir le container ;
2. exiger la session et la permission ;
3. valider same-origin ;
4. lire le corps JSON ;
5. valider le schéma strict ;
6. appeler le service avec `actorUserId` et les rôles de la session ;
7. appliquer politique, transaction et audit ;
8. mapper un résultat typé vers une réponse contrôlée.

Ainsi, un appel sans session, sans permission ou cross-origin ne lit pas le corps et ne touche pas la base métier. Les protections CSRF natives Better Auth restent actives pour les endpoints auth ; les mutations ICOS utilisent en plus `isSameOriginMutation`.

Les schémas `.strict()` refusent tout champ supplémentaire, notamment un hash, un token, un cookie, un statut arbitraire, une permission copiée par le client ou un `authorizationLevel` d'agent.

## 11. Stratégie de tests

### 11.1 Tests unitaires sans Docker

- matrice des six permissions et héritage owner/admin/operator/viewer ;
- politiques admin vers operator/viewer et refus admin vers admin/owner ;
- politiques owner, auto-modification et absence de rôle ;
- dernier owner ;
- schéma `HumanAgentLink` et enum de relation ;
- service de création et compensation ;
- rôle/statut/lien, idempotence et mapping des refus ;
- contenu fermé des audits, avec assertions négatives sur les clés sensibles ;
- calcul `AgentScope` ;
- filtrage agents/tâches/actions et tâches non assignées ;
- `protectRoute` retourne la session sans double lecture.

Chaque comportement de production commence par un test RED observé, puis le minimum GREEN et un refactor sous tests verts.

### 11.2 Tests HTTP et sécurité sans Docker

- chaque route refuse session absente, expirée, compte désactivé et permission insuffisante ;
- chaque mutation refuse une origine étrangère avant lecture du corps ;
- corps stricts et erreurs sans valeur sensible ;
- admin ne touche ni admin ni owner ;
- auto-administration refusée ;
- owner peut gérer une autre cible autorisée ;
- réponses sans credential, token, cookie, hash ou session ;
- listes opérationnelles filtrées ;
- transitions et décisions hors périmètre retournent `not_found` ;
- backend mémoire sans administration échoue fermé.

### 11.3 Intégration PostgreSQL 16 réelle

Avec Testcontainers `postgres:16-alpine` :

- migration additive applicable depuis `0000` à `0004` ;
- création interne : Better Auth user/account + rôle ICOS + audit, sans session automatique ;
- doublon email refusé sans créer d'identité supplémentaire ;
- échec de finalisation ICOS compensé par suppression de l'identité Better Auth nouvellement créée ;
- remplacement transactionnel du rôle et révocation de toutes les sessions ;
- désactivation, révocation et refus de nouvelle connexion ;
- réactivation sans création de session ;
- deux mutations concurrentes ne peuvent supprimer/désactiver le dernier owner actif ;
- unicité d'un lien et FKs restrictives ;
- lien et audit atomiques en création/retrait ;
- audit fermé sans donnée sensible ;
- filtrage réel par rattachement dans les repositories PostgreSQL ;
- un seul handle de base et fermeture propre du container.

Aucun test d'intégration ignoré n'est présenté comme réussi. Docker indisponible est signalé comme un blocage, pas comme un succès.

## 12. Fichiers envisagés

### Domaine

- modifier `src/core/identity/permissions.ts` ;
- modifier `src/core/identity/role-management.ts` ;
- créer `src/core/identity/human-agent-link.ts` ;
- modifier `src/core/identity/index.ts` ;
- modifier `src/core/contracts/audit.ts` ;
- étendre `src/core/identity/identity.test.ts` ;
- créer `src/core/identity/human-agent-link.test.ts` et `src/core/identity/role-management.test.ts`.

### Application, ports et persistance

- étendre `src/server/repositories/ports.ts` avec `AdminHumanUser`, `HumanUserAdministrationRepository`, `HumanAgentLinkRepository` et les lectures opérationnelles filtrées ;
- créer `src/server/administration/human-administration-service.ts` et ses tests ;
- créer `src/server/administration/operational-access-service.ts` et ses tests ;
- étendre `src/server/uow/ports.ts` ;
- créer `src/server/uow/postgres-human-administration-uow.ts` ;
- créer `src/server/repositories/postgres/human-agent-link-repository.ts` ;
- étendre les repositories PostgreSQL humain, agent, tâche et action ;
- modifier `src/server/database/schema.ts` ;
- créer uniquement `drizzle/0004_*.sql` et `drizzle/meta/0004_snapshot.json` ;
- ajouter seulement l'entrée 4 dans `drizzle/meta/_journal.json`.

### HTTP et composition

- modifier `src/server/http/protect-route.ts` et ses tests ;
- créer des schémas HTTP administratifs stricts ;
- modifier `src/server/http/errors.ts` ;
- créer les Route Handlers sous `src/app/api/users`, `src/app/api/admin/agents` ;
- adapter les routes agents, tâches et actions existantes ;
- modifier `src/server/container.ts` et ses tests de composition.

### Cockpit et UI

- modifier `src/server/auth/cockpit-access.ts` ;
- modifier `src/app/page.tsx` ;
- créer `src/app/admin/users/page.tsx` et des composants d'administration ciblés ;
- modifier `src/components/layout/sidebar.tsx` ;
- ajouter uniquement les styles nécessaires dans `src/styles/globals.css`.

## 13. Hors périmètre

- invitation email ;
- récupération ou changement de mot de passe ;
- OAuth, MFA et passkeys ;
- équipes, organisations, multi-tenant et facturation ;
- suppression physique d'un humain ;
- création, modification ou suppression d'un agent ;
- sémantique d'autorisation différente selon `supervisor`, `operator` ou `observer` ;
- gestion du niveau d'autonomie d'un agent depuis l'administration humaine ;
- mémoire IA, orchestration autonome et outils externes ;
- GitHub MCP, Gmail, Drive, Calendar, n8n ou Dolibarr ;
- interface vocale ;
- refonte graphique générale ;
- nouveau package ou changement GitHub Actions non indispensable.

## 14. Critères d'acceptation

Le lot est acceptable seulement si :

1. l'identité Better Auth et les concepts ICOS restent séparés ;
2. les six permissions administratives sont centrales et vérifiées serveur ;
3. admin, owner, operator et viewer suivent la politique décrite ;
4. le dernier owner actif ne peut pas disparaître, y compris sous concurrence ;
5. rôle et désactivation révoquent les sessions ;
6. création Better Auth et finalisation ICOS utilisent une compensation explicite ;
7. les liens sont persistés avec unicité et FKs restrictives ;
8. chaque mutation réussie et chaque refus métier pertinent sont audités sans secret ;
9. le cockpit et les routes opérationnelles filtrent par rattachement côté serveur ;
10. owner/admin conservent une route administrative globale distincte ;
11. le backend mémoire ne devient pas un fallback administratif ;
12. la migration est exclusivement additive `0004` ;
13. les tests unitaires, HTTP, PostgreSQL 16, typecheck, lint, format et build passent sous Node 24 ;
14. aucun package, deuxième pool, deuxième Better Auth ou connexion à l'import n'est introduit ;
15. la PR est créée et contrôlée, sans fusion.
