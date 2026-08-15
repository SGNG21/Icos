# Politiques de rétention — ICOS

| Statut | Version |
| ------ | ------- |
| Projet | 0.1     |

## 1. Objectif

Définir les durées et modalités de conservation des données traitées par ICOS,
en application de l'invariant de sécurité 14 (voir `docs/ICOS_MASTER_PLAN.md` §6) :

> Aucun agent ni modèle ne peut décider seul de conserver une donnée
> indéfiniment ; toute rétention est bornée par une politique explicite,
> versionnée et révisable par un humain habilité.

Cette politique couvre :

- les durées de conservation par niveau de classification (C0–C3) ;
- les règles de purge et de destruction ;
- les responsabilités et la gouvernance des dérogations ;
- les cycles de révision.

Elle s'applique à l'ensemble des traitements, stockages, logs et sauvegardes
opérés par ICOS, y compris ceux délégués à des sous-traitants (hébergement,
base de données, stockage objet).

## 2. Principes

Conformément à l'invariant de sécurité 14 (Master Plan §6) :

1. Toute donnée conservée par ICOS est bornée par une politique de rétention explicite, versionnée et révisable par un humain habilité.
2. Aucune donnée n'est conservée « au cas où » sans finalité déterminée.
3. La politique de rétention est liée à la classification de la donnée (C0–C3).
4. La purge est tracée dans le journal d'audit (acteur, nombre d'entrées, politique appliquée).
5. Les durées sont révisables, mais toute extension est motivée et approuvée.

## 3. Durées de conservation par niveau de classification

| Niveau | Tag            | Durée de conservation maximale                        | Justification                                                 | Source               |
| ------ | -------------- | ----------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| **C0** | `public`       | Illimitée (dans le respect des droits d'auteur tiers) | Donnée publique sans risque.                                  | ICOS_INTERNAL_POLICY |
| **C1** | `internal`     | 5 ans après la dernière activité                      | Nécessité opérationnelle (traçabilité, historique de projet). | ICOS_INTERNAL_POLICY |
| **C2** | `confidential` | 3 ans après la dernière activité                      | Risque significatif en cas de fuite ; durée resserrée.        | ICOS_INTERNAL_POLICY |
| **C3** | `restricted`   | Durée strictement nécessaire à la finalité            | Conformité RGPD (minimisation, article 5.1.e) ; voir §3.1.    | LEGAL_OBLIGATION     |

### 3.1 Durées détaillées par type de donnée

| Type de donnée                        | Classification | Durée de conservation                                   | Base légale                          | Source                                       | Action à expiration                                         |
| ------------------------------------- | -------------- | ------------------------------------------------------- | ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------- |
| Comptes utilisateur (identité, email) | C3             | Durée du compte + 1 an après désactivation              | Exécution contractuelle (Art. 6.1.b) | LEGAL_OBLIGATION                             | Suppression physique (soft-delete → hard-delete après 1 an) |
| Sessions (token, expiration)          | C2             | Expiration de la session (7 j) + révocabilité immédiate | Obligation légale / sécurité         | LEGAL_OBLIGATION                             | Suppression à l'expiration ou à la révocation               |
| Hash de mot de passe                  | C2             | Durée du compte                                         | Obligation légale                    | LEGAL_OBLIGATION                             | Supprimé avec le compte                                     |
| Rôles et permissions humains          | C2             | Durée du compte                                         | Exécution contractuelle              | CONTRACT_DEPENDENT                           | Supprimés avec le compte                                    |
| Liens humain-agent                    | C2             | Durée du compte                                         | Exécution contractuelle              | CONTRACT_DEPENDENT                           | FK restrictive — supprimés avec le compte                   |
| Capacités et skills (registre)        | C1             | Durée de vie + 5 ans d'audit                            | Intérêt légitime (Art. 6.1.f)        | ICOS_INTERNAL_POLICY                         | Archivage après dépublication                               |
| Journal d'audit (Event Journal)       | C2             | 5 ans                                                   | Obligation légale (accountability)   | LEGAL_OBLIGATION                             | Purge après 5 ans (sauf contentieux)                        |
| Logs techniques (IP, routes)          | C2             | 90 jours maximum                                        | Intérêt légitime (sécurité)          | ICOS_INTERNAL_POLICY                         | Agrégation / anonymisation après 90 j                       |
| Logs d'erreur (stack traces)          | C1             | 30 jours                                                | Intérêt légitime (diagnostic)        | ICOS_INTERNAL_POLICY                         | Suppression après 30 j                                      |
| Logs fonctionnels nominatifs          | C3             | 12 mois                                                 | Intérêt légitime (Art. 6.1.f)        | PROPOSED_TO_VALIDATE                         | Anonymisation ou purge après 12 mois                        |
| Métriques comportementales            | C3             | 12 mois (anonymisables)                                 | Consentement (Art. 6.1.a)            | PROPOSED_TO_VALIDATE — LEGAL_REVIEW_REQUIRED | Anonymisation programmée à 12 mois (k > 5)                  |
| Données conversationnelles (mémoire)  | C3             | À définir dans Phase E                                  | Consentement ou contrat              | CONTRACT_DEPENDENT                           | Purge à définir (Phase E)                                   |
| Données intégrations (emails, docs)   | C3             | À définir dans Phase G                                  | Consentement ou contrat              | CONTRACT_DEPENDENT                           | Purge à définir (Phase G)                                   |

### 3.2 Données C3 — règle générale

Pour les données C3 sans entrée spécifique dans le tableau ci-dessus, la durée
est déterminée par la finalité et ne peut excéder le strict nécessaire.

À l'issue de la durée de conservation, les données C3 doivent être :

1. **anonymisées** (k > 5, ré-identification impossible) — auquel cas elles
   passent en C1 et peuvent être conservées selon les règles C1 ;
2. **ou détruites** de façon sécurisée (voir §5).

### 3.3 Sauvegardes

- Les sauvegardes (bases, volumes, objets) suivent la rétention la plus longue
  des données qu'elles contiennent.
- Pas de sauvegarde dédiée au-delà de 90 jours pour les données C3 : la
  restauration se fait depuis la source de vérité (base primaire).
- Durée maximale de conservation d'une sauvegarde : 90 jours.

### 3.4 Cycle de vie d'une donnée personnelle (C3)

```text
Création → Conservation active → (Désactivation) → Période de rétention
→ (Contentieux ? Gel → Résolution → Reprise) → Purge → Audit de purge
```

## 4. Règles de purge

### 4.1 Purge automatique (worker)

Un worker de purge (cron / scheduler) exécute les politiques de rétention.
Fréquence : quotidienne pour les purges courtes (logs 30 j), hebdomadaire pour
les purges longues (audit 5 ans).

Les données hors délai sont :

- marquées comme `eligible_for_purge` dans la base ;
- supprimées dans un délai de 7 jours ouvrés après ce marquage ;
- journalisées dans le registre d'audit (type `purge`, datée, volume,
  classification).

