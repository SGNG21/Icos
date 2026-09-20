# ADR-0001: Define ICOS Business Domain Model for Client Context and RGPD

## Status
Accepted

## Context
ICOS is evolving into a Business Operating System (Business OS) capable of managing multiple clients with varying levels of autonomy. We need a canonical domain model to support:
- Multi-client isolation
- Configurable modules (website, SEO, CRM, etc.)
- Autonomy policies (OFF, ASSISTED, AUTOMATED, AUTONOMOUS)
- RGPD compliance primitives
- CRM and project tracking
- Metrics and analytics
- Future extensibility without modifying core ICOS mission/runtime systems

The model must avoid touching existing systems: Drizzle migrations, PostgreSQL database, container.ts, Goal Intake routes (Phase 8A), auth, frontend Business OS, OmniRoute, and workers.

## Decision
We define a layered domain model consisting of:
1. **Organizational Hierarchy**: Organization → BusinessUnit → ClientAccount → ClientWorkspace
2. **Core Entities**: Contact (Lead, Prospect, Customer), Project, Campaign, Mission (reference to ICOS Mission system)
3. **ClientWorkspace**: The primary isolation unit containing identity, modules configuration, projects, campaigns, missions, memory, permissions, RGPD configuration, autonomy policy, and metrics.
4. **Module Model**: Generic enableable/disableable modules with configuration, permissions, integrations, status, and metrics.
5. **Autonomy Policy**: Four levels (OFF, ASSISTED, AUTOMATED, AUTONOMOUS) with overrides per module/action.
6. **Context Engine**: Multi-level scopes (GLOBAL, ORGANIZATION, BUSINESS_UNIT, CLIENT, WORKSPACE, PROJECT, CAMPAIGN, MISSION, CONVERSATION) with strict isolation preventing cross-client data leakage without explicit sharing.
7. **Memory Model**: Distinction between personal, business, client, documentary, CRM, logs, operational, mission, and procedural memory.
8. **RGPD Model**: Entities for DataSubject, PersonalDataRecord, ProcessingPurpose, LegalBasis, ConsentRecord, DataSource, RetentionPolicy, ProcessingActivity, DeletionRequest, AccessRequest, ExportRequest, Processor, Subprocessor.
9. **CRM Model**: Lead, Prospect, Contact, Company, Opportunity, PipelineStage, Interaction, Campaign, Sequence, Message, Appointment, Conversion with source, date, purpose, client, campaign, status, interaction history, opt-out, retention.
10. **Project Model**: Projects reference ICOS Missions and Tasks via references, with goals, metrics, and document references.
11. **Metrics Model**: Generic MetricDefinition, MetricValue, MetricSeries, MetricDimension, MetricSource to allow agnostic metric collection.
12. **Integration Model**: Separation of IntegrationAccount (definition), IntegrationConnection (configured instance with credentials stored elsewhere), IntegrationCapability, IntegrationPermission.
13. **Multi-Tenancy Readiness**: All entities include tenant-scoped IDs (organizationId, clientId, workspaceId, etc.) and defined access boundaries to avoid blocking future multi-tenancy.

We create three documentation files:
- `docs/architecture/business-domain-model.md` (overall model)
- `docs/architecture/client-context-model.md` (detailed ClientWorkspace)
- `docs/architecture/rgpd-data-model.md` (RGPD primitives)

We also create a TypeScript contracts folder `src/core/business/` if needed in future implementation, but this lot is documentation-only.

## Consequences
### Positive
- Clear separation of concerns and isolation between clients.
- Enables multi-client SaaS offering without major rework.
- Provides foundation for RGPD compliance via explicit data modeling.
- Allows flexible module and autonomy configuration per client.
- Leverages existing ICOS Mission engine without duplication.
- Supports future API boundaries and extensibility.
- Avoids modification of prohibited areas (DB, container, auth, etc.).

### Negative
- Implementation effort required in future lots to turn model into code/contracts.
- Risk of model drifting from actual implementation if not continuously synchronized.
- Initial complexity in understanding the layered model.

### Neutral
- No immediate changes to runtime, database, or existing ICOS core systems.
- The model is deliberately framework- and ORM-agnostic for flexibility.

## Links
- This ADR supersedes no prior ADRs.
- Related to future work on Goal Intake context scoping, module implementation, and autonomy policy enforcement.