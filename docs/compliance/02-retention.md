# Politiques de rétention — ICOS

| Statut    | Version |
|-----------|---------|
| Projet    | 0.1     |

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

## 2. Durées de conservation

| Niveau | Tag             | Durée de conservation maximale                        | Justification                                                             |
|--------|-----------------|-------------------------------------------------------|---------------------------------------------------------------------------|
| **C0** | `public`        | Illimitée (dans le respect des droits d'auteur tiers) | Donnée publique sans risque.                                              |
| **C1** | `internal`      | 5 ans après la dernière activité                      | Nécessité opérationnelle (traçabilité, historique de projet).             |
| **C2** | `confidential`  | 3 ans après la dernière activité                      | Risque significatif en cas de fuite ; durée resserrée.                    |
| **C3** | `restricted`    | Durée strictement nécessaire à la finalité            | Conformité RGPD (minimisation, article 5.1.e) ; voir §2.1.                |

### 2.1 Données C3 (personnelles)

Pour les données C3, la durée de conservation est déterminée par la finalité :

| Finalité                     | Durée recommandée       | Déclencheur de purge                       |
|------------------------------|-------------------------|--------------------------------------------|
| Compte utilisateur actif     | Durée du compte + 3 ans | Clôture du compte ou 3 ans d'inactivité    |
| Logs d'accès (auth)          | 90 jours glissants      | Expiration du délai (rolling window)       |
| Logs fonctionnels nominatifs | 12 mois                 | Expiration du délai après collecte         |
| Préférences / configuration  | Durée du compte         | Suppression du compte                      |
| Métriques comportementales   | 12 mois (anonymisables) | Anonymisation ou purge après 12 mois       |

À l'issue de la durée de conservation, les données C3 doivent être :

1. **anonymisées** (k > 5, ré-identification impossible) — auquel cas elles
   passent en C1 et peuvent être conservées selon les règles C1 ;
2. **ou détruites** de façon sécurisée (voir §4).

### 2.2 Sauvegardes

- Les sauvegardes (bases, volumes, objets) suivent la rétention la plus longue
  des données qu'elles contiennent.
- Pas de sauvegarde dédiée au-delà de 90 jours pour les données C3 : la
  restauration se fait depuis la source de vérité (base primaire).
- Durée maximale de conservation d'une sauvegarde : 90 jours.

## 3. Règles de purge

### 3.1 Purge automatique

Tout traitement périodique ou batch doit inclure une étape de purge conforme à
cette politique. Les données hors délai sont :

- marquées comme `eligible_for_purge` dans la base ;
- supprimées dans un délai de 7 jours ouvrés après ce marquage ;
- journalisées dans le registre d'audit (type `purge`, datée, volume,
  classification).

### 3.2 Purge manuelle

Une purge manuelle peut être déclenchée par :

- un humain habilité (DPO, admin sécurité) ;
- une demande d'exercice de droit (RGPD Art. 17 — droit à l'effacement).

Dans les deux cas, l'action est :

- auditée ;
- confirmée par un second humain si le volume > 1 000 enregistrements ou si
  la donnée est C3 ;
- tracée dans le registre d'audit.

### 3.3 Dérogation

Une dérogation à une durée de conservation doit être :

- demandée par écrit (ticket, e-mail) avec motivation ;
- approuvée par le DPO désigné ;
- limitée dans le temps (prolongation max 1 an, renouvelable) ;
- tracée dans le registre d'audit.

Aucune dérogation n'est possible pour les données C3 au-delà de 5 ans sans
validation explicite du DPO et, si pertinent, consultation du juriste.

## 4. Méthodes de destruction

| Support                                    | Méthode                                                                 |
|--------------------------------------------|-------------------------------------------------------------------------|
| Base de données (lignes)                   | `DELETE` logique + purge physique après 30 jours (soft delete window).  |
| Stockage objet (fichiers, logs)            | Suppression avec confirmation de la couche de stockage.                 |
| Sauvegardes (fichiers de dump)             | Suppression sécurisée (écrasement si support réutilisable).             |
| Cache (Redis, CDN)                         | Invalidation + `DEL`.                                                   |
| Logs applicatifs (stdout, fichiers)        | Rotation et purge selon politique (max 90 jours).                      |

## 5. Responsabilités

| Rôle                        | Responsabilité                                                    |
|-----------------------------|-------------------------------------------------------------------|
| Développeur                 | Appliquer les durées de conservation dans le code (purge, soft delete). |
| Architecte                  | Garantir que les infrastructures de stockage supportent les purges programmées. |
| Administrateur / Exploitant | Configurer les rotations et purges (logs, sauvegardes).           |
| DPO (désigné)               | Approuver les dérogations, valider les cycles de révision.        |
| Révision annuelle           | Vérifier la conformité des durées, ajuster si nécessaire.         |

## 6. Cycle de révision

- **Révision complète** : annuelle (ou lors d'un changement significatif de
  finalité, d'infrastructure ou de régulation).
- **Révision simplifiée** : lors de l'ajout d'une nouvelle finalité de
  traitement, pour valider la durée proposée avant implémentation.

## 7. Documents associés

- `docs/ICOS_MASTER_PLAN.md` — invariant 14 (§6) ;
- `01-classification.md` — classification C0–C3 ;
- `03-register.md` — registre des traitements ;
- `04-validation-gates.md` — points de validation.
