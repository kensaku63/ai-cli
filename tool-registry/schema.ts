/**
 * Tool Registry — Metadata schema v0.1
 */

export type ToolType = "cli" | "mcp" | "api";

export interface InstallInfo {
  brew?: string;
  apt?: string;
  npm?: string;
  pip?: string;
  cargo?: string;
  choco?: string;
  /** Command to check if the tool is already installed */
  check?: string;
}

export interface Subcommand {
  name: string;
  description: string;
  usage?: string;
  examples?: string[];
}

export interface ToolMetadata {
  id: string;
  name: string;
  version?: string;
  type: ToolType;
  categories: string[];
  tags: string[];
  description: string;
  description_ja?: string;
  install: InstallInfo;
  subcommands: Subcommand[];
  /** Natural language queries that map to this tool (for search accuracy) */
  intents: string[];
  source: "builtin" | "community" | "auto";
  updated_at: string;
}

export interface SearchResult {
  tool: ToolMetadata;
  score: number;
  /** Which field(s) contributed most to the match */
  matchedOn: string[];
}
