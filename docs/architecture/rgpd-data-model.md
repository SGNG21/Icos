# RGPD Data Model for ICOS

This document defines the data model for RGPD (GDPR) compliance within ICOS. It provides the logical entities and relationships necessary to implement compliance controls, without guaranteeing legal compliance. The model is designed to be integrated into the ICOS context engine and client workspace.

## Overview

ICOS processes personal data on behalf of its clients (data controllers). To support compliance, ICOS must:

1.  Allow clients to define their data processing activities.
2.  Track the provenance, purpose, legal basis, and retention of personal data.
3.  Manage consent where required.
4.  Facilitate data subject rights (access, rectification, erasure, export, objection).
5.  Maintain records of processing activities (ROPA).
6.  Distinguish between data controllers (clients) and data processors (ICOS and subprocessors).
7.  Log access and modifications to personal data for accountability.

## Core Entities

### DataSubject
Represents an individual whose personal data is processed. In ICOS, a DataSubject is typically a Contact (lead, prospect, customer, or user) but could also be an employee of the client or a third party.

Fields:
- `dataSubjectId`: Unique identifier (UUID)
- `workspaceId`: Reference to the ClientWorkspace where the data subject is known
- `externalId`: Optional identifier from the client's own systems (e.g., CRM ID)
- `category`: e.g., "customer", "employee", "website visitor", "subscriber"
- `createdAt`, `updatedAt`: Timestamps
- `status`: e.g., "active", "inactive", "opted_out", "deleted"

Note: The actual personal data (name, email, etc.) is stored in PersonalDataRecord instances linked to this DataSubject.

### PersonalDataRecord
A single piece of personal data (e.g., an email address, a phone number, a name) associated with a DataSubject.

Fields:
- `recordId`: Unique identifier (UUID)
- `dataSubjectId`: Back-reference
- `workspaceId`: For context and access control
- `dataType`: The type of personal data (e.g., "email", "phoneNumber", "fullName", "IPAddress", "jobTitle")
- `value`: The actual data value (encrypted at rest, pseudonymized where appropriate)
- `source`: Reference to a DataSource (how we obtained this data)
- `collectedAt`: Timestamp when the data was collected
- `updatedAt`: Timestamp of last modification
- `isConsentRequired`: Boolean indicating if processing this data requires consent (based on purpose and legal basis)
- `consentId`: Reference to a ConsentRecord if consent is the legal basis
- `legalBasis`: The GDPR Article 6 basis for processing (see ProcessingPurpose and LegalBasis entities)
- `purposeId`: Reference to a ProcessingPurpose (why we are processing this data)
- `retentionExpiresAt`: Timestamp when the data should be deleted/anonymized per retention policy
- `status`: e.g., "active", "anonymized", "deleted", "superseded"
- `accessLogId`: Reference to an audit log entry for access (simplified; actual logging is via Context Engine)
- `modificationLogId`: Reference to an audit log entry for modification

### ProcessingPurpose
A defined reason for processing personal data. Purposes are defined by the client (data controller) within their workspace.

Fields:
- `purposeId`: Unique identifier (UUID)
- `workspaceId`: Back-reference
- `name`: Short name (e.g., "email_marketing", "service_delivery", "legitimate_interest_analytics")
- `description`: Detailed description of the purpose
- `legalBasisId`: Reference to the default LegalBasis for this purpose (can be overridden per record)
- `isConsentRequired`: Boolean indicating if consent is typically required for this purpose
- `retentionPolicyId`: Reference to the default RetentionPolicy for this purpose
- `createdAt`, `updatedAt`: Timestamps
- `status`: "active", "archived"

### LegalBasis
The GDPR Article 6 legal basis for processing personal data.

Fields:
- `legalBasisId`: Unique identifier (UUID)
- `workspaceId`: Back-reference (allows clients to define their own interpretations, though standard bases are preferred)
- `type`: One of the six lawful bases:
  - "consent" (Article 6(1)(a))
  - "contract" (Article 6(1)(b)) - necessary for performance of a contract
  - "legal_obligation" (Article 6(1)(c)) - necessary for compliance with a legal obligation
  - "vital_interests" (Article 6(1)(d)) - necessary to protect vital interests
  - "public_task" (Article 6(1)(e)) - necessary for performance of a task carried out in public interest
  - "legitimate_interest" (Article 6(1)(f)) - necessary for legitimate interests pursued by controller or third party
- `description`: Explanation of how this basis applies to the purpose
- `requiresConsent`: Derived from type (only "consent" requires explicit consent; others may require notice but not consent)
- `createdAt`, `updatedAt`: Timestamps

