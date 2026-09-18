import { userInfo } from "node:os";

/**
 * Garde fail-closed des tests : un test ne doit JAMAIS pouvoir se connecter à
 * la base live (`icos_n23_probe`) — les suites d'intégration font des
 * TRUNCATE/DELETE. La base doit être explicitement une base de test (jeton
 * `test` dans son nom) et ne contenir aucun jeton live/probe/prod.
 *
 * Appelé par `createDatabase` dès que `VITEST` est défini : aucun test ne
 * peut donc ouvrir une connexion vers une base non sûre, quel que soit le
 * fichier de test.
 */
export const TEST_DATABASE_URL =
  process.env.ICOS_TEST_DATABASE_URL ??
  `postgres://${userInfo().username}@localhost:5432/icos_test`;

const TEST_TOKEN = /(^|[_-])test($|[_-])/i;
const LIVE_TOKEN = /(probe|live|prod)/i;

export function assertSafeTestDatabaseUrl(url: string): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("TEST_DATABASE_UNSAFE: URL illisible");
  }
  if (!name || !TEST_TOKEN.test(name) || LIVE_TOKEN.test(name)) {
    throw new Error(
      `TEST_DATABASE_UNSAFE: la base "${name}" n'est pas une base de test (nom attendu ex. icos_test)`,
    );
  }
}