Chaque purge produit une entrée d'audit :

```text
acteur: system
type: data.retention_purge
détails: { policy: "logs_techniques_90j", entries: 42, table: "request_logs" }
```

### 4.2 Purge manuelle

Une purge manuelle peut être déclenchée par :

- un humain habilité (DPO, admin sécurité) ;
- une demande d'exercice de droit (RGPD Art. 17 — droit à l'effacement).

Dans les deux cas, l'action est :

- auditée ;
- confirmée par un second humain si le volume > 1 000 enregistrements ou si
  la donnée est C3 ;
- tracée dans le registre d'audit.

Une purge manuelle ne peut pas contourner les contraintes FK restrictives
(ex : supprimer un utilisateur sans traiter ses liens).

### 4.3 Conservation pour contentieux

En cas de contentieux connu, les données concernées sont gelées (limitation
du traitement, Art. 18 RGPD) jusqu'à résolution. La durée de rétention est
suspendue pendant le gel.

### 4.4 Dérogation

Une dérogation à une durée de conservation doit être :

- demandée par écrit (ticket, e-mail) avec motivation ;
- approuvée par le DPO désigné ;
- limitée dans le temps (prolongation max 1 an, renouvelable) ;
- tracée dans le registre d'audit.

Aucune dérogation n'est possible pour les données C3 au-delà de 5 ans sans
validation explicite du DPO et, si pertinent, consultation du juriste.

## 5. Méthodes de destruction

| Support                             | Méthode                                                                |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Base de données (lignes)            | `DELETE` logique + purge physique après 30 jours (soft delete window). |
| Stockage objet (fichiers, logs)     | Suppression avec confirmation de la couche de stockage.                |
| Sauvegardes (fichiers de dump)      | Suppression sécurisée (écrasement si support réutilisable).            |
| Cache (Redis, CDN)                  | Invalidation + `DEL`.                                                  |
| Logs applicatifs (stdout, fichiers) | Rotation et purge selon politique (max 90 jours).                      |

## 6. Responsabilités

| Rôle                        | Responsabilité                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------ |
| Développeur                 | Déclarer la durée de rétention pour toute nouvelle donnée C2+, appliquer les purges. |
| Architecte                  | Garantir que les infrastructures de stockage supportent les purges programmées.      |
| Administrateur / Exploitant | Configurer les rotations et purges (logs, sauvegardes).                              |
| Relecteur (PR)              | Vérifier que la classification et la rétention sont documentées.                     |
| DPO (désigné)               | Approuver les dérogations, valider les cycles de révision.                           |
| Propriétaire ICOS           | Approuver les extensions de durée de rétention.                                      |
| Révision annuelle           | Vérifier la conformité des durées, ajuster si nécessaire.                            |

## 7. Cycle de révision

- **Révision complète** : annuelle (ou lors d'un changement significatif de
  finalité, d'infrastructure ou de régulation).
- **Révision simplifiée** : lors de l'ajout d'une nouvelle finalité de
  traitement, pour valider la durée proposée avant implémentation.

## 8. Documents associés

- `docs/ICOS_MASTER_PLAN.md` — invariant 14 (§6) ;
- `01-classification.md` — classification C0–C3 ;
- `03-register.md` — registre des traitements ;
- `04-validation-gates.md` — points de validation.
