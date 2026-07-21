# ADR-0001 — Monolithe modulaire Next.js

- Statut : accepté
- Date : 2026-07-21

## Contexte

ICOS doit démarrer avec une interface exploitable tout en préparant plusieurs domaines et
intégrations sensibles. Une architecture distribuée immédiate ajouterait des contrats réseau, du
déploiement et de l'observabilité avant que les frontières métier soient validées.

## Décision

Utiliser Next.js App Router comme monolithe modulaire TypeScript. Les règles métier vivent dans des
modules `features`, indépendamment des composants et des futurs adaptateurs de `server`.

## Conséquences

- démarrage local et déploiement simples ;
- règles testables sans infrastructure ;
- frontières à faire respecter par les revues et l'outillage ;
- extraction future possible lorsqu'une contrainte concrète la justifie.
