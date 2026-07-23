# Jalon : premier ICOS semi-autonome (M1)

> Ce jalon décrit le premier scénario métier complet qu'ICOS doit pouvoir exécuter de façon
> semi-autonome avant de construire les phases avancées (mémoire longue, omnicanal,
> self-improvement, etc.). Il correspond à l'entrée North Star du Master Plan (§1) en version
> restreinte : le scénario Dupont.

## 1. Scénario cible

**Entrée utilisateur** (naturelle, imparfaite) :

> « Regarde le dossier Dupont et prépare un devis pour lui. »

**Séquence attendue** (bout en bout, sans intervention humaine pendant la préparation) :

1. ICOS interprète l'intention : dossier existant, client Dupont, préparer devis.
2. ICOS consulte le dossier Dupont dans le système CRM ou fichier client (tool externe défini).
3. ICOS identifie les produits/services, prix, conditions, remises — soit en base ICOS si déjà
   présentes, soit en consultant une tool externe.
4. ICOS planifie le devis : structure, sections (identification, produits, prix, conditions).
5. ICOS prépare le devis (document structuré en base, pas encore envoyé).
6. ICOS produit un résumé : « Devis préparé, prêt pour vérification. Montant : X €. Veux-tu que je
   l'envoie ? »
7. L'utilisateur demande l'envoi : ICOS vérifie la policy → si envoi classé sensible (≥ niveau 2) →
   demande approbation humaine explicite.
8. L'utilisateur approuve : ICOS envoie le devis → enregistre l'exécution → audit complet.
9. L'utilisateur interrompt la session et revient le lendemain : « Continue le dossier Dupont. » →
   ICOS reprend exactement où il était.

## 2. Vérification par les tests comportementaux

| Étape | Test couvert |
|---|---|
| 1-3 | CAS 1 (préparation sans envoi) + CAS 13 (consigne vague) |
| 4-5 | CAS 1 (préparation) |
| 6 | CAS 1 (résultat non soumis) |
| 7 | CAS 2 + CAS 14 (envoi gouverné / refus) |
| 8 | CAS 2 (exécution unique + audit) |
| 9 | CAS 3 + CAS 11 (reprise après interruption / crash) |

Tests additionnels à faire passer dans le même contexte :

- CAS 6 : l'approbation expire avant que l'utilisateur ne la donne → refus d'envoi.
- CAS 7 : l'utilisateur annule la mission après approbation → pas d'exécution.
- CAS 9 : une skill non autorisée tente d'accéder au CRM → Policy Engine refuse.
- CAS 12 : « Où en est le devis Dupont ? » → réponse concise basée sur l'état réel en base.

## 3. Critères M1 (déclinaison des 12 critères du Master Plan §26)

| # | Critère (MP $26) | Exigence pour M1 |
|---|---|---|
| 1 | Comprendre la demande même imparfaite | F1 : intention "préparer devis" extraite d'une phrase naturelle |
| 2 | Retrouver le bon contexte | Dossier Dupont récupéré via D4 + G1 (premier connecteur) |
| 3 | Planifier le travail | D4 : Mission `préparer_devis` → Plan (étapes séquentielles) |
| 4 | Agir dans le périmètre autorisé | Précédé de la vérification policy |
| 5 | Demander validation si nécessaire | CAS 2 : envoi bloqué si niveau ≥ 2 |
| 6 | Vérifier le résultat | Post-exécution auditée |
| 7 | Continuer après interruption | CAS 3 : reprise documentée |
| 8 | Rester transparent | Résumé « Devis préparé, prêt envoi » |
| 9 | Ne pas déranger inutilement | Pas de questions inutiles (CAS 13) |
| 10 | Savoir refuser | CAS 14 : refus pour risque ; CAS 9 : tool non autorisé |
| 11 | Progresser de manière gouvernée | Policy Engine + D1/D4 |
| 12 | Offrir une expérience continue | CAS 3, CAS 11, CAS 12 |

**M1 est atteint quand :**
- l'utilisateur donne l'instruction naturelle ;
- ICOS exécute les étapes 1 à 8 sans intervention humaine sauf pour l'approbation d'envoi ;
- l'utilisateur revient le lendemain et obtient un état cohérent en une phrase.

## 4. État requis pour M1

| Composant | Statut M1 | Lot |
|---|---|---|
| Policy Engine v2 | Minimum : évaluation 5 niveaux, décision finale | D1 |
| Mission/Plan/Run | En base, stoppable, reprenable | D2 |
| AI Gateway Foundation | AiGatewayPort + requirements/policy métier minimale + OmniRouteAdapter ; aucun registre technique ICOS | D3 |
| Orchestrateur v1 | Décomposition, planification, résolution skill | D4 |
| Memory/Context Port | Provenance minimale (identité du dossier) | E1 (mini) |
| Contrat conversationnel | Extraction intention + clarification minimale | F1 (mini) |
| Tool/MCP Gateway | Premier connecteur : consultation CRM — send devis | G1 + G2 |
| Premier connecteur métier | Consultation CRM et envoi devis | G2 |
| Behavioral tests | CAS 1-14 passants | Q1 |
| **Pas requis** | Mémoire longue, évolution skills, multi-fournisseur, omnicanal | Différable |

## 5. Ce que M1 n'est pas

- M1 n'est pas un système multi-agent complet. Un seul agent orchestrateur principal.
- M1 n'exploite pas encore de policy business multi-provider avancée. OmniRoute peut techniquement
  router, mais ICOS n'exprime dans D3 que les contraintes minimales nécessaires.
- M1 n'est pas proactif ICOS (pas de heartbeat, pas de réévaluation périodique).
- M1 n'est pas mémoire long terme sophistiquée. Le contexte est chargé directement depuis la source.
- M1 n'est pas omnichannel. Cockpit web uniquement.
- M1 n'est pas auto-apprenant, self-improvement ou capable de Skill Discovery from Traces.

## 6. Après M1 : premières extensions

Le lot immédiatement après M1 est **R1 — AI Business Routing Policy & Usage Ledger**, suivi de
**P1 — Proactivity Engine**. R1 qualifie coûts, abonnements, budgets et restrictions métier, puis
transmet ces contraintes à OmniRoute ; il ne construit pas de routeur technique.

## 7. Interaction de l'utilisateur avec M1

```
User : "Regarde le dossier Dupont et prépare un devis pour lui."

ICOS : "Dossier Dupont trouvé — 3 produits : A, B, C.
Devis préparé (montant : X €).
Tu veux que je l'envoie ?"

User : "Oui, envoie."

ICOS : "Action classée sensible — j'ai besoin de ta confirmation explicite.
Approuves-tu l'envoi du devis Dupont (X €) ?"

User : "Oui, j'approuve."

ICOS : "Devis envoyé à Dupont le 23/07/2026 à 15h30.
Audit enregistré. Mission terminée."
```