### ConsentRecord
Documentation of consent given by a DataSubject for a specific purpose.

Fields:
- `consentId`: Unique identifier (UUID)
- `dataSubjectId`: Back-reference
- `workspaceId`: Back-reference
- `purposeId`: Reference to the ProcessingPurpose for which consent is given
- `legalBasisId`: Should point to the "consent" legal basis
- `givenAt`: Timestamp when consent was given
- `method`: How consent was obtained (e.g., "web_form", "paper", "recorded_oral")
- `evidence`: Reference to stored evidence (e.g., form submission ID, recording ID, scanned document)
- `scope`: Details of what the consent covers (e.g., specific data types, channels)
- `withdrawnAt`: Timestamp if consent was withdrawn (null if still valid)
- `status`: "given", "withdrawn", "expired"
- `createdAt`, `updatedAt`: Timestamps

### DataSource
Origin of a personal data record. Helps establish provenance and lawfulness of collection.

Fields:
- `dataSourceId`: Unique identifier (UUID)
- `workspaceId`: Back-reference
- `name`: Descriptive name (e.g., "website_contact_form", "trade_show_scan", "customer_upload", "linkedin_lead_gen")
- `type`: Categorization (e.g., "direct_from_subject", "public_source", "third_party", "observed")
- `collectionMethod`: How data was collected (e.g., "form", "api", "manual_entry", "scraping")
- `dateAvailableFrom`: Timestamp from which data from this source is considered collected
- `privacyNoticeLink`: URL to the privacy notice presented at collection
- `createdAt`, `updatedAt`: Timestamps

### RetentionPolicy
Defines how long personal data should be kept and what happens after that period.

Fields:
- `retentionPolicyId`: Unique identifier (UUID)
- `workspaceId`: Back-reference
- `name`: e.g., "marketing_leads_2_years", "contract_data_10_years"
- `description`: Explanation
- `retentionPeriod`: Duration (e.g., "2 years", "6 months", "until contract end + 5 years")
- `retentionPeriodUnit`: "days", "months", "years", "until_event"
- `triggerEvent`: If unit is "until_event", what event triggers the start (e.g., "contract_end", "last_interaction", "consent_withdrawal")
- `actionAfterRetention`: What to do when the retention period expires:
  - "delete" - permanently delete the data
  - "anonymize" - irreversibly anonymize the data
  - "archive" - move to archive with restricted access
  - "review" - flag for manual review
- `createdAt`, `updatedAt`: Timestamps

### ProcessingActivity
A record of a specific processing operation (part of the ROPA - Records of Processing Activities). This links together the purpose, legal basis, data categories, etc.

Fields:
- `processingActivityId`: Unique identifier (UUID)
- `workspaceId`: Back-reference
- `name`: Name of the activity (e.g., "Customer Relationship Management", "Email Newsletter Distribution")
- `purposeId`: Reference to ProcessingPurpose (the main purpose)
- `legalBasisId`: Reference to LegalBasis (can be multiple; this stores the primary or we can have a linking table)
- `dataController`: The client (organization) acting as controller for this activity
- `dataProcessor`: ICOS (or a specific subprocessors) acting as processor
- `categoriesOfDataSubjects`: e.g., "customers", "prospects", "employees"
- `categoriesOfPersonalData`: e.g., "identifiers", "contact_details", "employment_details"
- `recipients`: Who the data is disclosed to (e.g., "email_service_provider", "payment_processor")
- `transfersToThirdCountries`: Whether data is transferred outside EEA and safeguards used
- `retentionDescription`: Description of retention limits (links to RetentionPolicy)
- `descriptionOfTechnicalOrganisationalMeasures`: Security measures in place
- `createdAt`, `updatedAt`: Timestamps

### DeletionRequest
A formal request from a DataSubject to delete their personal data (right to erasure).

Fields:
- `deletionRequestId`: Unique identifier (UUID)
- `dataSubjectId`: Back-reference
- `workspaceId`: Back-reference
- `requestedAt`: Timestamp when request was made
- `method`: How request was submitted (e.g., "email", "web_portal", "letter")
- `status`: "pending", "in_progress", "completed", "rejected", "partial"
- `processedAt`: Timestamp when processing was completed
- `reason`: If rejected or partial, why
- `recordsAffected`: List of PersonalDataRecord IDs that were targeted
- `recordsDeleted`: Count of records actually deleted/anonymized
- `createdAt`, `updatedAt`: Timestamps

### AccessRequest
A formal request from a DataSubject to access their personal data (right of access).

