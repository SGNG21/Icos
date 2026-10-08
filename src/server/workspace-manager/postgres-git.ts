import { Git } from "./git";
import postgres from "postgres";

import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "@/server/database/test-database-guard";

/**
 * Le port `Git` du conteneur PostgreSQL.
 *
 * IL NE LANCE PAS GIT LUI-MÊME (ADR 0072, phase 0). Il redéfinissait `exec` sans le filtre
 * de verbes du port, sans options destructives refusées, sans code de sortie vérifié — et
 * c'est lui que la production utilise. Le garde de 0041 n'y était donc pas appliqué, et un
 * `git add`/`commit` passait sans que personne l'ait autorisé. Il redéfinissait aussi
 * `listDir`, `mergeConflicts` et `diffCheck` avec des commandes qui ne répondent pas à la
 * question posée (un `ls-tree` qui renvoie le dossier lui-même, un `merge-tree` à deux
 * arguments qui échoue en silence) : les contrôles de migration et de conflit du gate ne
 * voyaient rien. Tout est désormais hérité de `Git`, donc de l'autorité unique.
 */
export class PostgresGit extends Git {
  private readonly sql: postgres.Sql<Record<string, postgres.PostgresType>>;

  constructor(
    private readonly dbUrl: string = TEST_DATABASE_URL,
    repoDir: string = process.cwd(),
  ) {
    super(repoDir);
    const url = new URL(dbUrl);
    url.pathname = "/postgres";
    this.sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
