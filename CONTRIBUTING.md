# Contribuer à ICOS

## Flux local

1. Utiliser Node.js 24 et pnpm 11.10.0.
2. Créer une branche courte et ciblée.
3. Ne jamais ajouter de secret ; utiliser `.env.local`, ignoré par Git.
4. Ajouter ou adapter les tests avec le comportement modifié.
5. Exécuter `pnpm check` puis `pnpm build` avant toute revue.

Les commits suivent une convention descriptive, par exemple `feat: add approval policy`. Une pull
request doit expliquer le besoin, les risques, les contrôles exécutés et les migrations éventuelles.

Toute nouvelle intégration doit être désactivée par défaut, isolée derrière une interface et soumise
au modèle d'autorisation avant d'effectuer une action externe.
