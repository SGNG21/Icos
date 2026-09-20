# ICOS Client Context Model

This document defines the ClientWorkspace and related entities that form the operational context for a client within ICOS.

## ClientWorkspace

The ClientWorkspace is the primary unit of isolation in ICOS for client-specific operations. It encapsulates:

### Identity
- `workspaceId`: Unique identifier for the workspace
- `clientId`: Reference to the parent ClientAccount
- `name`: Human-readable name (e.g., "LDS Rénov' - Main")
- `description`: Optional description
- `createdAt`, `updatedAt`: Timestamps
- `status`: Active, archived, suspended

### Client Information
- Legal name, trade name, registration numbers
- Address, contact information
- Industry classification, size
- Primary domain(s), subdomains
- Branding assets (logos, color schemes, fonts)

### Contacts
Collection of Contact entities associated with the workspace. Each Contact has:
- `contactId`: Unique identifier
- `workspaceId`: Back-reference
- `type`: lead, prospect, customer, user, etc.
- Personal details (name, email, phone, role)
- Professional details (position, department)
- Communication preferences
- Consent records (for RGPD)
- Timeline of interactions
- Tags and segments

### Modules Configuration
Map of module identifiers to their configuration:
```typescript
{
  website: { enabled: true, config: { ... } },
  seo: { enabled: true, config: { ... } },
  // ... etc
}
```
Each module configuration includes:
- `enabled`: boolean
- `mode`: operational mode (e.g., for analytics: basic, advanced)
- `configuration`: module-specific settings
- `permissions`: required permissions for this workspace
- `integrations`: linked integration accounts
- `status`: current operational status (active, inactive, error)
- `metrics`: key performance indicators for the module

### Projects
Collection of Projects belonging to the workspace. Each Project references:
- `projectId`: Unique identifier
- `workspaceId`: Back-reference
- `name`, `description`
- `startDate`, `targetEndDate`, `actualEndDate`
- `status`: planning, active, on hold, completed, cancelled
- `goals`: Array of ProjectGoal
- `metrics`: Array of ProjectMetric
- `references`: 
  - `missionReferences`: Links to ICOS Missions that contribute to the project
  - `taskReferences`: Links to ICOS Tasks (if using task-level granularity)
  - `documentReferences`: Links to documents (stored in document management)
- `budget`: allocated budget, actual spend
- `owner`: primary Contact (project manager)
- `stakeholders`: array of Contacts

### Campaigns
Collection of Campaigns belonging to the workspace. Each Campaign references:
- `campaignId`: Unique identifier
- `workspaceId`: Back-reference
- `name`, `description`, `type` (e.g., email, social, ads)
- `startDate`, `endDate`
- `status`: draft, active, paused, completed
- `objectives`: measurable goals
- `targetAudience`: segmentation criteria
- `budget`: allocated and actual spend
- `channel`: primary channel (email, LinkedIn, Facebook, Google Ads, etc.)
- `content`: references to content assets
- `performance`: metrics (impressions, clicks, conversions, etc.)
- `owner`: primary Contact
- `missions`: Links to ICOS Missions that execute campaign actions

### Missions
Collection of ICOS Missions executed in the context of this workspace. Each Mission reference includes:
- `missionId`: Unique identifier (from ICOS Mission system)
- `workspaceId`: Back-reference (for querying)
- `name`, `description`
- `status`: pending, running, completed, failed, cancelled
- `trigger`: how the mission was initiated (scheduled, event-based, manual)
- `schedule`: cron expression or interval for recurring missions
- `lastRunAt`, `nextRunAt`: timestamps
- `resultSummary`: brief outcome
- `linkedTo`: optional projectId or campaignId if part of a larger initiative

### Memory
The workspace's knowledge base, partitioned by type:
- **Personal Memory**: User-specific preferences, shortcuts, saved views
- **Business Memory**: SOPs, process documentation, historical decisions, best practices
- **Client Memory**: Client-specific facts, preferences, historical interactions, contract details
- **Documentary Knowledge**: Uploaded documents, scraped web content, indexed files
- **Procedural Learning**: ICOS's learned optimizations, adaptation patterns, fine-tuned models

