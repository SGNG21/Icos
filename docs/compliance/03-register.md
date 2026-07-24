# Registre des traitements — ICOS

| Statut    | Version |
|-----------|---------|
| Approuvé  | 1.0     |

## 1. Identité du responsable de traitement

| Champ | Valeur |
|---|---|
| **Nom** | ICOS |
| **Représentant** | Geoffrey Nozza |
| **Email** | geoffrey.nozza@gmail.com |
| **Base juridique** | Établissement en France |

## 2. Objectif

Tenir le registre des activités de traitement au sens de l'article 30 du RGPD
pour l'ensemble des traitements de données personnelles (C3) opérés par ICOS.

Ce registre est un document évolutif : toute nouvelle finalité, nouveau
traitement ou nouveau sous-traitant fait l'objet d'une mise à jour avant mise
en production.

## 3. Traitements

### T-01 : Compte utilisateur

| Champ                    | Valeur                                                                      |
|--------------------------|-----------------------------------------------------------------------------|
| Finalité                 | Gestion du compte ICOS (création, connexion, modification, suppression).    |
| Base légale              | Exécution du contrat d'utilisation (RGPD Art. 6.1.b).                      |
| Catégories de données    | C3 : nom, prénom, adresse e-mail, identifiant interne, préférences.        |
| Personnes concernées     | Utilisateurs d'ICOS (personnes physiques).                                  |
| Durée de conservation    | Durée du compte + 3 ans (voir `02-retention.md` §2.1).                     |
| Destinataires            | Aucun transfert externe (hébergement OVH/Scaleway, France).                |
| Transfert hors UE        | Aucun.                                                                      |
| Mesures de sécurité      | Chiffrement au repos (AES-256), chiffrement en transit (TLS 1.3), accès restreint au porteur du compte et aux administrateurs ICOS désignés. |
| Sous-traitant            | Hébergeur infra (à documenter dans le contrat de sous-traitance).          |

### T-02 : Logs d'authentification

| Champ                    | Valeur                                                                  |
|--------------------------|-------------------------------------------------------------------------|
| Finalité                 | Sécurité, détection d'intrusion, traçabilité des connexions.           |
| Base légale              | Obligation légale (sécurité des traitements, RGPD Art. 32).            |
| Catégories de données    | C3 : identifiant interne, horodatage, IP, user-agent, résultat (succès/échec). |
| Personnes concernées     | Utilisateurs d'ICOS.                                                    |
| Durée de conservation    | 90 jours glissants.                                                     |
| Destinataires            | Aucun transfert externe.                                                |
| Transfert hors UE        | Aucun.                                                                  |
| Mesures de sécurité      | Chiffrement au repos, accès restreint (admin sécurité + DPO).          |
| Sous-traitant            | Hébergeur infra.                                                        |

### T-03 : Logs fonctionnels (usage ICOS)

| Champ                    | Valeur                                                                |
|--------------------------|-----------------------------------------------------------------------|
| Finalité                 | Amélioration du service, analyse d'usage, diagnostic.                |
| Base légale              | Intérêt légitime (RGPD Art. 6.1.f).                                  |
| Catégories de données    | C3 : identifiant interne, session, actions, horodatage.              |
| Personnes concernées     | Utilisateurs d'ICOS.                                                  |
| Durée de conservation    | 12 mois.                                                              |
| Destinataires            | Aucun transfert externe.                                              |
| Transfert hors UE        | Aucun.                                                                |
| Mesures de sécurité      | Pseudonymisation (identifiant interne dissociable), accès restreint. |
| Sous-traitant            | Hébergeur infra.                                                      |

### T-04 : Métriques comportementales (projet)

