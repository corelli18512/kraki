import type { McpToolDefinition, McpToolResult } from '../protocol.js';

/**
 * Context passed to every tool handler.
 *
 * Includes the Kraki session ID this MCP call is bound to (resolved by the
 * server from the URL path before dispatch). The agent never sees this — the
 * sessionId is injected by tentacle, not supplied by the model.
 */
export interface ToolContext {
  /** Kraki session ID this tool call belongs to. */
  sessionId: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolContext,
) => Promise<McpToolResult>;

export interface RegisteredTool {
  definition: McpToolDefinition;
  handler: ToolHandler;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): McpToolDefinition[] {
    return Array.from(this.tools.values(), (t) => t.definition);
  }

  size(): number {
    return this.tools.size;
  }
}
