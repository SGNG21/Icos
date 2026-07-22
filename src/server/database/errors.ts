/**
 * Erreur levée lorsqu'une ligne SQL ne satisfait pas le contrat Zod attendu au
 * moment du mapping (jamais un retour silencieux). Le message reste non
 * sensible : il n'inclut pas les valeurs de la ligne.
 */
export class RepositoryMappingError extends Error {
  readonly code = "repository_mapping_error" as const;
  constructor(entity: string, details: string) {
    super(`Ligne ${entity} invalide au mapping : ${details}`);
    this.name = "RepositoryMappingError";
  }
}
