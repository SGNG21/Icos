# Points de validation DPO et gate Compliance — ICOS

| Statut    | Version |
|-----------|---------|
| Projet    | 0.1     |

## 1. Objectif

Définir les procédures de contrôle de conformité applicables au développement
d'ICOS : la **gate Compliance** en revue de PR, les **points de validation
DPO/juriste**, et les critères de déclenchement de chaque niveau de contrôle.

## 2. Gate Compliance (PR)

### 2.1 Déclenchement

La gate Compliance s'applique à toute PR touchant **la collecte, la
conservation, la classification ou le transfert de données personnelles ou
sensibles** (C3 au sens de `01-classification.md`), en complément de la
validation technique standard (voir `docs/ICOS_MASTER_PLAN.md` §18).

Indicateurs de déclenchement :

- nouveau champ stocké contenant une donnée C3 ;
- modification d'une durée de conservation ;
- ajout d'une finalité de traitement ;
- intégration d'un nouveau sous-traitant ou d'une API externe manipulant
  des données C3 ;
- changement de classification d'une donnée (C2 → C3 ou C3 → C2) ;
- nouvelle fonctionnalité collectant des données utilisateur.

### 2.2 Procédure

1. **L'auteur de la PR** :
   - ajoute le label `needs:compliance-review` ;
   - remplit la checklist de conformité dans la description de la PR (voir
     §2.3).

2. **Le relecteur technique** vérifie que le marquage de classification
   (`01-classification.md` §3) est présent et correct, puis transmet au DPO.

3. **Le DPO (désigné)** :
   - valide que la classification est correcte ;
   - vérifie que la durée de conservation est documentée et conforme
     (`02-retention.md`) ;
   - s'assure que le traitement est inscrit ou modifié dans le registre
     (`03-register.md`) ;
   - approuve ou demande des modifications dans la PR.

4. **Aucune fusion** sans approbation du DPO dans la PR.

### 2.3 Checklist de conformité (description de PR)

```markdown
### Checklist conformité

- [ ] Classification des données concernées : ___
- [ ] Durée de conservation définie et justifiée
- [ ] Traitement inscrit dans le registre (03-register.md)
- [ ] Base légale identifiée (RGPD Art. 6)
- [ ] Marquage `@classification` présent dans le schéma
- [ ] Pas de transfert hors UE sans DPA
- [ ] DPO notifié (label `needs:compliance-review`)
```

### 2.4 Réponse

- **Approbation** : le DPO approuve la PR avec un commentaire motivé.
- **Refus** : la PR est marquée `changes-requested` avec les motifs de
  non-conformité et les actions correctives attendues.
- **Suspension** : en cas de doute sur la qualification juridique, le DPO
  consulte le juriste avant de statuer (voir §3).

## 3. Points de validation DPO/juriste

### 3.1 Validation DPO

Requis pour :

- tout nouveau traitement de données C3 ;
- toute modification substantielle d'un traitement existant (finalité,
  durée, catégories) ;
- toute dérogation à une durée de conservation (voir `02-retention.md` §3.3) ;
- tout transfert de données hors UE.

### 3.2 Consultation juriste

Requis, après avis du DPO, pour :

- données relevant des catégories spéciales de l'article 9 RGPD (santé,
  biométrie, opinions, etc.) — **exclues du périmètre actuel d'ICOS** ;
- transfert hors UE sans décision d'adéquation, nécessitant des garanties
  appropriées (CCT, RUE, etc.) ;
- incident de sécurité impliquant des données C3 (notification CNIL,
  communication aux personnes) ;
- nouvelle régulation applicable (évolution RGPD, AI Act, etc.) avec impact
  sur le périmètre d'ICOS.

### 3.3 DPO désigné

Le DPO est une personne physique désignée par l'organisation ICOS. Tant que
l'organisation n'a pas de DPO formel, ce rôle est assuré par l'humain
propriétaire du projet.

> **Statut :** PLANNED — e-mail dédié conformité à créer avant la première gate Compliance
> réelle (PR avec données C3). Ceci est un prérequis opérationnel de COMPLIANCE-0.

## 4. Cycle de validation

| Événement                                 | Contrôle requis                  | Délai max     |
|-------------------------------------------|----------------------------------|---------------|
| PR avec données C3                        | Gate Compliance (DPO)            | 5 jours ouvrés |
| Nouveau traitement C3                     | Validation DPO                   | 10 jours ouvrés |
| Dérogation durée de conservation          | Validation DPO                   | 5 jours ouvrés |
| Incident C3                               | DPO + juriste si nécessaire      | 72h (notification) |
| Révision annuelle conformité              | DPO + juriste                    | —             |

## 5. Documents associés

- `docs/ICOS_MASTER_PLAN.md` §18 — gate Compliance en revue de PR ;
- `01-classification.md` — classification C0–C3 ;
- `02-retention.md` — politiques de rétention ;
- `03-register.md` — registre des traitements ;
- `docs/ICOS_MASTER_PLAN.md` §29 — discipline documentaire.
