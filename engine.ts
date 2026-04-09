/**
 * ai-cli-engine — Library interface for claude-bridge and programmatic use.
 *
 * Provides execute(), discover(), and catalog() methods.
 */

import { spawn } from "node:child_process";
import { Registry, searchTools } from "./tool-registry/index.js";
import type {
  ToolMetadata,
  SearchResult,
} from "./tool-registry/index.js";

// ─── Public Types ───

export interface ExecuteOptions {
  dryRun?: boolean;
  autoApprove?: boolean;
  timeout?: number;
  stdin?: string;
  format?: "json" | "text";
}

export interface ExecuteResult {
  tool: { id: string; name: string; version?: string };
  command: string;
  status: "success" | "error" | "cancelled" | "no_tool_found";
  exitCode: number;
  output: string;
  stderr: string;
  metadata: {
    discoveryMethod: "semantic_search" | "keyword" | "cache";
    confidence: number;
    candidatesConsidered: number;
    executionTimeMs: number;
  };
}

export interface ToolCandidate {
  tool: ToolMetadata;
  confidence: number;
  matchedOn: string[];
}

export interface CatalogFilter {
  type?: "cli" | "mcp" | "api";
  category?: string;
  tag?: string;
}

// ─── Engine ───

export class AiCliEngine {
  private registry: Registry;
  private initialized = false;

  constructor() {
    this.registry = new Registry();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.registry.loadBuiltin();
    this.initialized = true;
  }

  /**
   * Discover matching tools for a natural language query (no execution).
   */
  async discover(query: string, topK = 5): Promise<ToolCandidate[]> {
    await this.ensureInitialized();
    const results = searchTools(query, this.registry.all(), { limit: topK });
    return results.map((r) => ({
      tool: r.tool,
      confidence: r.score,
      matchedOn: r.matchedOn,
    }));
  }

  /**
   * Full pipeline: discover → generate command → execute → return result.
   * Requires ANTHROPIC_API_KEY for LLM command generation.
   */
  async execute(
    query: string,
    options: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const startTime = Date.now();
    await this.ensureInitialized();

    // 1. Discover tools
    const candidates = await this.discover(query, 3);

    if (candidates.length === 0) {
      return {
        tool: { id: "none", name: "none" },
        command: "",
        status: "no_tool_found",
        exitCode: 2,
        output: "",
        stderr: "No matching tool found for the query.",
        metadata: {
          discoveryMethod: "semantic_search",
          confidence: 0,
          candidatesConsidered: 0,
          executionTimeMs: Date.now() - startTime,
        },
      };
    }

    const topMatch = candidates[0]!;

    // 2. Generate command via LLM
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is required for execute()");
    }

    const system = buildSystemPrompt(candidates, process.cwd());
    let userMsg = "";
    if (options.stdin) {
      const preview = options.stdin.slice(0, 2000);
      userMsg += `Input data:\n${preview}${options.stdin.length > 2000 ? `\n... (${options.stdin.length} bytes total)` : ""}\n\n`;
    }
    userMsg += `Instruction: ${query}`;

    const command = await askLLM(apiKey, system, [
      { role: "user", content: userMsg },
    ]);

    // 3. Dry-run: just return the plan
    if (options.dryRun) {
      return {
        tool: { id: topMatch.tool.id, name: topMatch.tool.name, version: topMatch.tool.version },
        command,
        status: "success",
        exitCode: 0,
        output: "",
        stderr: "",
        metadata: {
          discoveryMethod: "semantic_search",
          confidence: topMatch.confidence,
          candidatesConsidered: candidates.length,
          executionTimeMs: Date.now() - startTime,
        },
      };
    }

    // 4. Execute
    const timeoutMs = options.timeout ?? 30_000;
    const result = await runCommand(command, options.stdin ?? "", timeoutMs);

    if (result === "timeout") {
      return {
        tool: { id: topMatch.tool.id, name: topMatch.tool.name, version: topMatch.tool.version },
        command,
        status: "error",
        exitCode: 124,
        output: "",
        stderr: `Command timed out after ${timeoutMs / 1000}s`,
        metadata: {
          discoveryMethod: "semantic_search",
          confidence: topMatch.confidence,
          candidatesConsidered: candidates.length,
          executionTimeMs: Date.now() - startTime,
        },
      };
    }

    return {
      tool: { id: topMatch.tool.id, name: topMatch.tool.name, version: topMatch.tool.version },
      command,
      status: result.exitCode === 0 ? "success" : "error",
      exitCode: result.exitCode,
      output: result.stdout,
      stderr: result.stderr,
      metadata: {
        discoveryMethod: "semantic_search",
        confidence: topMatch.confidence,
        candidatesConsidered: candidates.length,
        executionTimeMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Browse the tool catalog with optional filters.
   */
  async catalog(filter?: CatalogFilter): Promise<ToolMetadata[]> {
    await this.ensureInitialized();
    let tools = this.registry.all();

    if (filter?.type) {
      tools = tools.filter((t) => t.type === filter.type);
    }
    if (filter?.category) {
      tools = tools.filter((t) => t.categories.includes(filter.category!));
    }
    if (filter?.tag) {
      tools = tools.filter((t) => t.tags.includes(filter.tag!));
    }

    return tools;
  }
}

// ─── Internal Helpers ───

function buildSystemPrompt(
  candidates: ToolCandidate[],
  cwd: string,
): string {
  const toolDescriptions = candidates.map((c) => {
    const t = c.tool;
    const subs = t.subcommands
      .map((s) => `    ${s.usage ?? s.name} — ${s.description}`)
      .join("\n");
    return [
      `- **${t.name}** (${t.id}): ${t.description}`,
      t.install.check ? `  Check: ${t.install.check}` : "",
      subs ? `  Subcommands:\n${subs}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  return `\
Output ONLY executable bash. No explanation, no markdown fences, no comments.
Catastrophic commands (rm -rf /, mkfs, dd to disk): output \`echo "REFUSED: <reason>" >&2; exit 1\`
Cap large output with \`head -n 50\`. Bound long-running commands with \`timeout\`.
CWD: ${cwd} | OS: ${process.platform} ${process.arch}

Matched tools (use the most appropriate one):
${toolDescriptions.join("\n\n")}`;
}

async function askLLM(
  apiKey: string,
  system: string,
  messages: { role: "user" | "assistant"; content: string }[],
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.AI_MODEL ?? "claude-sonnet-4-6",
      max_tokens: parseInt(process.env.AI_MAX_TOKENS ?? "4096", 10),
      temperature: 0,
      system,
      messages,
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { content: [{ text: string }] };
  const raw = data.content[0].text.trim();
  return raw.replace(/^```\w*\n([\s\S]*?)```$/g, "$1").trim();
}

function runCommand(
  code: string,
  stdinData: string,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string } | "timeout"> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-c", code], { stdio: ["pipe", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    if (stdinData) {
      proc.stdin.write(stdinData);
    }
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill();
      resolve("timeout");
    }, timeoutMs);

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}
