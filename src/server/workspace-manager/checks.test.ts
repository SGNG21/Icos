import { describe, expect, it } from "vitest";

import { scanSecrets } from "./checks";

const assigned = ["const db = ", '"postgres://', "app:", "s3cr3tpass", '@db.internal/x"'].join("");
const password = ["password", ": ", '"', "correct-horse-battery", '"'].join("");
const aws = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

describe("scanSecrets", () => {
  it("heuristiques : refusées dans le code, tolérées dans les fixtures de tests et la doc", () => {
    for (const line of [assigned, password]) {
      expect(scanSecrets([], [{ file: "src/x.ts", line }])).toHaveLength(1);
      expect(scanSecrets([], [{ file: "src/x.test.ts", line }])).toEqual([]);
      expect(scanSecrets([], [{ file: "README.md", line }])).toEqual([]);
    }
  });

  it("règles haute confiance : refusées partout, sans jamais renvoyer la valeur", () => {
    const findings = scanSecrets([], [{ file: "src/x.test.ts", line: `const k = "${aws}";` }]);
    expect(findings).toEqual([{ file: "src/x.test.ts", rule: "clé AWS" }]);
    expect(JSON.stringify(findings)).not.toContain(aws);
  });

  it("fichiers secrets par nom, sauf .env.example et suppressions", () => {
    const changed = (path: string, status = "A") => [{ status, path }];
    expect(scanSecrets(changed(".env.local"), [])).toHaveLength(1);
    expect(scanSecrets(changed("certs/server.pem"), [])).toHaveLength(1);
    expect(scanSecrets(changed(".env.example"), [])).toEqual([]);
    expect(scanSecrets(changed(".env.local", "D"), [])).toEqual([]);
  });
});
