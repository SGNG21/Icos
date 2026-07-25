/**
 * COMPLIANCE-1 : CURRENT_SINGLE_TENANT_ID supprimé.
 *
 * La résolution du tenant passe désormais par `TenantResolutionPort`
 * (`src/server/tenant/ports.ts`), implémenté par `SingleTenantResolver`
 * (`src/server/tenant/single-tenant-resolver.ts`).
 *
 * Le TenantId canonique "default" est encapsulé dans SingleTenantResolver
 * et n'est plus exporté comme constante globale.
 *
 * Utiliser `container.tenantResolver.resolve({ session })` pour obtenir
 * le TenantContext authentifié.
 */
