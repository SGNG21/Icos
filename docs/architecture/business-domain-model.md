# ICOS Business Domain Model

This document defines the canonical business domain model for ICOS as a Business Operating System (Business OS) capable of managing multiple clients with varying levels of autonomy.

## Core Concepts

### Organization
Represents the entity that owns and operates the ICOS instance. In the context of ICOS, there is a single organization (the ICOS operator) that manages multiple client accounts.

### BusinessUnit
A logical division within an organization (e.g., different departments, brands, or legal entities). ICOS itself may be considered a BusinessUnit of the parent organization, but for multi-client scenarios, each client may have their own BusinessUnit(s).

### ClientAccount
The top-level representation of a client engaging with ICOS. A ClientAccount encapsulates:
- Identity and legal information
- Workspace(s)
- Modules configuration
- Autonomy policies
- Billing and contractual details
- RGPD/compliance settings

### ClientWorkspace
An isolated environment for a specific client where their data, configurations, missions, projects, and campaigns reside. A ClientAccount may have multiple Workspaces (e.g., for different brands, regions, or product lines).

### Contact
An individual person associated with a ClientAccount or ClientWorkspace. Contacts can be:
- Leads (potential customers)
- Prospects (qualified leads)
- Customers (current clients)
- Users (internal or external stakeholders)

### Lead
A potential customer who has shown interest but has not been qualified.

### Prospect
A qualified lead that has been vetted and is considered a potential sales opportunity.

### Customer
A Contact who has engaged in a commercial relationship (e.g., signed a contract, purchased services).

### Project
A time-bound endeavor undertaken to create a unique product, service, or result for a ClientAccount. Examples: website redesign, SEO campaign, LinkedIn prospecting campaign.

### Campaign
A coordinated set of actions (marketing, sales, communication) designed to achieve a specific goal within a Project or independently. Examples: email marketing campaign, LinkedIn outreach campaign, Facebook ad campaign.

### Mission
An ICOS-specific unit of work that represents an autonomous or semi-autonomous task executed by the ICOS engine (e.g., content creation, data analysis, automation workflow). Missions belong to the context of a ClientWorkspace.

