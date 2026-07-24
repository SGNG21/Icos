# ICOS Privacy Architecture

| Statut   | Version |
|----------|---------|
| Projet   | 0.1     |

## 1. Objectif

Décrire l'architecture de protection de la vie privée (Privacy by Design —
art. 25 RGPD) qui gouverne la conception et l'évolution d'ICOS. Ce document
précise comment la classification des données, les invariants de sécurité et
les gates de conformité se traduisent en décisions architecturales concrètes.

## 2. Privacy by Design — principes appliqués

| Principe | Traduction ICOS |
|---|---|
| Proactif, non réactif | Invariant 14 : toute rétention est bornée dès la conception (voir §6 du Master Plan). |
| Protection par défaut | Les données sont classifiées au niveau le plus bas par défaut (C1). Le marquage C3 est explicite et audité. |
| Protection intégrée | Le registre de capacités (`CapabilityRegistry`) portera un champ `dataClassification` contraint par contrat (Phase B). |
| Fonctionnalité win-win | L'anonymisation (k > 5) fait passer C3 → C1, permettant l'analyse sans exposer les personnes. |
| Cycle de vie complet | Rétention bornée + purge documentée (voir politique de rétention). |
| Visibilité et transparence | Registre des traitements public dans l'organisation, revue annuelle. |
| Respect de l'utilisateur | L'utilisateur est propriétaire de ses données ; ICOS n'en est que le gardien. |

## 3. Architecture des flux de données

### 3.1 Classification par couche

| Couche ICOS | Classification typique | Protection |
|---|---|---|
| API publique (page d'accueil, docs) | C0 (public) | Aucune (publique par nature). |
| API authentifiée (profil, préférences) | C3 (restricted) | Auth req., transport TLS, stockage chiffré. |
| Configuration infras (secrets, tokens) | C2 (confidential) | Accès limité, jamais dans les logs. |
| Logs d'infrastructure (syslog, métriques) | C1 (internal) | Pas d'identifiants personnels, rétention bornée. |
| Logs d'audit (actions, acteurs) | C2/C3 (selon acteur) | Append-only, rétention bornée, pas de secrets. |
| Registre de capacités | C1 (internal) | Contrats techniques, pas de données personnelles. |

### 3.2 Flux nominatifs (C3)

Les flux impliquant des données C3 (e-mail, nom, préférences) doivent :

1. Transiter exclusivement en TLS (HTTPS, WSS).
2. Être stockés dans une table ou colonne marquée `@classification C3`.
3. Être accessibles uniquement via des routes authentifiées et autorisées.
4. Ne jamais apparaître dans les logs métier ou techniques (hors audit trail
   avec champ `actorId` et `targetId` sans valeur littérale sensible).
5. Être purgables individuellement (droit à l'effacement).

### 3.3 Flux vers des providers IA (futur)

Avant tout envoi de donnée C2/C3 vers un provider IA externe (via OmniRoute)
les conditions suivantes doivent être remplies :

1. Le contrat de sous-traitance (art. 28 RGPD) est signé avec le provider.
2. La classification `PrivacyClass` et `AllowedProviderClasses` est déclarée
   dans la politique de routage métier.
3. Aucun fallback vers une classe de provider non autorisée pour ce niveau.
4. L'utilisateur est informé (art. 13/14 RGPD).

Ces conditions seront vérifiées par la gate Compliance avant fusion des lots
D3/R1.

## 4. Chiffrement

| État | Standard |
|---|---|
| En transit | TLS 1.3 minimum pour toutes les connexions externes. Interne (inter-services) : TLS recommandé, réseau isolé en alternative documentée. |
| Au repos (C2/C3) | AES-256-GCM. Les colonnes marquées C3 sont chiffrées via mécanisme au niveau application ou stockage. |
| Clés | Gérées hors ICOS (secret store, vault), selon le principe de moindre privilège. ICOS ne stocke aucune clé de déchiffrement dans le code. |

## 5. Anonymisation et pseudonymisation

- **Anonymisation** (résultat irréversible, sort du champ RGPD) : agrégation
  avec k > 5, suppression des identifiants directs et indirects. Résultat
  classifié C1.
- **Pseudonymisation** (réversible avec clé séparée) : utilisée pour les logs
  d'audit où l'identifiant interne (`actorId`) est conservé mais dissocié des
  données personnelles littérales.

## 6. Notification de violation (art. 33/34)

Le processus de notification sera documenté dans un lot ultérieur (phase B).
Principe : notification CNIL sous 72h, notification des personnes concernées
sans délai injustifié si le risque est élevé.
