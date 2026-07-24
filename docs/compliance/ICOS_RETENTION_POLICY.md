# ICOS — Politique de rétention des données

> **Document :** Politique de conservation, d'archivage et de purge
> **Version :** 1.0
> **Date :** 2026-07-24
> **Statut :** accepté

## 1. Principes

Conformément à l'invariant de sécurité 14 (Master Plan §6) :

1. Toute donnée conservée par ICOS est bornée par une politique de rétention
   explicite, versionnée et révisable par un humain habilité.
2. Aucune donnée n'est conservée « au cas où » sans finalité déterminée.
3. La politique de rétention est liée à la classification de la donnée (C0–C4).
4. La purge est tracée dans le journal d'audit (acteur, nombre d'entrées,
   politique appliquée).
5. Les durées sont révisables, mais toute extension est motivée et approuvée.

## 2. Tableau des durées de conservation

| Type de donnée | Classification | Durée de conservation | Base légale | Action à expiration |
|---|---|---|---|---|
| Comptes utilisateur (identité, email, nom) | C3 | Durée du compte + 1 an après désactivation | Exécution contractuelle | Suppression physique (soft-delete → hard-delete après 1 an) |
| Sessions (token, expiration) | C2/C4 | Expiration de la session (7 j) + révocabilité immédiate | Obligation légale / sécurité | Suppression à l'expiration ou à la révocation |
| Hash de mot de passe | C4 | Durée du compte | Obligation légale | Supprimé avec le compte |
| Rôles et permissions humains | C2 | Durée du compte | Exécution contractuelle | Supprimés avec le compte |
| Liens humain-agent | C2 | Durée du compte | Exécution contractuelle | FK restrictive — supprimés avec le compte |
| Capacités et skills (registre) | C1 | Durée de vie + 5 ans d'audit | Intérêt légitime | Archivage après dépublication |
| Journal d'audit (Event Journal) | C2 | 5 ans | Obligation légale (accountability) | Purge après 5 ans (sauf si requis par contentieux) |
| Logs techniques (IP, routes) | C2 | 90 jours maximum | Intérêt légitime (sécurité) | Agrégation/anonymisation après 90 j |
| Logs d'erreur (stack traces) | C1 | 30 jours | Intérêt légitime (diagnostic) | Suppression après 30 j |
| Données conversationnelles (mémoire) | C3 | À définir dans Phase E | Consentement ou contrat | Purge à définir (Phase E) |
| Données intégrations (emails, docs) | C3 | À définir dans Phase G | Consentement ou contrat | Purge à définir (Phase G) |

## 3. Règles de purge

### 3.1 Purge automatique (worker)

- Un worker de purge (cron / scheduler) exécute les politiques de rétention
  selon le tableau ci-dessus.
- Fréquence : quotidienne pour les purges courtes (logs 30 j), hebdomadaire
  pour les purges longues (audit 5 ans).
- Chaque purge produit une entrée d'audit :

```text
acteur: system
type: data.retention_purge
détails: { policy: "logs_techniques_90j", entries: 42, table: "request_logs" }
```

### 3.2 Purge manuelle (humain habilité)

- Un humain habilité (owner, admin, DPO) peut déclencher une purge anticipée.
- La purge manuelle est également auditée.
- Une purge manuelle ne peut pas contourner les contraintes FK restrictives
  (ex : supprimer un utilisateur sans traiter ses liens).

### 3.3 Conservation pour contentieux

- En cas de contentieux connu, les données concernées sont gelées (limitation
  du traitement, Art. 18 RGPD) jusqu'à résolution.
- La durée de rétention est suspendue pendant le gel.

## 4. Cycle de vie d'une donnée personnelle (C3)

```text
Création → Conservation active → (Désactivation) → Période de rétention
→ (Contentieux ? Gel → Résolution → Reprise) → Purge → Audit de purge
```

## 5. Responsabilités

| Rôle | Responsabilité |
|---|---|
| Développeur | Déclarer la durée de rétention pour toute nouvelle donnée C2+ |
| Relecteur (PR) | Vérifier que la classification et la rétention sont documentées |
| Propriétaire ICOS | Approuver les extensions de durée de rétention |
| DPO (désigné) | Réviser annuellement la politique et proposer des ajustements |

## 6. Révision

Cette politique est révisée annuellement et lors de tout changement significatif
dans les traitements ICOS ou le cadre réglementaire.