Each memory type has:
- `scope`: visibility (workspace-only, or shared with higher levels per policy)
- `retention`: how long to keep
- `aiAccess`: whether ICOS can process/learn from it
- `accessControls`: who can read/write

### Permissions
Role-based and resource-based permissions defined at the workspace level:
- Roles: admin, manager, operator, viewer, etc.
- Resources: modules, projects, campaigns, missions, memory types, contacts
- Actions: create, read, update, delete, execute, approve, export
- Inheritance: permissions can inherit from organization/business unit policies with overrides

### RGPD Configuration
Workspace-specific privacy and compliance settings:
- `legalEntity`: the legal entity responsible for data processing (controller)
- `dataProtectionOfficer`: contact for DPO (if applicable)
- `processingActivities`: register of processing activities (link to RGPD model)
- `retentionPolicies`: default retention rules by data type
- `consentRequirements`: which processing activities require consent
- `dataSubjectRightsProcedures`: how to handle access, rectification, deletion requests
- `breachNotificationProcedure`: internal process for data breaches
- `internationalTransfers`: safeguards for data transfers outside EU
- `auditLogs`: configuration for logging access and modifications

### Autonomy Policy
The default autonomy level for the workspace and overrides:
- `defaultLevel`: OFF, ASSISTED, AUTOMATED, AUTONOMOUS
- `moduleOverrides`: { moduleId: AutonomyLevel }
- `actionOverrides`: { actionKey: AutonomyLevel or ApprovalPolicy }
- `approvalRequired`: list of actions that require manual approval regardless of autonomy level

### Metrics
Workspace-level aggregated metrics:
- `businessMetrics`: revenue, margin, lead count, conversion rate, etc.
- `moduleMetrics`: performance per enabled module
- `missionMetrics`: success rate, average duration, resource consumption
- `engagementMetrics`: contact interaction frequencies, response times
- `qualityMetrics`: error rates, rework, satisfaction scores

## Context Engine Integration

The ClientWorkspace provides the primary context for ICOS operations:
- When a Mission is executed, it receives a context object that includes:
  - Workspace identity and configuration
  - Relevant contacts (based on mission context)
  - Active projects and campaigns
  - Enabled modules and their configurations
  - Memory access (subject to permissions and policies)
  - RGPD constraints (what personal data can be processed)
  - Autonomy policies (what actions can be performed autonomously)
- The Context Engine ensures that:
  - Data from other workspaces is not accessible unless explicitly shared
  - Higher-level context (organization, business unit) is available as permitted
  - Changes to workspace context are versioned and auditable

## Relationships Summary

- 1 Organization : N BusinessUnits
- 1 BusinessUnit : N ClientAccounts
- 1 ClientAccount : N ClientWorkspaces
- 1 ClientWorkspace : N Contacts (Leads, Prospects, Customers, Users)
- 1 ClientWorkspace : N Projects
- 1 Project : N Campaigns (optional)
- 1 ClientWorkspace : N Campaigns (also directly)
- 1 ClientWorkspace : N Missions (via ICOS Mission system)
- 1 ClientWorkspace : 1 Memory system (partitioned)
- 1 ClientWorkspace : 1 Permission system
- 1 ClientWorkspace : 1 RGPD configuration
- 1 ClientWorkspace : 1 Autonomy policy
- 1 ClientWorkspace : N Metric series

## State Diagram

A ClientWorkspace can transition through these states:
```
[Created] --> [Active] --> [Archived]
     \--> [Suspended] --> [Active]
              \--> [Archived]
```
- Created: initial state after provisioning
- Active: fully operational
- Suspended: temporarily disabled (retains data, stops processing)
- Archived: retired (data retained per retention policies, no new operations)

## Multi-Tenant Considerations

Even in single-tenant mode, the ClientWorkspace model enforces:
- Logical separation via workspaceId
- No shared mutable state between workspaces
- Context Engine prevents cross-workspace data leakage
- All services and workers must validate workspaceId for every operation
- Future multi-tenant deployment would only require adding tenantId hierarchy above organizationId