Fields:
- `accessRequestId`: Unique identifier (UUID)
- `dataSubjectId`: Back-reference
- `workspaceId`: Back-reference
- `requestedAt`: Timestamp when request was made
- `method`: How request was submitted
- `status`: "pending", "in_progress", "completed", "rejected"
- `processedAt`: Timestamp when response was sent
- `recordsProvided`: List of PersonalDataRecord IDs included in the response
- `createdAt`, `updatedAt`: Timestamps

### ExportRequest
A formal request from a DataSubject to export their personal data (right to data portability).

Fields:
- `exportRequestId`: Unique identifier (UUID)
- `dataSubjectId`: Back-reference
- `workspaceId`: Back-reference
- `requestedAt`: Timestamp when request was made
- `method`: How request was submitted
- `formatRequested`: Desired format (e.g., "JSON", "CSV")
- `status`: "pending", "in_progress", "completed", "rejected"
- `processedAt`: Timestamp when export was generated
- `exportLocation`: Reference to where the export file is stored (temporary, secure)
- `recordsIncluded`: List of PersonalDataRecord IDs included
- `createdAt`, `updatedAt`: Timestamps

### Processor
An entity that processes personal data on behalf of the controller (the client). In ICOS, ICOS itself is a Processor for the client's workspace.

Fields:
- `processorId`: Unique identifier (UUID)
- `workspaceId`: Back-reference (indicates which workspace this processor serves)
- `name`: Legal name of the processor
- `type`: e.g., "subprocessor", "ICOS_native", "third_party_service"
- `serviceDescription`: Description of the processing activities performed
- `dataProtectionTermsLink`: Link to the data processing agreement (DPA)
- `subprocessors`: Array of subprocessors used by this processor (if any)
- `createdAt`, `updatedAt`: Timestamps

### Subprocessor
A processor engaged by another processor (e.g., a third-party service used by ICOS to send emails).

Fields:
- `subprocessorId`: Unique identifier (UUID)
- `processorId`: Back-reference to the Processor that engaged them
- `workspaceId`: Back-reference (for context)
- `name`: Legal name
- `serviceDescription`: What they do (e.g., "email delivery", "payment processing")
- `dataProtectionTermsLink`: Link to DPA or confirmation that flows down
- `createdAt`, `updatedAt`: Timestamps

## Relationships Summary

- One DataSubject has many PersonalDataRecords.
- One PersonalDataRecord points to one DataSource, one ProcessingPurpose, one LegalBasis (directly or via purpose), and optionally one ConsentRecord.
- One ProcessingPurpose has many PersonalDataRecords and points to one LegalBasis (default) and one RetentionPolicy (default).
- One ConsentRecord points to one DataSubject, one ProcessingPurpose.
- One DataSource can be referenced by many PersonalDataRecords.
- One RetentionPolicy can be referenced by many ProcessingPurposes and PersonalDataRecords.
- One ProcessingActivity links to one ProcessingPurpose, one LegalBasis (primary), and describes the processing.
- One DataSubject can make many DeletionRequest, AccessRequest, ExportRequest.
- One Processor (ICOS) serves one workspace; a workspace has one Processor (ICOS) but may have many subprocessors.
- One Processor can have many Subprocessors.

## Context Engine Integration

These entities exist within the ClientWorkspace context. The Context Engine ensures:
- A DataSubject or PersonalDataRecord from Workspace A is not accessible in Workspace B without explicit sharing (which would create a new, linked record with proper consent and purpose).
- Processing purposes, legal bases, retention policies, etc., are workspace-scoped unless explicitly shared at a higher level (organization/business unit) with appropriate governance.
- When a Mission processes personal data, it receives context that includes:
  - The list of permitted ProcessingPurposes for the current action.
  - The LegalBasis for each purpose.
  - Consent requirements and status.
  - Retention constraints.
  - The identity of the DataController (the client) and DataProcessor (ICOS).
- The Mission must log its processing activities (via the audit subsystem) linking to the ProcessingActivity records.

## Audit and Logging

Every access (read) and modification (create, update, delete, anonymize) to a PersonalDataRecord must generate an audit log entry via ICOS's existing audit subsystem. The audit log should capture:
- Who (user/agent/service) performed the action
- What action was performed
- On which record (PersonalDataRecord ID)
- When (timestamp)
- Why (purpose, mission ID, or action description)
- Legal basis and consent status (if applicable)
- Outcome (success, failure)

This satisfies the accountability principle and provides the data for ROPA and breach notifications.

## Data Subject Rights Workflow

### Right to Access
1.  DataSubject submits AccessRequest.
2.  System locates all PersonalDataRecords for that DataSubject in the workspace.
3.  System verifies identity (through existing auth mechanisms).
4.  System compiles a report of the data (excluding data about others) and provides it in a portable format.
5.  Request is marked completed.

