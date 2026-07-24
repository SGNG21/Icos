# Base réglementaire — ICOS

| Statut    | Version |
|-----------|---------|
| Projet    | 0.1     |

## 1. Objectif

Définir le périmètre réglementaire applicable à ICOS à ce stade de développement,
et documenter les obligations qui en découlent pour chaque traitement.

## 2. Référentiels applicables

| Référentiel                         | Applicabilité                                                                 | Priorité |
|-------------------------------------|-------------------------------------------------------------------------------|----------|
| **RGPD (UE) 2016/679**              | Traitement de données personnelles de résidents UE — principal référentiel.   | Haute    |
| **ePrivacy Directive 2002/58/CE**   | Cookies, communications électroniques, suivi — pertinent si canal web.        | Moyenne  |
| **AI Act (UE) 2024/1689**           | Classification des systèmes d'IA — pertinent pour décisions automatisées.     | À évaluer |
| **Loi informatique et libertés**    | Déclinaison nationale du RGPD (France).                                       | Haute    |
| **NIS2 (UE) 2022/2555**             | Cybersécurité des infrastructures critiques — si ICOS devient critique.       | Veille   |

### 2.1 Référentiels exclus (à ce stade)

- **HIPAA** : non applicable (pas de données de santé américaines dans le périmètre ICOS).
- **CCPA/CPRA** : non applicable (pas de résidents californiens traités à ce stade).
- **LGPD** : non applicable (pas de résidents brésiliens traités à ce stade).
- **ISO 27001** : certification volontaire, hors scope produit.

## 3. Obligations par traitement

Voir `03-register.md` pour le détail de chaque traitement.

| Traitement | Base légale (RGPD Art. 6) | Obligations clés |
|---|---|---|
| Compte utilisateur | 6.1.b (contrat) | Information, accès, rectification, effacement |
| Logs d'authentification | 6.1.c (obligation légale, Art. 32) | Minimisation, durée bornée, sécurisation |
| Logs fonctionnels | 6.1.f (intérêt légitime) | Balancement, opposition possible |
| Métriques comportementales | 6.1.a (consentement) | Consentement explicite, retrait possible |

## 4. Documents associés

- `01-classification.md` — classification C0–C3 ;
- `02-retention.md` — durées de conservation ;
- `03-register.md` — registre des traitements.
