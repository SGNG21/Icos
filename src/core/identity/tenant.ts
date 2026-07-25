/**
 * Shim transitoire d'identifiant tenant unique.
 *
 * ICOS est actuellement mono-tenant. Aucun TenantContext runtime n'existe
 * (ni sur la session, ni dans l'infrastructure d'auth).
 *
 * Les colonnes `tenant_id` sur les tables C2 (skills, scans, evals)
 * préparent l'isolation multi-tenant future. En attendant la résolution
 * canonique du tenant (COMPLIANCE-1), cette constante unique est utilisée
 * pour toutes les opérations.
 *
 * Temporary single-tenant compatibility shim.
 * Replace with canonical TenantContext in COMPLIANCE-1.
 */
export const CURRENT_SINGLE_TENANT_ID = "default";
