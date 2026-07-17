/** Canonical protocol names for Kraki-owned artifact tools.
 *
 * Agent SDKs expose MCP identity differently: Copilot provides structured
 * server/tool fields, while Claude flattens the identity into a display name.
 * Normalize only exact Kraki-owned forms; arbitrary tools must never become
 * durable artifacts merely because their names contain a substring. */
export function canonicalArtifactToolName(
  toolName: string,
  mcpServerName?: string,
  mcpToolName?: string,
): string {
  if (mcpServerName === 'kraki' && (mcpToolName === 'show_image' || mcpToolName === 'show_html')) {
    return mcpToolName;
  }
  if (
    toolName === 'show_image'
    || toolName === 'kraki-show_image'
    || toolName === 'mcp__kraki__show_image'
  ) return 'show_image';
  if (
    toolName === 'show_html'
    || toolName === 'kraki-show_html'
    || toolName === 'mcp__kraki__show_html'
  ) return 'show_html';
  return toolName;
}
