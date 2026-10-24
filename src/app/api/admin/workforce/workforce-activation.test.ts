import { beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { BRAIN_IDS, BRAIN_ROLES } from "@/core/workforce/brains";
import { loadWorkforceBootstrap } from "@/core/workforce/bootstrap";
import { requiredRoleTests } from "@/core/workforce/role-composer";

/**
 * PHASE 3 — validation de bout en bout du mécanisme d'activation gouvernée (voir le plan,
 * section « MISSION — Activation gouvernée des 12 cerveaux »).
 *
 * Magasin EN MÉMOIRE (`buildMemoryContainer`, le même composant que les autres tests de
 * route de ce dépôt, ex. `src/app/api/goals/route.test.ts`) — jamais `icos_app`, jamais un
 * secret réel. Les primitives de gouvernance sous-jacentes (`certifyRole`, `activateRole`,
 * `createAgent`, `bootstrapWorkforce`) sont déjà prouvées par ailleurs
 * (`brain-seed.integration.test.ts`, `chief-delegation.test.ts`, `dispatch-bridge.
 * integration.test.ts` sur PostgreSQL réel) : ce fichier prouve que LES NOUVELLES ROUTES
 * s'y raccordent correctement — authentification, schémas, refus explicites, idempotence,
 * garde-fou anti-auto-certification — pas une seconde fois les primitives elles-mêmes.
 */

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";
const AUTHED = { origin: ORIGIN, cookie: COOKIE };

function install(role: Role | "anonymous" = "admin") {
  const session: AuthenticatedSession | null =
    role === "anonymous"
      ? null
      : {
          user: { id: "human-operator-1", email: "op@icos.test", name: "Op", status: "active" },
          roles: [role],
        };
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: async () => session,
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const base = buildMemoryContainer();
  const container: Container = { ...base, auth };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

async function call(
  modulePath: string,
  method: "GET" | "POST",
  path: string,
  options: {
    body?: unknown;
    params?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const mod = (await import(modulePath)) as Record<
    string,
    (req: Request, ctx?: unknown) => Promise<Response>
  >;
  const handler = mod[method];
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method === "POST" ? AUTHED : { cookie: AUTHED.cookie }),
      ...options.headers,
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return handler(request, options.params ? { params: Promise.resolve(options.params) } : undefined);
}

const bootstrap = loadWorkforceBootstrap();

async function seedBootstrapData() {
  return call("./bootstrap-data/seed/route", "POST", "/api/admin/workforce/bootstrap-data/seed");
}

async function certifyAll() {
  // AVERTISSEMENT — NE PAS REPRODUIRE EN PRODUCTION : `requiredRoleTests()` ici est réutilisé
  // comme `testsPassed` uniquement pour exercer la PLOMBERIE de la route dans ce test. Le
  // dossier Phase 1 (docs/acceptance/2026-10-23-brain-role-certification-dossier.md) établit
  // que ces identifiants sont des chaînes fixture SANS fichier de test correspondant — un
  // opérateur réel doit y substituer une preuve authentique (ex. les résultats de l'étape b
  // du plan du 2026-10-02 : `pnpm test`, `pnpm test:integration`, `pnpm certify:gateway`),
  // jamais la seule liste exigée renvoyée telle quelle (c'est exactement la tautologie que
  // `scripts/workforce-bootstrap.ts` commet déjà, documentée comme un défaut, pas un modèle).
  for (const { roleId, version } of BRAIN_ROLES) {
    const role = bootstrap.roles.find((r) => r.roleId === roleId && r.version === version)!;
    const testsPassed = requiredRoleTests(role, bootstrap.skills);
    const res = await call(
      "./roles/[roleId]/certify/route",
      "POST",
      `/api/admin/workforce/roles/${roleId}/certify`,
      { body: { version, testsPassed, evidenceRef: "test-suite-attestation" }, params: { roleId } },
    );
    expect(
      res.status,
      `certify ${roleId} failed: ${JSON.stringify(await res.clone().json())}`,
    ).toBe(200);
  }
}

async function activateAllRoles() {
  for (const { roleId, version } of BRAIN_ROLES) {
    const res = await call(
      "./roles/[roleId]/activate/route",
      "POST",
      `/api/admin/workforce/roles/${roleId}/activate`,
      { body: { version }, params: { roleId } },
    );
    expect(
      res.status,
      `activate ${roleId} failed: ${JSON.stringify(await res.clone().json())}`,
    ).toBe(200);
  }
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
});

describe("authentification et autorisation (échec fermé)", () => {
  it("401 sans session sur /status", async () => {
    install("anonymous");
    const res = await call("./status/route", "GET", "/api/admin/workforce/status");
    expect(res.status).toBe(401);
  });

  it("403 pour un viewer sur /brains/activate (pas agents.manage)", async () => {
    install("viewer");
    const res = await call(
      "./brains/activate/route",
      "POST",
      "/api/admin/workforce/brains/activate",
      {
        body: {},
      },
    );
    expect(res.status).toBe(403);
  });
});

describe("état initial — rien n'est fabriqué", () => {
  it("/status montre 0/12 cerveaux et aucun rôle bootstrapé avant toute action", async () => {
    install("admin");
    const res = await call("./status/route", "GET", "/api/admin/workforce/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.brains.registered).toBe(0);
    expect(body.brains.expected).toBe(BRAIN_IDS.length);
    expect(
      body.brainRoles.roles.every((r: { status: string }) => r.status === "not-bootstrapped"),
    ).toBe(true);
  });
});

describe("garde-fou anti-auto-certification du /brains/activate", () => {
  it("refuse d'activer les cerveaux tant que les 9 rôles ne sont pas certifiés+actifs", async () => {
    install("admin");
    await seedBootstrapData();
    const res = await call(
      "./brains/activate/route",
      "POST",
      "/api/admin/workforce/brains/activate",
      {
        body: {},
      },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("governance_denied");
    expect(body.error.details.notYetActive).toHaveLength(BRAIN_ROLES.length);
  });

  it("404 quand on certifie un rôle qui n'a pas encore été bootstrapé", async () => {
    install("admin");
    const res = await call(
      "./roles/[roleId]/certify/route",
      "POST",
      "/api/admin/workforce/roles/ICOS_CENTRAL/certify",
      {
        body: { version: "1.0.0", testsPassed: ["x"], evidenceRef: "r" },
        params: { roleId: "ICOS_CENTRAL" },
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("flux complet : bootstrap-data -> certify x9 -> activate x9 -> brains/activate", () => {
  it("prévisualise correctement avant d'écrire quoi que ce soit (dryRun)", async () => {
    install("admin");
    await seedBootstrapData();
    const dry = await call(
      "./brains/activate/route",
      "POST",
      "/api/admin/workforce/brains/activate?dryRun=true",
      { body: {} },
    );
    expect(dry.status).toBe(200);
    const dryBody = await dry.json();
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.rolesAllActive).toBe(false);
    expect(
      dryBody.brains.every((b: { alreadyPresent: boolean }) => b.alreadyPresent === false),
    ).toBe(true);
  });

  it("produit les 12 identités attendues, rattachées à leurs rôles certifiés, outillées", async () => {
    install("admin");
    await seedBootstrapData();
    await certifyAll();
    await activateAllRoles();

    const statusAfterRoles = await call("./status/route", "GET", "/api/admin/workforce/status");
    const statusBody = await statusAfterRoles.json();
    expect(
      statusBody.brainRoles.roles.every((r: { status: string }) => r.status === "active"),
    ).toBe(true);

    const dry = await call(
      "./brains/activate/route",
      "POST",
      "/api/admin/workforce/brains/activate?dryRun=true",
      { body: {} },
    );
    expect((await dry.json()).rolesAllActive).toBe(true);

    const real = await call(
      "./brains/activate/route",
      "POST",
      "/api/admin/workforce/brains/activate",
      {
        body: {},
      },
    );
    expect(real.status).toBe(200);
    const realBody = await real.json();
    expect(realBody.report.complete).toBe(true);
    expect(
      realBody.report.brains.results.filter((r: { outcome: string }) => r.outcome === "created"),
    ).toHaveLength(BRAIN_IDS.length);
    // L'octroi d'outils (`grantBrainTools`, 4e étage de `bootstrap()`) a réellement eu lieu :
    // aucun refus, et au moins un cerveau a effectivement reçu un ou plusieurs outils — pas
    // seulement « no-tools-needed » partout, ce qui masquerait une régression silencieuse.
    expect(
      realBody.report.grants.results.some((r: { outcome: string }) => r.outcome === "refused"),
    ).toBe(false);
    expect(
      realBody.report.grants.results.some(
        (r: { outcome: string; tools: string[] }) => r.outcome === "granted" && r.tools.length > 0,
      ),
    ).toBe(true);

    const finalStatus = await (
      await call("./status/route", "GET", "/api/admin/workforce/status")
    ).json();
    expect(finalStatus.brains.registered).toBe(BRAIN_IDS.length);
    const agentsWithTools = finalStatus.brains.agents.filter(
      (a: { toolGrants: string[] }) => a.toolGrants.length > 0,
    );
    expect(agentsWithTools.length).toBeGreaterThan(0);
    for (const agent of finalStatus.brains.agents) {
      expect(agent.status).toBe("active");
    }
  });

  it("est idempotent : un second passage complet ne crée aucun doublon", async () => {
    install("admin");
    await seedBootstrapData();
    await certifyAll();
    await activateAllRoles();
    await call("./brains/activate/route", "POST", "/api/admin/workforce/brains/activate", {
      body: {},
    });

    // Second pass : re-certifier/réactiver un rôle déjà `active` est refusé (NOT_DRAFT) par
    // `certifyRole`/`activateRole` eux-mêmes — exactement la garantie qu'ils offrent (jamais
    // de recertification silencieuse d'un état déjà gouverné). L'idempotence réellement
    // promise porte sur `bootstrap-data/seed` et `brains/activate`, rejoués ici tels quels.
    await seedBootstrapData();
    const second = await call(
      "./brains/activate/route",
      "POST",
      "/api/admin/workforce/brains/activate",
      {
        body: {},
      },
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(
      secondBody.report.brains.results.every(
        (r: { outcome: string }) => r.outcome === "already-present",
      ),
    ).toBe(true);

    const finalStatus = await (
      await call("./status/route", "GET", "/api/admin/workforce/status")
    ).json();
    expect(finalStatus.brains.registered).toBe(BRAIN_IDS.length); // still exactly 12, never duplicated
  });
});

/**
 * COUVERTURE DES REFUS HTTP — ajoutée suite à la revue de sécurité indépendante du
 * 2026-10-24 (agent `abb3b34bc4851d687`, verdict global « sûr pour IntegrationGate »,
 * finding MEDIUM Q10 : « les 3 autres routes d'écriture n'ont aucun test 401/403/CSRF/
 * MISSING_TESTS/NOT_CERTIFIED — la logique de gouvernance est prouvée ailleurs
 * [role-composer.test.ts], mais le câblage HTTP de ces routes pour les refus ne l'est
 * pas ». Ferme exactement ce point, sans retoucher aux routes elles-mêmes.
 */
describe("couverture des refus HTTP (finding Q10, revue 2026-10-24)", () => {
  const writeRoutes: { name: string; mod: string; path: string; params?: { roleId: string } }[] = [
    {
      name: "bootstrap-data/seed",
      mod: "./bootstrap-data/seed/route",
      path: "/api/admin/workforce/bootstrap-data/seed",
    },
    {
      name: "roles/[roleId]/certify",
      mod: "./roles/[roleId]/certify/route",
      path: "/api/admin/workforce/roles/ICOS_CENTRAL/certify",
      params: { roleId: "ICOS_CENTRAL" },
    },
    {
      name: "roles/[roleId]/activate",
      mod: "./roles/[roleId]/activate/route",
      path: "/api/admin/workforce/roles/ICOS_CENTRAL/activate",
      params: { roleId: "ICOS_CENTRAL" },
    },
    {
      name: "brains/activate",
      mod: "./brains/activate/route",
      path: "/api/admin/workforce/brains/activate",
    },
  ];

  for (const r of writeRoutes) {
    it(`401 sans session sur ${r.name}`, async () => {
      install("anonymous");
      const res = await call(r.mod, "POST", r.path, { body: {}, params: r.params });
      expect(res.status).toBe(401);
    });

    it(`403 pour un viewer (pas agents.manage) sur ${r.name}`, async () => {
      install("viewer");
      const res = await call(r.mod, "POST", r.path, { body: {}, params: r.params });
      expect(res.status).toBe(403);
    });

    it(`403 CSRF — origine croisée refusée avant toute lecture du corps sur ${r.name}`, async () => {
      install("admin");
      const res = await call(r.mod, "POST", r.path, {
        body: {},
        params: r.params,
        headers: { origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
    });

    it(`403 CSRF — en-tête Origin absent refusé sur ${r.name}`, async () => {
      install("admin");
      const headers: Record<string, string> = { "content-type": "application/json" };
      // `call()` ne permet pas de retirer `origin` par un header vide ; on construit la
      // requête directement pour ce seul cas, exactement comme le ferait un appelant qui
      // omet l'en-tête (navigateur non-CORS, script, replay) — `isSameOriginMutation`
      // doit fermer, pas juste la convention du test harness.
      const mod = (await import(r.mod)) as Record<
        string,
        (req: Request, ctx?: unknown) => Promise<Response>
      >;
      const request = new Request(`${ORIGIN}${r.path}`, {
        method: "POST",
        headers: { ...headers, cookie: COOKIE },
        body: JSON.stringify({}),
      });
      const res = await mod.POST(
        request,
        r.params ? { params: Promise.resolve(r.params) } : undefined,
      );
      expect(res.status).toBe(403);
    });
  }

  it("422 MISSING_TESTS — testsPassed vide ne certifie pas un rôle qui exige des tests", async () => {
    install("admin");
    await seedBootstrapData();
    const res = await call(
      "./roles/[roleId]/certify/route",
      "POST",
      "/api/admin/workforce/roles/ICOS_CENTRAL/certify",
      {
        body: { version: "1.0.0", testsPassed: [], evidenceRef: "r" },
        params: { roleId: "ICOS_CENTRAL" },
      },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("governance_denied");
    expect(body.error.details.violations).toContain("MISSING_TESTS");
  });

  it("422 NOT_CERTIFIED — activer un rôle encore draft (certify sautée) est refusé", async () => {
    install("admin");
    await seedBootstrapData();
    const res = await call(
      "./roles/[roleId]/activate/route",
      "POST",
      "/api/admin/workforce/roles/ICOS_CENTRAL/activate",
      { body: { version: "1.0.0" }, params: { roleId: "ICOS_CENTRAL" } },
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("governance_denied");
    expect(body.error.details.violations).toContain("NOT_CERTIFIED");
  });
});
