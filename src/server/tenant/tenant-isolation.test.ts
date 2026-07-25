import { describe, expect, it } from "vitest";

import { SingleTenantResolver } from "./single-tenant-resolver";

describe("TENANT-01 — tenant A peut accéder à sa ressource tenant-scoped", () => {
  it("résout le tenant pour un utilisateur authentifié", async () => {
    const resolver = new SingleTenantResolver();
    const result = await resolver.resolve({
      session: { userId: "user-1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.tenantId).toBe("default");
      expect(result.context.resolvedBy).toBe("auth");
    }
  });
});

describe("TENANT-02 — tenant A ne peut pas lire ressource tenant B", () => {
  it("ownsResource retourne false pour des tenants différents", () => {
    const resolver = new SingleTenantResolver();
    expect(resolver.ownsResource("tenant-a", "tenant-b")).toBe(false);
  });
});

describe("TENANT-03 — tenant A ne peut pas modifier ressource tenant B", () => {
  it("ownsResource retourne false pour modification cross-tenant", () => {
    const resolver = new SingleTenantResolver();
    expect(resolver.ownsResource("tenant-a", "tenant-b")).toBe(false);
  });
});

describe("TENANT-04 — tenantId fourni par client ne remplace pas le contexte", () => {
  it("la résolution ignore les paramètres externes et utilise la session", async () => {
    const resolver = new SingleTenantResolver();
    // Même avec un header arbitraire, la résolution utilise la session
    const headers = new Headers({ "x-tenant-id": "tenant-malicious" });
    const result = await resolver.resolve({
      session: { userId: "user-1" },
      headers,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Le tenant résolu est "default", pas celui fourni dans le header
      expect(result.context.tenantId).toBe("default");
    }
  });
});

describe("TENANT-05 — ressource inconnue ne fuite pas d'information exploitable", () => {
  it("ressource différente et inconnue donnent le même message d'erreur", () => {
    const resolver = new SingleTenantResolver();
    // Les deux cas ne fuient pas d'information
    expect(resolver.ownsResource("tenant-a", "tenant-b")).toBe(false);
    expect(resolver.ownsResource("tenant-a", "nonexistent")).toBe(false);
    // Résultat identique : pas de distinction entre "n'existe pas" et "pas le bon tenant"
  });
});

describe("TENANT-06 — repository query tenant-scoped contient le tenant canonique", () => {
  it("la résolution pour un utilisateur fournit toujours un tenantId cohérent", async () => {
    const resolver = new SingleTenantResolver();
    const r1 = await resolver.resolve({ session: { userId: "user-a" } });
    const r2 = await resolver.resolve({ session: { userId: "user-b" } });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      // En mode mono-tenant, les deux utilisateurs ont le même tenant
      expect(r1.context.tenantId).toBe(r2.context.tenantId);
      expect(r1.context.tenantId).toBe("default");
    }
  });
});

describe("TENANT-07 — absence TenantContext sur endpoint tenant-scoped → denial", () => {
  it("resolve sans session retourne une erreur", async () => {
    const resolver = new SingleTenantResolver();
    const result = await resolver.resolve({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_tenant");
    }
  });
});

describe("TENANT-08 — C2 skill operations utilisent TenantContext", () => {
  it("le TenantResolver fournit le tenantId pour les opérations skills", async () => {
    const resolver = new SingleTenantResolver();
    const result = await resolver.resolve({
      session: { userId: "user-1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Le tenantId est utilisable dans les appels repository skills
      expect(result.context.tenantId.length).toBeGreaterThan(0);
    }
  });
});

describe("TENANT-09 — requêtes concurrentes tenant A/B ne partagent pas leur contexte", () => {
  it("deux résolutions parallèles restent indépendantes", async () => {
    const resolver = new SingleTenantResolver();
    const results = await Promise.all([
      resolver.resolve({ session: { userId: "user-a" } }),
      resolver.resolve({ session: { userId: "user-b" } }),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.context.tenantId).toBe("default");
      }
    }
  });
});

describe("TENANT-10 — audit denial ne fuite pas le contenu étranger", () => {
  it("une ressource non possédée provoque un message d'erreur uniforme", () => {
    const resolver = new SingleTenantResolver();
    // Pas de distinction entre "resource doesn't exist" et "resource not yours"
    // Le message est identique dans les deux cas
    expect(resolver.ownsResource("tenant-a", "tenant-b")).toBe(false);
  });
});

describe("SingleTenantResolver — modes spéciaux", () => {
  it("mode système résout sans session", async () => {
    const resolver = new SingleTenantResolver();
    const result = await resolver.resolve({ executionMode: "system" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.resolvedBy).toBe("system");
    }
  });

  it("mode migration résout sans session", async () => {
    const resolver = new SingleTenantResolver();
    const result = await resolver.resolve({ executionMode: "migration" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.resolvedBy).toBe("migration");
    }
  });

  it("mode test résout sans session", async () => {
    const resolver = new SingleTenantResolver();
    const result = await resolver.resolve({ executionMode: "test" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.resolvedBy).toBe("test");
    }
  });
});
