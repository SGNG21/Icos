import { describe, expect, it } from "vitest";

import {
  childEnvironment,
  DEFAULT_CHILD_ENV_ALLOWLIST,
  parseEnvPassthrough,
} from "./child-environment";

/**
 * ISOLATION DES SECRETS À LA FRONTIÈRE D'EXÉCUTION (verrou C8).
 *
 * Avant, `runNonInteractive` passait `process.env` ENTIER à chaque worker externe — et le
 * fichier l'écrivait noir sur blanc : « the child can see this process's secrets ». Tout
 * agent CLI lancé par ICOS pouvait donc lire `DATABASE_URL` et parler à la base de
 * production. Ces preuves portent sur ce qui traverse, et surtout sur ce qui ne traverse pas.
 */

/** Un environnement parent réaliste : de la plateforme, et beaucoup de secrets. */
const parent = {
  PATH: "/usr/bin",
  HOME: "/home/icos",
  LANG: "fr_FR.UTF-8",
  DATABASE_URL: "postgres://user:motdepasse@host/base",
  OMNIROUTE_API_KEY: "sk-secret",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  BETTER_AUTH_SECRET: "cookie-secret",
  ICOS_OWNER_PASSWORD: "motdepasse",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
} as unknown as NodeJS.ProcessEnv;

describe("childEnvironment — liste blanche, fermée par défaut", () => {
  it("ne transmet AUCUN secret du parent", () => {
    const env = childEnvironment({ parent });
    for (const secret of [
      "DATABASE_URL",
      "OMNIROUTE_API_KEY",
      "ANTHROPIC_API_KEY",
      "BETTER_AUTH_SECRET",
      "ICOS_OWNER_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(env[secret], secret).toBeUndefined();
    }
    /* Et aucune de leurs VALEURS ne fuit sous un autre nom. */
    expect(Object.values(env).join("|")).not.toMatch(/secret|motdepasse/i);
  });

  it("transmet ce dont un vrai worker a besoin pour démarrer", () => {
    const env = childEnvironment({ parent });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/icos");
    expect(env.LANG).toBe("fr_FR.UTF-8");
  });

  it("une variable INCONNUE est traitée comme un secret : elle ne passe pas", () => {
    /*
     * Le sens du défaut. Une liste noire devrait connaître le nom de chaque secret et
     * serait fausse dès la prochaine variable ajoutée ; une liste blanche échoue dans
     * l'autre sens, visiblement, et se corrige par configuration.
     */
    const env = childEnvironment({ parent: { ...parent, UNE_NOUVELLE_CLE: "valeur" } });
    expect(env.UNE_NOUVELLE_CLE).toBeUndefined();
  });

  it("le déploiement peut OUVRIR une variable nommément, et seulement celle-là", () => {
    const env = childEnvironment({ parent, passthrough: ["ANTHROPIC_API_KEY"] });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("la superposition de l'appelant gagne : c'est un choix explicite", () => {
    const env = childEnvironment({ parent, overlay: { PATH: "/opt/bin", EXTRA: "x" } });
    expect(env.PATH).toBe("/opt/bin");
    expect(env.EXTRA).toBe("x");
  });

  it("une variable absente du parent reste ABSENTE, jamais une chaîne vide", () => {
    const env = childEnvironment({ parent: { PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv });
    expect("HOME" in env).toBe(false);
  });

  it("la liste blanche ne contient aucun nom qui ressemble à un secret", () => {
    /* Garde-fou sur la liste elle-même : on ne veut pas qu'elle dérive. */
    for (const name of DEFAULT_CHILD_ENV_ALLOWLIST) {
      expect(name, name).not.toMatch(/key|secret|token|password|credential|url/i);
    }
  });

  it("`passthrough: []` est le mode le plus strict, et reste exprimable", () => {
    const env = childEnvironment({ parent, passthrough: [] });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.OMNIROUTE_API_KEY).toBeUndefined();
  });
});

describe("parseEnvPassthrough", () => {
  it("lit une liste séparée par des virgules, sans doublon ni blanc", () => {
    expect(parseEnvPassthrough(" A , B ,, A , ")).toEqual(["A", "B"]);
  });

  it("absent ou vide n'ouvre rien", () => {
    expect(parseEnvPassthrough(undefined)).toEqual([]);
    expect(parseEnvPassthrough("")).toEqual([]);
    expect(parseEnvPassthrough("  ")).toEqual([]);
  });
});
