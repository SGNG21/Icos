import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Temporary single-tenant compatibility shim.
// Replace with canonical TenantContext in COMPLIANCE-1.
const TENANT_ID = CURRENT_SINGLE_TENANT_ID;

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.skills",
      permission: "skills.read",
    });
    if (!access.ok) {
      return access.response;
    }

    const url = new URL(request.url);
    const filters: Record<string, string> = {};

    if (url.searchParams.has("trustState")) {
      filters.trustState = url.searchParams.get("trustState")!;
    }
    if (url.searchParams.has("activationState")) {
      filters.activationState = url.searchParams.get("activationState")!;
    }
    if (url.searchParams.has("skillKey")) {
      filters.skillKey = url.searchParams.get("skillKey")!;
    }
    if (url.searchParams.has("capabilityKey")) {
      filters.capabilityKey = url.searchParams.get("capabilityKey")!;
    }

    const result = await container.skillService!.listSkills(TENANT_ID, filters);
    if (!result.ok) {
      return json({ error: result.reason, message: result.message }, { status: 400 });
    }

    return json({ skills: result.data.skills });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();
    const access = await protectRoute({
      container,
      request,
      route: "api.skills",
      permission: "skills.create",
      sameOrigin: true,
    });
    if (!access.ok) {
      return access.response;
    }

    const body = await request.json();
    const now = new Date().toISOString();

    const result = await container.skillService!.createSkill({
      skill: {
        tenantId: TENANT_ID,
        skillKey: body.skillKey,
        version: body.version,
        name: body.name,
        description: body.description,
        category: body.category,
        capabilityKeys: body.capabilityKeys ?? [],
        scripts: body.scripts,
        resources: body.resources,
        references: body.references,
        dependencyDeclarations: body.dependencyDeclarations,
        networkRequirements: body.networkRequirements,
        credentialRequirements: body.credentialRequirements,
        executionIsolationRequirement: body.executionIsolationRequirement,
        toolRequirements: body.toolRequirements,
        inputSchema: body.inputSchema,
        outputSchema: body.outputSchema,
        dataCategory: body.dataCategory,
        sensitivityLevel: body.sensitivityLevel,
        provenance: {
          source: "internal",
          origin: "human",
          contentHash: "",
          importedAt: now,
          importedByUserId: access.session.user.id,
        },
      },
      actor: {
        actorKind: "human",
        actorLabel: access.session.user.id,
      },
    });

    if (!result.ok) {
      return json({ error: result.reason, message: result.message }, { status: 400 });
    }

    return json({ skill: result.data.skill }, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
