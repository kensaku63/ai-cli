#!/usr/bin/env node
/**
 * claude-bridge — MCP server that exposes ai-cli as a single tool router.
 *
 * Claude Code connects to this server instead of 200+ individual MCP servers.
 * Token cost: ~500 tokens (3 tools) vs ~90,000 tokens (200+ tools).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AiCliEngine } from "./engine-mock.js";
import { formatOutput, formatError } from "./formatter.js";

const engine = new AiCliEngine();

const server = new McpServer({
  name: "ai-cli",
  version: "0.1.0",
});

// --- Tool 1: ai_run ---
// Main tool: natural language → discover → execute → return results
server.registerTool(
  "ai_run",
  {
    title: "AI CLI Run",
    description:
      "Execute any task using natural language. Discovers the optimal CLI/API tool, installs if needed, and returns results. Use this for: running commands, searching social media, file operations, API calls, data processing, and any other task that can be done with a CLI tool.",
    inputSchema: {
      query: z
        .string()
        .describe(
          'What you want to do, in natural language (e.g., "search X for AI news", "compress this PDF", "check AWS billing")',
        ),
      stdin: z
        .string()
        .optional()
        .describe("Optional input data to pipe to the tool"),
      dry_run: z
        .boolean()
        .optional()
        .describe(
          "If true, return the execution plan without actually running",
        ),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds (default: 30)"),
    },
  },
  async ({ query, stdin, dry_run, timeout }) => {
    try {
      const result = await engine.execute(query, {
        dryRun: dry_run,
        stdin,
        timeout: timeout ? timeout * 1000 : undefined,
        autoApprove: true,
      });

      const output = formatOutput(result.output);
      const header = [
        `Tool: ${result.tool.name} (${result.tool.id})`,
        `Command: ${result.command}`,
        `Status: ${result.status} (exit ${result.exitCode})`,
        `Discovery: ${result.metadata.discoveryMethod} (confidence: ${result.metadata.confidence.toFixed(2)})`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: `${header}\n\n${output}` }],
        isError: result.status === "error",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: formatError("Execution failed", message) }],
        isError: true,
      };
    }
  },
);

// --- Tool 2: ai_discover ---
// Discovery only: find tools without executing
server.registerTool(
  "ai_discover",
  {
    title: "AI CLI Discover",
    description:
      "Find available tools for a task without executing. Returns tool candidates with confidence scores. Use this when planning or when you want to know what tools are available before committing to execution.",
    inputSchema: {
      query: z
        .string()
        .describe("Capability you need, in natural language"),
      top_k: z
        .number()
        .optional()
        .describe("Number of candidates to return (default: 5)"),
    },
  },
  async ({ query, top_k }) => {
    try {
      const candidates = await engine.discover(query, top_k ?? 5);

      if (candidates.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No tools found for: "${query}"`,
            },
          ],
        };
      }

      const lines = candidates.map(
        (c, i) =>
          `${i + 1}. **${c.tool.name}** (confidence: ${c.confidence.toFixed(2)})\n   ${c.tool.description}\n   Reason: ${c.reason}`,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${candidates.length} tool(s) for "${query}":\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: formatError("Discovery failed", message) }],
        isError: true,
      };
    }
  },
);

// --- Tool 3: ai_catalog ---
// Browse/search the tool catalog
server.registerTool(
  "ai_catalog",
  {
    title: "AI CLI Catalog",
    description:
      "Browse or search the tool catalog. Returns available tools grouped by category. Use this to understand what capabilities are available.",
    inputSchema: {
      search: z
        .string()
        .optional()
        .describe("Optional keyword filter"),
      category: z
        .string()
        .optional()
        .describe(
          'Optional category filter (e.g., "social_media", "devops", "data")',
        ),
      installed_only: z
        .boolean()
        .optional()
        .describe("If true, only show locally installed tools"),
    },
  },
  async ({ search, category, installed_only }) => {
    try {
      const tools = await engine.catalog({
        search,
        category,
        installedOnly: installed_only,
      });

      if (tools.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No tools match the given filter.",
            },
          ],
        };
      }

      // Group by category
      const byCategory = new Map<string, typeof tools>();
      for (const tool of tools) {
        for (const cat of tool.categories) {
          const list = byCategory.get(cat) ?? [];
          list.push(tool);
          byCategory.set(cat, list);
        }
      }

      const sections: string[] = [];
      for (const [cat, catTools] of byCategory) {
        const lines = catTools.map(
          (t) =>
            `  - ${t.name}${t.installed ? "" : " (not installed)"}: ${t.description}`,
        );
        sections.push(`**${cat}**\n${lines.join("\n")}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Tool catalog (${tools.length} tools):\n\n${sections.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: formatError("Catalog query failed", message) }],
        isError: true,
      };
    }
  },
);

// --- Start server ---
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start claude-bridge:", err);
  process.exit(1);
});
