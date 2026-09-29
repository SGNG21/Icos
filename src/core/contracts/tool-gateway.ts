/**
 * Tool Gateway contract — canonical model lives in `src/core/tool-gateway/`
 * (decision 0055). This path is kept because it is the governance-protected
 * entry point (`PROTECTED_PATHS["global-governance-policy"]`); it replaces the
 * former conceptual `toolGatewayRequest/Response`, `ToolDefinition` and
 * `ToolCall` stubs, which had no caller.
 */
export * from "@/core/tool-gateway/model";
export {
  approvalState,
  canDecideApproval,
  decideToolRequest,
  effectiveApproval,
  grantCovers,
  requestFingerprint,
  type ToolPolicyDecision,
} from "@/core/tool-gateway/policy";
