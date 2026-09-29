import {
  act,
  connectorDefinitionSchema,
  type ConnectorCategory,
  type ConnectorDefinition,
  type ToolActionDefinition,
  type ToolDefinition,
} from "@/core/tool-gateway/model";

import type { Connector } from "../ports";

export { act };

function tool(
  toolId: string,
  category: ConnectorCategory,
  description: string,
  actions: ToolActionDefinition[],
  opts: Partial<
    Pick<ToolDefinition, "credential" | "rateLimit" | "timeoutMs" | "capabilities">
  > = {},
): ToolDefinition {
  return {
    toolId,
    version: "1.0.0",
    category,
    description,
    capabilities: opts.capabilities ?? actions.map((a) => `${toolId}.${a.action.toLowerCase()}`),
    actions,
    credential: opts.credential,
    rateLimit: opts.rateLimit,
    timeoutMs: opts.timeoutMs ?? 30_000,
    auditPolicy: { persistResult: "summary" },
  };
}

const oauth = { kind: "oauth2", required: true };
const apiKey = { kind: "api_key", required: true };

/**
 * Contract-only connectors: no real integration exists in this repository, so
 * they are NOT_CONNECTED and every execution fails closed with NOT_CONNECTED.
 * Their action/risk model is still authoritative for discovery and grants.
 */
export const NOT_CONNECTED_DEFINITIONS: readonly ConnectorDefinition[] = [
  def("email", "EMAIL", [
    tool(
      "email",
      "EMAIL",
      "Mailbox access",
      [
        act("READ", "LOW", "none", "Read a message or thread"),
        act("SEARCH", "LOW", "none", "Search the mailbox"),
        act("CREATE", "LOW", "external", "Create a draft (never sends)"),
        act("SEND", "HIGH", "external", "Send an email to external recipients"),
        act("DELETE", "HIGH", "external", "Delete / trash a message"),
      ],
      { credential: oauth },
    ),
  ]),
  def("calendar", "CALENDAR", [
    tool(
      "calendar",
      "CALENDAR",
      "Calendar events",
      [
        act("READ", "LOW", "none", "Read events and availability"),
        act("CREATE", "MEDIUM", "external", "Create an event (may notify attendees)"),
        act("UPDATE", "MEDIUM", "external", "Update an event"),
        act("DELETE", "HIGH", "external", "Cancel an event"),
      ],
      { credential: oauth },
    ),
  ]),
  def("drive", "FILES", [
    tool(
      "drive",
      "FILES",
      "Cloud drive documents",
      [
        act("READ", "LOW", "none", "Read a document"),
        act("SEARCH", "LOW", "none", "Search documents"),
        act("WRITE", "MEDIUM", "external", "Create or overwrite a document"),
        act("DELETE", "HIGH", "external", "Trash a document"),
        act("GRANT_ACCESS", "HIGH", "external", "Share a document"),
        act("REVOKE_ACCESS", "MEDIUM", "external", "Remove a share"),
      ],
      { credential: oauth },
    ),
  ]),
  def("github", "GITHUB", [
    tool(
      "github",
      "GITHUB",
      "GitHub repositories",
      [
        act("READ", "LOW", "none", "Read repository content, issues, PRs"),
        act("SEARCH", "LOW", "none", "Search code and issues"),
        act("CREATE", "MEDIUM", "external", "Open an issue or pull request"),
        act("MERGE", "HIGH", "external", "Merge a pull request"),
        act("DEPLOY", "HIGH", "external", "Trigger a production deployment workflow"),
      ],
      { credential: apiKey },
    ),
  ]),
  def("browser", "BROWSER", [
    tool("browser", "BROWSER", "Headless browsing", [
      act("READ", "LOW", "none", "Load and read a page"),
      act("EXECUTE", "HIGH", "external", "Submit a form / click on a live site"),
    ]),
  ]),
  def("terminal", "TERMINAL", [
    // Command execution is owned by the governed workspace manager (decisions 0038/0042);
    // it is deliberately not re-exposed as a free-form tool here.
    tool("terminal", "TERMINAL", "Shell command execution", [
      act("EXECUTE", "HIGH", "internal", "Run a command"),
    ]),
  ]),
  def("crm", "CRM", [
    tool(
      "crm",
      "CRM",
      "Customer records",
      [
        act("READ", "LOW", "none", "Read a contact / company"),
        act("SEARCH", "LOW", "none", "Search contacts"),
        act("CREATE", "MEDIUM", "external", "Create a contact"),
        act("UPDATE", "MEDIUM", "external", "Update a contact"),
        act("DELETE", "CRITICAL", "external", "Delete customer data"),
      ],
      { credential: apiKey },
    ),
  ]),
  def("invoicing", "INVOICING", [
    tool(
      "invoicing",
      "INVOICING",
      "Invoices and payments",
      [
        act("READ", "LOW", "none", "Read invoices"),
        act("CREATE", "MEDIUM", "external", "Create a draft invoice"),
        act("SEND", "HIGH", "external", "Send an invoice to a customer"),
        act("PAY", "CRITICAL", "external", "Pay an invoice"),
      ],
      { credential: apiKey },
    ),
  ]),
  def("telephony", "TELEPHONY", [
    tool(
      "telephony",
      "TELEPHONY",
      "SMS and calls",
      [
        act("READ", "LOW", "none", "Read message logs"),
        act("SEND", "HIGH", "external", "Send an SMS"),
        act("EXECUTE", "HIGH", "external", "Place a call"),
      ],
      { credential: apiKey },
    ),
  ]),
  def("analytics", "ANALYTICS", [
    tool(
      "analytics",
      "ANALYTICS",
      "SEO and web analytics",
      [
        act("READ", "LOW", "none", "Read reports"),
        act("SEARCH", "LOW", "none", "Query metrics"),
        act("CONFIGURE", "MEDIUM", "external", "Change property configuration"),
      ],
      { credential: oauth },
    ),
  ]),
  def("social", "SOCIAL", [
    tool(
      "social",
      "SOCIAL",
      "Social publishing and outreach",
      [
        act("READ", "LOW", "none", "Read posts and messages"),
        act("CREATE", "LOW", "internal", "Prepare a draft post (not published)"),
        act("PUBLISH", "HIGH", "external", "Publish a post"),
        act("SEND", "HIGH", "external", "Send a direct outreach message"),
      ],
      { credential: oauth },
    ),
  ]),
  def("mcp", "MCP", [
    // A remote MCP tool's effect is unknown to ICOS: invoking one is HIGH until a
    // specific MCP tool is registered with its own, narrower definition.
    tool("mcp", "MCP", "Generic MCP server", [
      act("READ", "LOW", "none", "List the server's tools/resources"),
      act("EXECUTE", "HIGH", "external", "Invoke a tool on the MCP server"),
    ]),
  ]),
];

function def(
  connectorId: string,
  category: ConnectorCategory,
  tools: ToolDefinition[],
): ConnectorDefinition {
  return connectorDefinitionSchema.parse({
    connectorId,
    category,
    availability: "NOT_CONNECTED",
    tools,
    supportsCancel: false,
    supportsReconcile: false,
  });
}

/** Contract-only adapter: reports DISABLED and refuses every call. */
export function notConnected(definition: ConnectorDefinition): Connector {
  return {
    definition,
    health: async () => "DISABLED",
    execute: async () => ({
      ok: false,
      failureClass: "NOT_CONNECTED",
      settlement: "NOT_APPLIED",
      message: `${definition.connectorId} has no real integration`,
    }),
  };
}
