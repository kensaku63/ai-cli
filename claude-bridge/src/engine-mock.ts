/**
 * Mock ai-cli-engine — Returns fixed responses for development.
 * Will be replaced with actual ai-cli-engine library import once available.
 */

export interface ExecuteOptions {
  dryRun?: boolean;
  autoApprove?: boolean;
  timeout?: number;
  stdin?: string;
}

export interface ExecuteResult {
  tool: { id: string; name: string; version: string };
  command: string;
  status: "success" | "error" | "cancelled";
  exitCode: number;
  output: string;
  stderr: string;
  metadata: {
    discoveryMethod: "semantic_search" | "keyword" | "cache";
    confidence: number;
    candidatesConsidered: number;
    executionTimeMs: number;
    installed: boolean;
  };
}

export interface ToolCandidate {
  tool: { id: string; name: string; description: string; version: string };
  confidence: number;
  reason: string;
}

export interface ToolEntry {
  id: string;
  name: string;
  description: string;
  categories: string[];
  installed: boolean;
}

export interface CatalogFilter {
  search?: string;
  category?: string;
  installedOnly?: boolean;
}

const MOCK_TOOLS: ToolEntry[] = [
  { id: "git", name: "git", description: "Distributed version control system", categories: ["vcs", "development"], installed: true },
  { id: "docker", name: "docker", description: "Container platform for building and running applications", categories: ["devops", "containers"], installed: true },
  { id: "curl", name: "curl", description: "Transfer data from or to a server using various protocols", categories: ["network", "http"], installed: true },
  { id: "jq", name: "jq", description: "Lightweight command-line JSON processor", categories: ["data", "json"], installed: true },
  { id: "bird", name: "bird", description: "X/Twitter CLI for reading, searching, posting", categories: ["social_media"], installed: false },
];

export class AiCliEngine {
  async execute(query: string, options?: ExecuteOptions): Promise<ExecuteResult> {
    // Mock: return a simulated result
    const tool = MOCK_TOOLS[0]!;
    return {
      tool: { id: tool.id, name: tool.name, version: "2.47.0" },
      command: `echo "[mock] Would execute tool for: ${query}"`,
      status: "success",
      exitCode: 0,
      output: `[mock] ai-cli-engine not yet integrated.\nQuery: ${query}\nThis is a placeholder response. Connect ai-cli-engine to get real results.`,
      stderr: "",
      metadata: {
        discoveryMethod: "keyword",
        confidence: 0.85,
        candidatesConsidered: 3,
        executionTimeMs: 42,
        installed: true,
      },
    };
  }

  async discover(query: string, topK: number = 5): Promise<ToolCandidate[]> {
    // Mock: return simulated candidates
    return MOCK_TOOLS.slice(0, topK).map((t, i) => ({
      tool: { id: t.id, name: t.name, description: t.description, version: "0.0.0" },
      confidence: Math.max(0.9 - i * 0.15, 0.1),
      reason: `[mock] Matched "${query}" against ${t.name} description`,
    }));
  }

  async catalog(filter?: CatalogFilter): Promise<ToolEntry[]> {
    let tools = MOCK_TOOLS;

    if (filter?.search) {
      const q = filter.search.toLowerCase();
      tools = tools.filter(
        (t) =>
          t.name.includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.categories.some((c) => c.includes(q)),
      );
    }

    if (filter?.category) {
      const cat = filter.category.toLowerCase();
      tools = tools.filter((t) => t.categories.some((c) => c.includes(cat)));
    }

    if (filter?.installedOnly) {
      tools = tools.filter((t) => t.installed);
    }

    return tools;
  }
}