| Champ                    | Valeur                                                                  |
|--------------------------|-------------------------------------------------------------------------|
| Finalité                 | Analyse des parcours, optimisation de l'expérience ICOS.               |
| Base légale              | Consentement (RGPD Art. 6.1.a) — recueilli lors de l'inscription.      |
| Catégories de données    | C3 : trajectoire de navigation, temps de réponse, fonctionnalités utilisées. |
| Personnes concernées     | Utilisateurs d'ICOS ayant consenti.                                     |
| Durée de conservation    | 12 mois (anonymisables).                                                |
| Destinataires            | Aucun transfert externe.                                                |
| Transfert hors UE        | Aucun.                                                                  |
| Mesures de sécurité      | Agrégation, anonymisation programmée à 12 mois (k > 5).                |
| Sous-traitant            | Hébergeur infra.                                                        |

### T-05 : Infra et sécurité (logs système)

| Champ                    | Valeur                                                                  |
|--------------------------|-------------------------------------------------------------------------|
| Finalité                 | Sécurité du système, détection d'incident, continuité d'activité.      |
| Base légale              | Obligation légale (sécurité, RGPD Art. 32).                            |
| Catégories de données    | C2 (aucune donnée personnelle directe).                                 |
| Personnes concernées     | S.O.                                                                    |
| Durée de conservation    | 90 jours (logs actifs) ; 1 an (logs archivés).                        |
| Destinataires            | Aucun transfert externe.                                                |
| Transfert hors UE        | Aucun.                                                                  |
| Mesures de sécurité      | Accès restreint (admin infra + sécurité).                              |
| Sous-traitant            | Hébergeur infra.                                                        |

## 4. Traitements futurs (à documenter lors de l'implémentation)

| Traitement                   | Lot       | Données prévues                                          |
|------------------------------|-----------|----------------------------------------------------------|
| Mémoire conversationnelle    | Phase E   | Conversations, décisions, préférences.                   |
| Intégration Gmail            | Phase G   | E-mails, pièces jointes.                                 |
| Intégration Google Drive     | Phase G   | Documents, métadonnées.                                  |
| Intégration Dolibarr         | Phase G   | Clients, devis, factures.                                |
| Orchestration IA externe     | Phase D/G | Données envoyées à des providers IA.                     |
| CRM prospects/clients        | Phase H   | Nom, e-mail, téléphone, historique commercial.           |

Toute nouvelle intégration fait l'objet d'une mise à jour de ce registre avant
déploiement, avec validation DPO.

## 5. Sous-traitants

| Sous-traitant         | Service                        | Localisation des données | Garanties                                              |
|-----------------------|--------------------------------|--------------------------|--------------------------------------------------------|
| Hébergeur infra (TBD) | Infrastructure (compute, storage, database) | France (SOF, OVH, Scaleway ou équivalent) | Clause contractuelle RGPD, DPA signé. Pas de transfert hors UE. |

Tout nouveau sous-traitant est ajouté avant la mise en production du service
concerné, avec DPA signé.

## 6. Droits des personnes

ICOS doit permettre l'exercice des droits RGPD suivants :

| Droit                      | Modalité                                                   |
|----------------------------|------------------------------------------------------------|
| Information (Art. 13-14)   | Présente dans les CGU et la documentation.                 |
| Accès (Art. 15)            | Portail utilisateur + réponse sous 30 jours.               |
| Rectification (Art. 16)    | Portail utilisateur.                                       |
| Effacement (Art. 17)       | Portail utilisateur + purge manuelle si nécessaire.        |
| Limitation (Art. 18)       | Sur demande motivée, gérée manuellement (DPO).             |
| Portabilité (Art. 20)      | Export JSON des données du compte.                         |
| Opposition (Art. 21)       | Traité par le DPO sous 30 jours.                           |

## 7. Cycle de mise à jour

- **Mise à jour obligatoire** avant tout nouveau traitement de données C3.
- **Révision annuelle** complète du registre.
- **Modification** d'un traitement existant : mise à jour de l'entrée avec
  historique des versions.

## 8. Documents associés

- `01-classification.md` — définition des niveaux C0–C3 ;
- `02-retention.md` — durées de conservation ;
- `04-validation-gates.md` — gate Compliance et points de validation DPO.