### Right to Rectification
Handled via standard update operations on PersonalDataRecord, which are audited. If the DataSubject requests rectification, it is treated as an update request with appropriate justification.

### Right to Erasure
1.  DataSubject submits DeletionRequest.
2.  System validates the request (identity, scope).
3.  System identifies all PersonalDataRecords that fall under the request and are subject to erasure (considering exemptions).
4.  System either deletes or anonymizes the records as per the actionAfterRetention of the applicable RetentionPolicy or as specified in the request.
5.  System logs the action and updates the request status.

### Right to Data Portability
1.  DataSubject submits ExportRequest.
2.  System locates all PersonalDataRecords for that DataSubject that are provided by the DataSubject and processed based on consent or contract.
3.  System exports the data in a structured, commonly used, machine-readable format (e.g., JSON).
4.  Request is marked completed.

### Right to Object
1.  DataSubject submits a request to object to processing (typically for direct marketing or legitimate interest).
2.  System evaluates the objection against the legal basis.
3.  If the objection is upheld (e.g., for direct marketing), processing stops and the DataSubject is marked as opted_out.
4.  If processing is based on legitimate interests, the controller must demonstrate compelling legitimate grounds that override the interests of the data subject.

### Right to Restriction of Processing
Similar to objection; processing is restricted (data stored but not used) while a complaint is investigated or data accuracy is contested.

## Implementation Notes

- Encryption at rest and pseudonymization should be applied to sensitive personal data fields (like `value` in PersonalDataRecord).
- The actual encryption key management is outside the scope of this model but must be managed securely.
- Consent withdrawal should automatically trigger a review of whether the legal basis for processing still exists; if not, processing must stop.
- The model does not include data about legal entities (controllers/processors) beyond simple names; in a production system, these would be linked to organizational data.
- The ProcessingActivity entity is simplified; a full ROPA would require more detail (e.g., separate tables for joint controllers, detailed transfer mechanisms). This model provides the core links.
- All timestamps should be stored in UTC.
- The model assumes that the ICOS platform provides the underlying security, authentication, and authorization mechanisms that enforce workspace isolation and least-privilege access.

## Example Snippets (TypeScript/Zod-like)

```typescript
// PersonalDataRecord
const PersonalDataRecord = z.object({
  recordId: z.string().uuid(),
  dataSubjectId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  dataType: z.enum(['email', 'phoneNumber', 'fullName', 'jobTitle', 'IPAddress', 'postalAddress', /* etc */]),
  value: z.string(), // encrypted
  source: z.string().uuid(), // DataSource ID
  collectedAt: z.date(),
  updatedAt: z.date().optional(),
  isConsentRequired: z.boolean(),
  consentId: z.string().uuid().optional(),
  legalBasisId: z.string().uuid(),
  purposeId: z.string().uuid(),
  retentionExpiresAt: z.date().optional(),
  status: z.enum(['active', 'anonymized', 'deleted', 'superseded']),
});

// ProcessingPurpose
const ProcessingPurpose = z.object({
  purposeId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  legalBasisId: z.string().uuid(),
  isConsentRequired: z.boolean(),
  retentionPolicyId: z.string().uuid().optional(),
  status: z.enum(['active', 'archived']),
});

// ConsentRecord
const ConsentRecord = z.object({
  consentId: z.string().uuid(),
  dataSubjectId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  purposeId: z.string().uuid(),
  givenAt: z.date(),
  method: z.string(),
  evidence: z.string().optional(),
  scope: z.string().optional(),
  withdrawnAt: z.date().optional(),
  status: z.enum(['given', 'withdrawn', 'expired']),
});
```

## Cross-Workspace Considerations

If a client wishes to share a DataSubject's data between two workspaces (e.g., for a parent company with subsidiaries), the following must occur:
1.  Explicit consent (if required) for the sharing purpose.
2.  Creation of a new DataSubject record in the target workspace (or linking via a global party identifier with proper controls).
3.  Creation of new PersonalDataRecord instances in the target workspace, with their own sources, purposes, legal basis, and consent records pointing to the sharing event.
4.  The original records remain in the source workspace; sharing does not move data, it copies with appropriate compliance.

This ensures that each workspace maintains its own compliance boundaries.

## Conclusion

This RGPD data model provides the foundational elements for ICOS to process personal data in a manner that supports compliance with GDPR/RGPD. It integrates with the existing ICOS context engine, mission system, and audit logging to ensure traceability and control. The model is intentionally minimal and focused on the core concepts required for a B2B AI operating system managing multiple client workspaces.