### Memory
The knowledge base accumulated by ICOS for a ClientWorkspace, including:
- Personal memory (user-specific preferences)
- Business memory (processes, SOPs, historical decisions)
- Client memory (client-specific facts, preferences, history)
- Documentary knowledge (uploaded documents, scraped data)
- Procedural learning (ICOS's learned behaviors and optimizations)

### Permissions
Fine-grained access controls that determine what identities (users, agents, services) can perform within a ClientWorkspace or on specific resources.

### RGPD Compliance
The set of controls, records, and processes that ensure personal data handling complies with GDPR/RGPD regulations.

## Relationships

- An Organization contains one or more BusinessUnits.
- A BusinessUnit manages one or more ClientAccounts.
- A ClientAccount contains one or more ClientWorkspaces.
- A ClientWorkspace contains zero or more Contacts (Leads, Prospects, Customers).
- A ClientWorkspace contains zero or more Projects.
- A Project contains zero or more Campaigns.
- A ClientWorkspace contains zero or more Missions.
- Missions, Projects, and Campaigns all exist within the context of a specific ClientWorkspace.
- Memory is scoped to the ClientWorkspace level (with inheritance from higher levels as permitted by policy).
- Permissions are assigned at the ClientWorkspace level (or lower) and inherit from Organization/BusinessUnit policies.

## Autonomy Levels

ICOS supports four autonomy levels that can be set globally, per ClientWorkspace, per Module, or per Action:
- OFF: No autonomous operation; requires manual initiation for every action.
- ASSISTED: ICOS provides suggestions and automation aids but requires human approval for execution.
- AUTOMATED: ICOS executes actions automatically within predefined constraints; exceptions trigger alerts for human review.
- AUTONOMOUS: ICOS operates with minimal human oversight, self-correcting and adapting within its defined scope.

## Modules

Functional capabilities that can be enabled/disabled per ClientWorkspace. Examples include:
- website
- seo
- maintenance
- analytics
- crm
- linkedin
- prospecting
- email
- facebook
- google_ads
- content
- automation
- documents
- finance
- custom

Each Module has:
- enabled/disabled state
- configuration parameters
- permission requirements
- integration points
- status indicators
- metrics

## Context Engine

ICOS maintains a multi-level context hierarchy to ensure data isolation and appropriate information flow:
- GLOBAL: Settings applicable to all ICOS operations
- ORGANIZATION: Organization-wide policies and data
- BUSINESS_UNIT: BusinessUnit-specific overrides
- CLIENT: ClientAccount-level context
- WORKSPACE: ClientWorkspace-specific context (primary operating context)
- PROJECT: Context specific to a Project
- CAMPAIGN: Context specific to a Campaign
- MISSION: Context specific to a Mission execution
- CONVERSATION: Context of an ongoing interaction (chat, session)

Strict enforcement ensures that information from one ClientWorkspace cannot leak into another without explicit authorization through sharing mechanisms.

## Data Classification

Data in ICOS is classified by:
- Owner (who owns the data: ICOS, Client, User)
- Scope (where the data is visible: GLOBAL, ORGANIZATION, BUSINESS_UNIT, CLIENT, WORKSPACE, etc.)
- Retention (how long the data is kept)
- AI Access (whether ICOS AI can process/learn from the data)
- Exportable (whether the data can be exported)
- Erasable (whether the data can be deleted on request)
- Audited (whether access/modifications are logged)

## RGPD Primitives

To support compliance, ICOS models:
- DataSubject: The individual whose personal data is processed
- PersonalDataRecord: A piece of personal data linked to a DataSubject
- ProcessingPurpose: The reason for processing personal data
- LegalBasis: The GDPR Article 6 basis for processing
- ConsentRecord: Documentation of consent when required
- DataSource: Origin of the data
- RetentionPolicy: Rules for data retention and deletion
- DeletionRequest: Formal request to delete personal data
- AccessRequest: Formal request to access personal data
- ExportRequest: Formal request to export personal data
- Processor: Entity processing data on behalf of the controller
- Subprocessor: Processor engaged by another Processor
- ProcessingActivity: Documentation of what processing occurs, why, and how

## CRM Primitives

ICOS includes a lightweight CRM capable of tracking:
- Lead source, collection date, purpose
- Prospect qualification and scoring
- Contact details and communication history
- Opportunity value and stage
- Pipeline stages
- Interactions (emails, calls, meetings)
- Campaign membership
- Opt-out status
- Retention policies

## Project Model

Projects reference ICOS Missions rather than duplicating the execution engine:
- Project: Contains goals, metrics, documents, and mission references
- ProjectGoal: A measurable objective within the project
- ProjectMetric: A quantifiable measure tracked for the project
- ProjectTaskReference: Link to an ICOS Task (if using task-level granularity)
- ProjectDocumentReference: Link to documents associated with the project
- ProjectMissionReference: Link to an ICOS Mission that contributes to the project

## Metrics and Analytics

A generic metrics model allows ICOS to collect and display data from various integrations without hardcoding:
- MetricDefinition: Defines what is being measured (name, description, unit, aggregation method)
- MetricValue: A single measured value at a point in time
- MetricSeries: A sequence of MetricValues over time
- MetricDimension: Attributes that categorize metrics (e.g., campaign_id, channel, date)
- MetricSource: The origin of the metric data (internal ICOS module, external integration)

## Integrations

Integration accounts and connections are modeled separately from credentials:
- IntegrationAccount: Definition of an integration capability (e.g., Google Analytics, LinkedIn)
- IntegrationConnection: An instance of an IntegrationAccount configured with credentials (stored securely elsewhere)
- IntegrationCapability: Specific actions or data points available via the integration
- IntegrationPermission: Grants required to use specific capabilities

## Multi-Tenancy Readiness

While ICOS may start as a single-tenant system, the model is designed to avoid blocking future multi-tenancy:
- All core entities include tenant-scoped IDs (organizationId, clientId, workspaceId, etc.)
- Access boundaries are defined at each level
- No global singleton state that would prevent isolation
- Context Engine enforces isolation by default

## Examples

### Example A: LDS Rénov'
- Modules: website=enabled, seo=enabled, maintenance=enabled, analytics=enabled, others=disabled
- Autonomy: Workspace = AUTONOMOUS, but specific actions like content publishing may require approval
- No prospecting or outbound sales modules active

### Example B: Éditions du Mécène
- Modules: website=enabled, seo=enabled, linkedin=enabled, prospecting=enabled, email=enabled, facebook=enabled, crm=enabled, analytics=enabled, ads=configurable
- Autonomy: Workspace = AUTONOMOUS with module-specific overrides (e.g., google_ads = OFF, email_send = APPROVAL_REQUIRED)

## Future API Boundaries

Documenting future API endpoints (not implemented in this lot):
- GET /api/organizations
- GET /api/clients
- GET /api/clients/:id
- GET /api/clients/:id/modules
- GET /api/clients/:id/context
- GET /api/clients/:id/missions
- GET /api/clients/:id/projects
- GET /api/clients/:id/campaigns
- GET /api/clients/:id/metrics
- GET /api/clients/:id/privacy

## Link to ICOS Autonomous Runtime

The ClientWorkspace provides the context for:
- Goal Intake (which will later accept a contextScope/clientId parameter)
- Mission selection and execution
- Worker selection based on capabilities and autonomy policies
- Execution via the DigitalOS Execution Facade or ICOS native workers
- Review processes
- Metrics collection
- Memory storage and retrieval

This model ensures that ICOS autonomous operations remain strictly within the bounds of the ClientWorkspace context and respect all configured policies.