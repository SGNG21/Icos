# ICOS Regulatory Baseline

| Statut   | Version |
|----------|---------|
| Projet   | 0.1     |

## 1. Objectif

Établir le référentiel réglementaire applicable à ICOS. Ce document est la
source de vérité des obligations légales auxquelles le système doit se
conformer. Toute politique de rétention, gate de conformité ou décision
d'architecture s'y réfère.

## 2. Périmètre géographique et matériel

ICOS est développé et exploité depuis la France. Le périmètre réglementaire
couvre à ce stade :

- **RGPD** (Règlement UE 2016/679) — traitement de données personnelles de
  personnes physiques situées dans l'UE.
- **Loi Informatique et Libertés** (Loi 78-17 modifiée) — transposition
  française du RGPD, dispositions nationales (CNIL).
- **ePrivacy Directive** (2002/58/CE, transposée) — cookies, communications
  électroniques, pour tout futur canal agent↔utilisateur.

Les législations suivantes sont **hors périmètre** pour COMPLIANCE-0 et
seront couvertes dans des lots ultérieurs :

- DMA / DSA (applicable si ICOS devient une plateforme désignée).
- AI Act (applicable si un composant ICOS est classé à haut risque ; évalué
  dans COMPLIANCE-3).
- Lois extra-UE (CCPA, LGPD, etc.) — applicables si un utilisateur ou client
  s'y trouve ; évalué au cas par cas.

## 3. Principes fondateurs

| Principe RGPD | Application ICOS |
|---|---|
| Licéité, loyauté, transparence — art. 5(1)(a) | Chaque traitement est associé à une base légale documentée dans le registre. |
| Limitation des finalités — art. 5(1)(b) | Une capacité ICOS ne traite que les données nécessaires à sa finalité déclarée. |
| Minimisation — art. 5(1)(c) | Aucune collecte sans finalité ; pas de collecte préventive. |
| Exactitude — art. 5(1)(d) | L'utilisateur peut corriger ses données via l'API utilisateur. |
| Limitation de conservation — art. 5(1)(e) | Voir politique de rétention (`ICOS_RETENTION_POLICY.md`). |
| Intégrité et confidentialité — art. 5(1)(f) | Chiffrement au repos et en transit dès C2/C3. |
| Accountability — art. 5(2) | Registre des traitements, audit trail, revue annuelle. |

## 4. Bases légales applicables

| Base légale | Cas d'usage ICOS |
|---|---|
| Exécution contractuelle — art. 6(1)(b) | Gestion des utilisateurs, notifications liées au service. |
| Obligation légale — art. 6(1)(c) | Conservation des logs d'audit, registre des traitements. |
| Intérêt légitime — art. 6(1)(f) | Sécurité du système, détection d'incidents, statistiques internes anonymisées. |
| Consentement — art. 6(1)(a), 7 | Fonctionnalités optionnelles (recommandations, profiling agent) — à implémenter en phase B. |

## 5. Droits des personnes concernées

ICOS doit permettre l'exercice des droits suivants avant tout traitement de
données réelles :

| Droit | Implémentation prévue |
|---|---|
| Droit d'accès — art. 15 | API utilisateur : lire ses propres données. |
| Droit de rectification — art. 16 | API utilisateur : modifier son profil. |
| Droit à l'effacement — art. 17 | API utilisateur + workflow de suppression (rétention respectée). |
| Droit à la limitation — art. 18 | Geler un traitement sur demande (workflow dédié, à implémenter en phase B). |
| Droit d'opposition — art. 21 | Désactiver une capacité ou un traitement (phase B). |
| Portabilité — art. 20 | Export JSON de ses données (phase C). |

## 6. Registre des traitements

Voir le document séparé :
[`docs/compliance/ICOS_PROCESSING_REGISTER.md`](ICOS_PROCESSING_REGISTER.md).

## 7. Révision

Ce document est révisé annuellement et lors de tout changement significatif
dans le périmètre réglementaire ou les traitements ICOS.
