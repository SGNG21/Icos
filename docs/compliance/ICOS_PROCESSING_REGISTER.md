# ICOS — Registre des traitements (Art. 30 RGPD)

> **Document :** Registre initial des activités de traitement
> **Version :** 1.0
> **Date :** 2026-07-24
> **Statut :** accepté

## 1. Identité du responsable de traitement

| Champ | Valeur |
|---|---|
| **Nom** | ICOS / Polivia |
| **Représentant** | Geoffrey Nozza |
| **Email** | geoffrey.nozza@gmail.com |
| **Base juridique** | Établissement en France |

## 2. Traitements

### 2.1 Gestion des comptes utilisateur

| Champ | Valeur |
|---|---|
| **Finalité** | Création, authentification et gestion des comptes humains ICOS |
| **Base légale** | Exécution contractuelle (Art. 6.1.b) |
| **Catégories de données** | Identité (nom, email), identifiants de connexion, rôle, statut |
| **Personnes concernées** | Utilisateurs ICOS (humains) |
| **Durée de conservation** | Durée du compte + 1 an après désactivation |
| **Destinataires** | Aucun transfert externe |
| **Mesures techniques** | Chiffrement TLS, hachage scrypt (Better Auth), sessions révocables, accès par rôle |
| **Sous-traitants** | Hébergeur PostgreSQL (à déterminer) |

### 2.2 Administration des humains et rattachements

| Champ | Valeur |
|---|---|
| **Finalité** | Gestion des rôles, statuts et rattachements humains ↔ agents IA |
| **Base légale** | Exécution contractuelle (Art. 6.1.b) |
| **Catégories de données** | Identité (nom, email), rôle, statut, liens agent |
| **Personnes concernées** | Utilisateurs ICOS (humains) |
| **Durée de conservation** | Durée du compte + contrainte FK restrictive |
| **Destinataires** | Aucun transfert externe |
| **Mesures techniques** | Audit trail, politiques de hiérarchie, pas d'auto-administration |
| **Sous-traitants** | Hébergeur PostgreSQL (à déterminer) |

### 2.3 Registre de capacités

| Champ | Valeur |
|---|---|
| **Finalité** | Gestion des capacités et skills ICOS (vocabulaire technique) |
| **Base légale** | Intérêt légitime (Art. 6.1.f) — fonctionnement interne du système |
| **Catégories de données** | Aucune donnée personnelle — métadonnées techniques uniquement |
| **Personnes concernées** | N/A |
| **Durée de conservation** | Durée de vie de la capacité + historique d'audit |
| **Destinataires** | Aucun |
| **Mesures techniques** | Audit trail, contrôles d'accès |
| **Sous-traitants** | Hébergeur PostgreSQL (à déterminer) |

### 2.4 Journal d'audit (Event Journal)

| Champ | Valeur |
|---|---|
| **Finalité** | Traçabilité des actions sensibles pour sécurité et conformité |
| **Base légale** | Obligation légale (Art. 6.1.c) — accountability RGPD |
| **Catégories de données** | Identifiants internes (actorId, targetId), type d'action, horodatage — aucun contenu sensible |
| **Personnes concernées** | Utilisateurs ICOS (humains), agents IA (identifiants uniquement) |
| **Durée de conservation** | 5 ans (recommandation CNIL pour logs d'audit de sécurité) |
| **Destinataires** | Aucun transfert externe |
| **Mesures techniques** | Append-only, pas de secret/token dans les détails, FKs restrictives |
| **Sous-traitants** | Hébergeur PostgreSQL (à déterminer) |

### 2.5 Logs techniques et métriques

| Champ | Valeur |
|---|---|
| **Finalité** | Sécurité, diagnostic, performance du système |
| **Base légale** | Intérêt légitime (Art. 6.1.f) — sécurité du système |
| **Catégories de données** | Adresses IP (C2), timestamps, routes appelées — aucun contenu nominatif (pas d'email, nom, body de requête) |
| **Personnes concernées** | Visiteurs et utilisateurs ICOS |
| **Durée de conservation** | 90 jours (maximum, avant agrégation) |
| **Destinataires** | Aucun transfert externe |
| **Mesures techniques** | Pseudonymisation des IP, pas de logging des bodies, agrégation après 90 jours |
| **Sous-traitants** | Hébergeur infrastructure (à déterminer) |

## 3. Traitements futurs (à documenter lors de l'implémentation)

| Traitement | Lot | Données prévues |
|---|---|---|
| Mémoire conversationnelle | Phase E | Conversations, décisions, préférences |
| Intégration Gmail | Phase G | Emails, pièces jointes |
| Intégration Google Drive | Phase G | Documents, métadonnées |
| Intégration Dolibarr | Phase G | Clients, devis, factures |
| Orchestration IA externe | Phase D/G | Données envoyées à des providers IA |
| CRM prospects/clients | Phase H | Nom, email, téléphone, historique |

## 4. Révision

Ce registre est révisé à chaque nouveau traitement identifié et au minimum une
fois par an. Toute modification est horodatée et tracée (git log).
