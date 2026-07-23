---
name: icos-architecture
description: Use when adding a new module, unsure which ICOS layer (app/components/core/features/server/app-api/config) code belongs in, defining a new contract or port, or introducing a new top-level dependency between layers
---

# icos-architecture

## Objectif

Garantir que tout nouveau code respecte le monolithe modulaire ICOS : couches
explicites, dépendances à sens unique, `core` pur sans I/O, contrats Zod comme
source unique de vérité. Cette compétence est le point de dernier recours
pour toute question de frontière — les autres compétences ICOS supposent les
couches déjà connues.

## Contexte d'utilisation

- Ajout d'un nouveau module, service, ou fichier dont la couche n'est pas
  évidente.
- Doute sur si une règle métier doit vivre dans `core` ou `server`.
- Introduction d'un nouveau contrat Zod ou modification d'un contrat existant.
- Toute autre compétence ICOS qui bute sur une question de couche renvoie ici.

**Ne doit PAS s'activer quand** la couche cible est déjà évidente et non
contestée, ou que la question relève uniquement d'une compétence
spécialisée sans ambiguïté de couche (autorisation → `icos-security`,
mécanique de stockage → `icos-postgresql`, etc.) : dans ce cas la
compétence spécialisée s'applique directement, sans détour par
`icos-architecture`.

## Invariants ICOS

- `app` compose routes et layouts, ne porte aucune règle métier (ADR-0001).
- `core` ne dépend d'aucune infrastructure (pas de Next.js, Drizzle, Better
  Auth, fetch réseau) ; ses fonctions métier pures restent synchrones.
- `core/contracts` (Zod) est la source unique de vérité des formes de
  données ; aucun type dupliqué à la main ailleurs.
- Les accès aux entités passent par des ports asynchrones
  (`server/repositories/ports.ts`) ; une ressource absente est `null`, jamais
  `undefined`.
- Le flux d'appel est strictement : Interface → Route Handlers → use cases →
  politiques d'autorisation → ports → adaptateurs externes (ADR-0003).
- Une intégration externe n'est jamais appelée directement depuis un
  composant ; elle passe toujours par `server`.
- Le container de composition (`server/container.ts`) est le point unique de
  câblage des dépendances ; pas de nouvelle instanciation ad hoc de
  repository ou de service ailleurs.
- Frontières de système (issues de l'audit Holding IA, non négociables) :
  PostgreSQL est l'état métier authoritative d'ICOS ; ICOS porte
  l'orchestration et la gouvernance, jamais la fabrication de sites
  (DigitalOS) ; la mémoire/RAG est un service externe consommé via un
  Context Port, jamais une base documentaire interne (`icos-rag-memory`) ;
  n8n reste au mieux un adaptateur temporaire vers un système externe,
  jamais l'orchestrateur central (`icos-workflows-temporal`) ; WhatsApp,
  Twilio et tout canal de messagerie sont des adaptateurs de canal
  (Polivia), jamais une source de logique métier. Le domaine ICOS
  (`core`, `features`) n'a aucune dépendance directe vers Supabase, Meta,
  Twilio ou n8n — toute intégration de ce type passe par `server` et un
  adaptateur explicite.

## Ce qu'elle doit vérifier avant d'agir

1. Le code nouveau a-t-il une dépendance vers une couche qu'il ne devrait pas
   connaître (ex. `core` important `next/server`) ?
2. Une règle métier est-elle en train d'être écrite dans `app` ou
   `components` au lieu de `core`/`server` ?
3. Un contrat existe-t-il déjà dans `core/contracts` pour cette forme de
   donnée, avant d'en créer un nouveau ?
4. Le nouveau port respecte-t-il la signature asynchrone standard
   (`Promise<Entity | null>`) ?
5. Le changement nécessite-t-il une nouvelle ADR (décision architecturale
   significative) ou s'inscrit-il dans une décision déjà actée ?
6. Le domaine (`core`, `features`) est-il en train d'acquérir une dépendance
   directe vers Supabase, Meta, Twilio ou n8n au lieu de passer par un
   adaptateur `server` explicite ?

## Technologies autorisées

Next.js 16 (App Router), React 19, TypeScript strict, Zod 4, Tailwind 4,
pnpm. Toute nouvelle dépendance de production est une décision qui nécessite
validation explicite de l'utilisateur (dépendance externe significative).

## Anti-patterns

- Logique métier dans un Server Component ou un Route Handler au lieu d'un
  use case.
- Type TypeScript dupliqué à la main alors qu'un contrat Zod existe déjà.
- Import direct d'un repository concret au lieu de passer par le container.
- Retour `undefined` pour une ressource absente au lieu de `null`.
- Appel réseau ou SQL direct depuis `core`.
- Introduction d'une nouvelle couche ou d'un nouveau découpage de service
  sans contrainte mesurée de sécurité, charge ou organisation (contraire à
  « Évolution prévue » de `docs/architecture/overview.md`).

## Sécurité

L'architecture en couches est elle-même un contrôle de sécurité : elle
garantit qu'aucune intégration externe n'est atteignable sans passer par les
politiques d'autorisation. Toute violation de cette frontière est un
problème de sécurité, pas seulement de style — à traiter avec `icos-security`
si la question touche à l'auth ou aux permissions.

## Stratégie TDD

- Un nouveau port ou contrat s'accompagne d'un test qui vérifie sa forme
  (validation Zod) avant toute implémentation concrète.
- Un test d'intégration de couche (ex. un Route Handler ne doit pas pouvoir
  contourner un use case) est écrit avant le code qui le satisferait.
- Suivre RED → GREEN → REFACTOR : le test de frontière échoue d'abord si la
  règle est violée.

## Définition de done

- `pnpm typecheck`, `pnpm lint`, `pnpm test` passent.
- Aucune nouvelle dépendance inter-couches non documentée dans une ADR si
  elle est structurante.
- Le contrat Zod concerné (s'il existe) reste la seule source de vérité de
  la forme de donnée.
- Le container de composition reste le point unique de câblage.
