# Audit d'exposition NVIDIA (endpoints d'essai) — 2026-10-14

Source : table `usage_history` d'OmniRoute (`/srv/icos/omniroute/storage.sqlite`), lue en lecture seule.
Seuls des compteurs ont été lus (date, nom de clé, endpoint, nombre de requêtes, tokens). Aucun prompt, aucune réponse et aucun secret n'ont été consultés.

## Constats

- Les requêtes vers le fournisseur `nvidia` remontent au 2026-07-24 : 89 936 au total, dont 18 436 servies via des combos OmniRoute (`auto/*`).
- Du 2026-10-01 au 2026-10-14 : environ 3 000 requêtes et plus de 80 M tokens d'entrée. Deux sources :
  - la clé « Hermes acces » (système Hermes / Holding IA) ;
  - des appels sans nom de clé (ICOS et labos).
- Le 2026-10-11 : 103 appels `/v1/messages`, environ 1 M tokens d'entrée. `/v1/messages` est le format de l'exécuteur Claude Code. Ces appels coïncident avec les runs N1 du labo antérieurs au passage du writer sur Claude, où Nemotron servait de writer ou de reviewer. Du code ICOS a donc très probablement été transmis à NVIDIA.
- Le 2026-10-13 : 39 appels sans nom de clé. Ils correspondent aux sondes et à la certification reviewer lancées par FABLE. Leur contenu est synthétique (fixtures de `scripts/reviewer-certify.ts` et sonde « PONG »), sans code ICOS réel.
- Production, aujourd'hui : `ICOS_COGNITIVE_MODEL` et `ICOS_PLANNER_MODEL` de `/srv/icos/etc/icos.env` désignent le fournisseur `nvidia`. Seul le préfixe a été lu. La cognition d'ICOS, c'est-à-dire les conversations, la mémoire et le contexte, est donc routée vers NVIDIA en continu.
- Les combos `auto/*` utilisés par le chat CEO de production (`auto/best-chat`) peuvent aussi être servis par NVIDIA.

## Conditions applicables

Constat du lot FREE_TIER, ADR 0078, lu le 2026-10-14 : les conditions NVIDIA API Trial excluent la production et autorisent NVIDIA à utiliser entrées et sorties pour améliorer ses modèles.

## Ce qui reste à décider par le propriétaire

1. Remplacer `ICOS_COGNITIVE_MODEL` et `ICOS_PLANNER_MODEL` en production par un fournisseur dont les conditions sont validées. Cela demande une modification de l'environnement de production et un redémarrage, sous la politique de release.
2. Évaluer l'exposition passée : contenu probable du code ICOS lors des runs N1 du 11/10, et des conversations et de la mémoire depuis juillet. Une revue juridique et RGPD est recommandée si des données clients ont transité.
3. Statuer sur l'usage de NVIDIA par la clé « Hermes acces », qui relève d'un autre système que ICOS.
