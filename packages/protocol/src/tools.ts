// ------------------------------------------------------------
// Tool types — known tool argument shapes
// ------------------------------------------------------------

export interface ShellToolArgs {
  command: string;
}

export interface WriteFileToolArgs {
  path: string;
  content: string;
}

export interface ReadFileToolArgs {
  path: string;
}

export interface FetchUrlToolArgs {
  url: string;
  method?: string;
}

export interface McpToolArgs {
  server: string;
  tool: string;
  params: Record<string, unknown>;
}

/** Known tool types with typed arguments */
export type KnownToolArgs =
  | { toolName: 'shell';      args: ShellToolArgs }
  | { toolName: 'write_file'; args: WriteFileToolArgs }
  | { toolName: 'read_file';  args: ReadFileToolArgs }
  | { toolName: 'fetch_url';  args: FetchUrlToolArgs }
  | { toolName: 'mcp';        args: McpToolArgs };

/** Fallback for agent-specific or future tools */
export interface UnknownToolArgs {
  toolName: string;
  args: Record<string, unknown>;
}

/** All possible tool shapes — known tools are typed, unknown allowed */
export type ToolArgs = KnownToolArgs | UnknownToolArgs;
