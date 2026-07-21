# ADR-0002 — Contrats Zod partagés et services en mémoire

- Statut : accepté
- Date : 2026-07-21

## Contexte

Le Lot 1A introduit le noyau domaine d'ICOS : contrats métier, moteur
d'autorisation, cycle de vie des tâches et journal d'audit. Les types étaient
auparavant dispersés (`src/types`, `src/features/*`) et non validés à l'exécution.
La persistance (PostgreSQL) n'est pas encore disponible.

## Décision

1. **Source unique de vérité** : les contrats vivent dans `src/core/contracts`,
   décrits par des schémas Zod dont les types TypeScript sont inférés
   (`z.infer`). Les anciens types dupliqués ont été supprimés après migration.
2. **Domaine pur dans `src/core`** : autorisation (`core/authorization`) et
   cycle de vie des tâches (`core/tasks`) sont des fonctions pures, testables
   sans infrastructure.
3. **Services derrière des ports** : `src/server/services/ports.ts` définit les
   interfaces ; les implémentations `in-memory` sont seedées avec des copies
   défensives des données de démonstration.
4. **Politique d'autorisation prioritaire** : le champ déclaratif
   `requiresHumanApproval` d'une action ne peut jamais affaiblir la règle. Une
   action `sensitive` exige toujours une approbation humaine explicite, même si
   ce champ vaut `false`. Le niveau d'autorisation est nécessaire mais jamais
   suffisant pour le sensible.
5. **Décision typée** : `decideExecution` retourne un `outcome`
   (`allowed` / `awaiting_approval` / `refused`) et une `reason` typée
   (`authorized`, `approval_required`, `approval_rejected`,
   `insufficient_authorization`, `invalid_state`). Aucune logique métier ne
   repose sur des chaînes libres.
6. **Cohérence mutation–audit** : chaque service valide la commande, prépare le
   nouvel état, prépare et valide l'entrée d'audit, l'enregistre, puis applique
   la mutation. Si l'écriture d'audit échoue, la mutation n'est pas appliquée.

## Limites assumées (audit en mémoire)

Le journal d'audit `InMemoryAuditLog` est append-only au niveau de son interface
publique, mais reste **temporaire** :

- aucune persistance : perte totale au redémarrage du processus ;
- non fiable entre plusieurs instances ou processus ;
- non adapté à la production ; ne constitue aucune garantie d'audit ;
- l'atomicité mutation + audit y est séquentielle, pas transactionnelle.

La véritable atomicité transactionnelle et la durabilité seront apportées par le
remplacement PostgreSQL prévu en phase 1 de la feuille de route.

## Conséquences

- validation à l'exécution des données aux frontières du domaine ;
- règles de sécurité centralisées et testées, indépendantes de l'interface ;
- extraction future vers une persistance réelle sans changer les contrats ;
- discipline mutation–audit à réévaluer lors de l'introduction de PostgreSQL.