## Example: LDS Rénov' Workspace

```json
{
  "workspaceId": "ws_ldsrenov_001",
  "clientId": "client_ldsrenov",
  "name": "LDS Rénov' - Main",
  "description": "Primary workspace for LDS Rénov' renovation business",
  "status": "active",
  "clientInfo": {
    "legalName": "LDS Rénov' SARL",
    "tradeName": "LDS Rénov'",
    "registrationNumber": "RCS Paris 123 456 789",
    "address": "123 Rue de la République, 75001 Paris",
    "industry": "Construction/Rénovation",
    "size": "SME",
    "domains": ["ldsrenov.fr"]
  },
  "modules": {
    "website": { "enabled": true, "config": { "cms": "wordpress", "hosting": "managed" } },
    "seo": { "enabled": true, "config": { "keywords": ["rénovation paris", "artisan batiment"], "tracking": true } },
    "maintenance": { "enabled": true, "config": { "responseTime": "4h", "preventive": true } },
    "analytics": { "enabled": true, "config": { "provider": "google_analytics4", "dashboard": "real-time" } },
    "linkedin": { "enabled": false },
    "prospecting": { "enabled": false },
    "email": { "enabled": false },
    "ads": { "enabled": false },
    "crm": { "enabled": false }
  },
  "autonomy": {
    "defaultLevel": "AUTONOMOUS",
    "moduleOverrides": {
      "website": "AUTONOMOUS",
      "seo": "AUTONOMOUS",
      "maintenance": "AUTOMATED",
      "analytics": "AUTOMATED"
    },
    "actionOverrides": {
      "content_publish": "APPROVAL_REQUIRED",
      "budget_modify": "APPROVAL_REQUIRED"
    }
  }
}
```

## Example: Éditions du Mécène Workspace

```json
{
  "workspaceId": "ws_editionsmecene_001",
  "clientId": "client_editionsmecene",
  "name": "Éditions du Mécène - Publishing",
  "description": "Workspace for Éditions du Mécène book publishing business",
  "status": "active",
  "clientInfo": {
    "legalName": "Éditions du Mécène SAS",
    "tradeName": "Éditions du Mécène",
    "registrationNumber": "RCS Lyon 987 654 321",
    "address": "456 Rue de la République, 69002 Lyon",
    "industry": "Publishing",
    "size": "SME",
    "domains": ["editionsmecene.fr"]
  },
  "modules": {
    "website": { "enabled": true, "config": { "cms": "webflow", "hosting": "managed" } },
    "seo": { "enabled": true, "config": { "keywords": ["édition indépendante", "livre contemporain"], "tracking": true } },
    "linkedin": { "enabled": true, "config": { "companyPage": true, "showcasePages": ["litterature", "essais"] } },
    "prospecting": { "enabled": true, "config": { "sources": ["linkedin", "events"], "scoring": true } },
    "email": { "enabled": true, "config": { "provider": "brevo", "automation": true, "segmentation": true } },
    "facebook": { "enabled": true, "config": { "page": true, "ads": false } },
    "ads": { "enabled": true, "config": { "platform": ["meta", "google"], "approvalRequired": true } },
    "crm": { "enabled": true, "config": { "pipelineStages": ["lead", "prospect", "proposal", "negotiation", "won", "lost"] } },
    "analytics": { "enabled": true, "config": { "provider": "mixpanel", "events": ["page_view", "sign_up", "purchase"] } },
    "content": { "enabled": true, "config": { "types": ["blog", "video", "podcast"], "workflow": "approval" } }
  },
  "autonomy": {
    "defaultLevel": "AUTONOMOUS",
    "moduleOverrides": {
      "ads": "OFF",
      "email_send": "APPROVAL_REQUIRED",
      "linkedin_publish": "APPROVAL_REQUIRED",
      "content_publish": "APPROVAL_REQUIRED"
    }
  }
}
```