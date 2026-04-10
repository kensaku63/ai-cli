/**
 * ai-cli-engine — Library interface for claude-bridge and programmatic use.
 *
 * Provides execute(), discover(), and catalog() methods.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, SearchEngine } from "./tool-registry/index.js";
import type {
  ToolMetadata,
  SearchResult,
} from "./tool-registry/index.js";
import { Provisioner } from "./auto-provision/index.js";
import { checkInstalled } from "./auto-provision/index.js";
import type { ProvisionResult, ProvisionOptions, ConfirmInfo } from "./auto-provision/index.js";

// ─── Public Types ───

export interface ExecuteOptions {
  dryRun?: boolean;
  autoApprove?: boolean;
  /** Confirmation callback for auto-provision — return true to proceed */
  confirm?: (info: ConfirmInfo) => Promise<boolean>;
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
    /** Set when auto-provision was triggered */
    provision?: {
      status: ProvisionResult["status"];
      manager?: string;
      packageName?: string;
    };
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

// ─── Pipe Template Registry ───

interface PipeTemplate {
  id: string;
  /** Regex patterns to match against queries (case-insensitive) */
  patterns: RegExp[];
  /** Primary tool ID — returned as top discovery result */
  primaryTool: string;
  /** All tools involved in this pipe pattern */
  tools: string[];
}

/**
 * Synthetic templates loaded from tool-registry/data/templates/pipe-synthetic.json.
 *
 * These come from research-datasets-ingestion.md §8 (synthetic-knowledge Phase A).
 * They target pipe queries that the builtin templates below do not cover —
 * specifically cases where the primary tool should be the "downstream"
 * consumer (less, delta, gojq) rather than the producer.
 *
 * Loaded at module init with a try/catch so an absent file degrades gracefully
 * to an empty array (useful for isolated unit tests and fresh clones).
 */
interface SyntheticTemplateJson {
  id: string;
  patterns: string[];
  primaryTool: string;
  tools: string[];
  intents?: string[];
  source?: string;
  frequency?: number;
  benchmark_hits?: number;
  commandTemplate?: string;
  attribution?: string;
  notes?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_TEMPLATES_PATH = join(
  __dirname,
  "tool-registry",
  "data",
  "templates",
  "pipe-synthetic.json",
);

function loadSyntheticTemplates(): PipeTemplate[] {
  try {
    const raw = readFileSync(SYNTHETIC_TEMPLATES_PATH, "utf-8");
    const data = JSON.parse(raw) as SyntheticTemplateJson[];
    return data.map((t) => ({
      id: t.id,
      patterns: t.patterns.map((p) => new RegExp(p, "i")),
      primaryTool: t.primaryTool,
      tools: t.tools,
    }));
  } catch {
    return [];
  }
}

const SYNTHETIC_TEMPLATES: PipeTemplate[] = loadSyntheticTemplates();

/**
 * Frequently occurring pipe patterns identified from 527-case benchmark.
 * When a query matches, the primary tool is boosted to ensure correct discovery.
 *
 * Synthetic templates from synthetic-knowledge are placed first so they
 * take precedence over the broader builtin regex below when both match.
 */
const PIPE_TEMPLATES: PipeTemplate[] = [
  ...SYNTHETIC_TEMPLATES,
  {
    id: "count-files",
    patterns: [
      /(?:count|number of)\s+(?:files|items|directories)/i,
      /(?:ファイル|アイテム)(?:数|の数)を(?:数|カウント)/,
    ],
    primaryTool: "find",
    tools: ["find", "wc"],
  },
  {
    id: "top-n-largest",
    patterns: [
      /(?:top|largest|biggest)\s+\d+\s+(?:files|directories|folders)/i,
      /(?:サイズ[順の]).*(?:ファイル|ディレクトリ|フォルダ)/,
      /(?:ファイル|ディレクトリ).*(?:大き[いな]|サイズ).*順/,
    ],
    primaryTool: "du",
    tools: ["du", "sort", "head"],
  },
  {
    id: "unique-count",
    patterns: [
      /(?:unique|distinct).*(?:count|number|values)/i,
      /(?:duplicate|重複).*(?:lines|行)/i,
      /ユニーク.*(?:数|カウント|値)/,
      /重複(?:行|した行)を(?:探|見つけ|削除)/,
    ],
    primaryTool: "sort",
    tools: ["sort", "uniq", "wc"],
  },
  {
    id: "extract-field-unique",
    patterns: [
      /(?:column|field|列|フィールド).*(?:unique|uniq|ユニーク|一意)/i,
      /(?:切り出|取り出|抽出).*(?:ユニーク|一意|重複)/,
    ],
    primaryTool: "cut",
    tools: ["cut", "sort", "uniq"],
  },
  {
    id: "extract-field",
    patterns: [
      /(?:extract|get|show)\s+(?:column|field)\s*\d/i,
      /(?:CSV|TSV|タブ区切り).*(?:列|カラム|フィールド).*(?:取り出|抽出|切り出)/,
      /(?:\d+列目|\d+番目の(?:列|フィールド)).*(?:取り出|抽出|切り出)/,
    ],
    primaryTool: "cut",
    tools: ["cut"],
  },
  {
    id: "filter-log-status",
    patterns: [
      /(?:access|error|アクセス)[\._]?log.*(?:抽出|filter|grep|検索|status|ステータス|\d{3})/i,
      /(?:status|ステータス).*(?:code|コード).*(?:access|error)[\._]?log/i,
      /(?:log|ログ).*(?:status|ステータス)\s*(?:code|コード).*(?:抽出|集計|count|filter)/i,
    ],
    primaryTool: "grep",
    tools: ["grep", "awk"],
  },
  {
    id: "json-extract",
    patterns: [
      /(?:json|JSON).*(?:extract|parse|filter|field|pretty|整形|抽出|フィールド)/i,
      /(?:package\.json|\.json).*(?:依存|dependencies|key|値|パッケージ)/i,
    ],
    primaryTool: "jq",
    tools: ["jq"],
  },
  {
    id: "save-and-display",
    patterns: [
      /(?:save|output).*(?:file|ファイル).*(?:display|show|also)|tee\b/i,
      /(?:画面).*(?:ファイル).*(?:両方|同時)/,
      /(?:表示).*(?:しつつ|しながら).*(?:保存|記録|追記).*(?:ファイル|\.(?:txt|log))/,
      /(?:保存|記録).*(?:しつつ|しながら).*(?:表示)/,
    ],
    primaryTool: "tee",
    tools: ["tee"],
  },
  {
    id: "interactive-select-fzf",
    patterns: [
      /\bfzf\b/i,
      /(?:interactive|インタラクティブ).*(?:select|pick|choose|filter|選|絞)(?!.*peco)/i,
    ],
    primaryTool: "fzf",
    tools: ["fzf"],
  },
  {
    id: "interactive-select-peco",
    patterns: [
      /\bpeco\b/i,
    ],
    primaryTool: "peco",
    tools: ["peco"],
  },
  {
    id: "sort-and-head",
    patterns: [
      /(?:most|top)\s+\d*\s*(?:memory|cpu|frequent|common|active)/i,
      /(?:メモリ|CPU|頻度).*(?:順|高い|多い).*(?:表示|一覧)/,
    ],
    primaryTool: "ps",
    tools: ["ps", "sort", "head"],
  },
];

/**
 * Match a query against pipe templates.
 * Returns the matched template or null.
 */
function matchPipeTemplate(query: string): PipeTemplate | null {
  for (const tmpl of PIPE_TEMPLATES) {
    for (const pattern of tmpl.patterns) {
      if (pattern.test(query)) return tmpl;
    }
  }
  return null;
}

// ─── Intent Decomposer ───

/**
 * Decompose a multi-action query into sub-intents.
 * Returns the original query as a single-element array if no decomposition is possible.
 *
 * Conservative: only splits when there is a clear sequential connector
 * AND the second part starts with an action indicator.
 */
function decomposeIntent(query: string): string[] {
  // Skip short queries
  if (query.length < 15) return [query];

  // Japanese action verbs that indicate the second part is a distinct action
  const jaActionStart = /^(?:それ|その|結果|出力|ログ|一覧|リスト|ファイル|内容|データ|レコード|コード|テスト|ビルド|デプロイ|インストール)/;
  const jaActionVerb = /(?:表示|実行|確認|保存|削除|作成|コピー|移動|変換|取得|抽出|出力|送信|更新|検索|監視|比較|圧縮|展開|インストール|ビルド|デプロイ|起動|停止|ソート|フィルタ|集計|カウント)/;

  // --- Japanese decomposition (conservative) ---

  // 「AしてからBする」「Aした後Bする」 — strong sequential signal
  const jaSeqStrong = query.match(/^(.{6,}?)(?:してから|した後で?|した結果を?)(.{6,})$/);
  if (jaSeqStrong) {
    const second = jaSeqStrong[2].trim();
    if (jaActionVerb.test(second)) {
      return [jaSeqStrong[1].trim(), second];
    }
  }

  // 「AしつつBする」「AしながらBする」 — concurrent signal
  const jaConcurrent = query.match(/^(.{6,}?)(?:しつつ|しながら)(.{6,})$/);
  if (jaConcurrent) {
    const second = jaConcurrent[2].trim();
    if (jaActionVerb.test(second)) {
      return [jaConcurrent[1].trim(), second];
    }
  }

  // 「Aして、Bする」 — only with explicit comma separator AND action verb in second part
  const jaComma = query.match(/^(.{6,}?)して[、,]\s*(.{8,})$/);
  if (jaComma) {
    const second = jaComma[2].trim();
    // Require the second part to contain a clear action verb
    if (jaActionVerb.test(second) && (jaActionStart.test(second) || /[をにへで]/.test(second.slice(0, 10)))) {
      return [jaComma[1].trim(), second];
    }
  }

  // --- English decomposition (conservative) ---

  // "A, then B" / "A and then B" — strong sequential signal
  const enThen = query.match(/^(.{8,}?)(?:,?\s+and then\s+|,\s+then\s+)(.{8,})$/i);
  if (enThen) return [enThen[1].trim(), enThen[2].trim()];

  // "if A, B" / "if A then B" — conditional
  const enIf = query.match(/^if\s+(.{6,?})[,;]\s*(?:then\s+)?(.{6,})$/i);
  if (enIf) return [enIf[1].trim(), enIf[2].trim()];

  return [query];
}

// ─── Engine ───

export class AiCliEngine {
  private registry: Registry;
  private searchEngine: SearchEngine;
  private initialized = false;

  constructor() {
    this.registry = new Registry();
    this.searchEngine = new SearchEngine();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.registry.loadBuiltin();
    // Load auto-generated tools (from aCLImatise-style --help parsing).
    // Non-fatal: if the directory is missing or empty, 0 are loaded.
    await this.registry.loadAuto();
    // Initialize semantic search — fail-soft; falls back to TF-IDF if model unavailable
    await this.searchEngine.initSemantic(this.registry.all());
    this.initialized = true;
  }

  /**
   * Discover matching tools for a natural language query (no execution).
   * Supports pipe template matching: when a query matches a known pipe pattern,
   * the primary tool is boosted to top position.
   */
  async discover(query: string, topK = 5): Promise<ToolCandidate[]> {
    await this.ensureInitialized();

    // Phase 1: Check pipe templates first
    const template = matchPipeTemplate(query);
    if (template) {
      const allTools = this.registry.all();
      const primaryMeta = allTools.find((t) => t.id === template.primaryTool);
      if (primaryMeta) {
        // Get normal search results, then boost the primary tool to top
        const results = await this.searchEngine.search(query, allTools, { limit: topK + 5 });
        const boosted: ToolCandidate[] = [{
          tool: primaryMeta,
          confidence: 15, // High confidence for template match
          matchedOn: [`template:${template.id}`],
        }];
        // Add remaining results (excluding primary to avoid duplicates)
        for (const r of results) {
          if (r.tool.id === template.primaryTool) continue;
          if (boosted.length >= topK) break;
          boosted.push({
            tool: r.tool,
            confidence: r.score,
            matchedOn: r.matchedOn,
          });
        }
        return boosted.slice(0, topK);
      }
    }

    // Default: standard search first (hybrid: semantic + TF-IDF when available)
    const allTools = this.registry.all();
    const results = await this.searchEngine.search(query, allTools, { limit: topK });
    const standard = results.map((r) => ({
      tool: r.tool,
      confidence: r.score,
      matchedOn: r.matchedOn,
    }));

    // Phase 2: If standard search confidence is low, try intent decomposition
    // as a fallback to find better-matching tools via sub-queries.
    //
    // Threshold note: SearchEngine.search returns blended scores in [0, 1] range
    // when semantic is ready, and raw TF-IDF scores (can exceed 10) when falling
    // back. We pick a threshold that works in both regimes: 0.5 triggers the
    // decomposition fallback on moderate-confidence hybrid results while still
    // catching the low-confidence TF-IDF-only case (where raw scores are also
    // routinely under 0.5 for ambiguous queries).
    const LOW_CONFIDENCE = this.searchEngine.isSemanticReady ? 0.5 : 6;
    if (standard.length > 0 && standard[0].confidence < LOW_CONFIDENCE) {
      const subIntents = decomposeIntent(query);
      if (subIntents.length > 1) {
        const subResults = await Promise.all(
          subIntents.map((sub) =>
            this.searchEngine.search(sub, allTools, { limit: topK }),
          ),
        );

        // Merge: collect unique tools from all sub-intents
        const seen = new Set<string>();
        const merged: ToolCandidate[] = [];

        for (const subs of subResults) {
          for (const r of subs) {
            if (seen.has(r.tool.id)) continue;
            seen.add(r.tool.id);
            merged.push({
              tool: r.tool,
              confidence: r.score,
              matchedOn: [...r.matchedOn, "decomposed"],
            });
          }
        }

        merged.sort((a, b) => b.confidence - a.confidence);

        // Only use decomposed result if it found a higher-confidence match
        if (merged.length > 0 && merged[0].confidence > standard[0].confidence) {
          return merged.slice(0, topK);
        }
      }
    }

    return standard;
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

    // 2. Resolve — ensure tool is installed (auto-provision if needed)
    const resolveResult = await this.resolve(topMatch.tool, options);

    if (resolveResult) {
      const provisionMeta = {
        status: resolveResult.status,
        manager: resolveResult.manager,
        packageName: resolveResult.packageName,
      };

      if (resolveResult.status === "cancelled") {
        return {
          tool: { id: topMatch.tool.id, name: topMatch.tool.name, version: topMatch.tool.version },
          command: "",
          status: "cancelled",
          exitCode: 0,
          output: "",
          stderr: `Installation of ${topMatch.tool.name} was cancelled by user.`,
          metadata: {
            discoveryMethod: "semantic_search",
            confidence: topMatch.confidence,
            candidatesConsidered: candidates.length,
            executionTimeMs: Date.now() - startTime,
            provision: provisionMeta,
          },
        };
      }

      if (resolveResult.status === "no_manager" ||
          resolveResult.status === "install_failed" ||
          resolveResult.status === "verify_failed") {
        return {
          tool: { id: topMatch.tool.id, name: topMatch.tool.name, version: topMatch.tool.version },
          command: "",
          status: "error",
          exitCode: 1,
          output: resolveResult.output ?? "",
          stderr: resolveResult.error ?? `Failed to provision ${topMatch.tool.name}: ${resolveResult.status}`,
          metadata: {
            discoveryMethod: "semantic_search",
            confidence: topMatch.confidence,
            candidatesConsidered: candidates.length,
            executionTimeMs: Date.now() - startTime,
            provision: provisionMeta,
          },
        };
      }
    }

    // 3. Generate command via LLM (was step 2)
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

    // 4. Dry-run: just return the plan
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

    // 5. Execute
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
   * Resolve — ensure the selected tool is installed.
   * Returns ProvisionResult if provisioning was attempted, null if already installed.
   */
  private async resolve(
    tool: ToolMetadata,
    options: ExecuteOptions,
  ): Promise<ProvisionResult | null> {
    // Check if tool is already installed
    if (tool.install.check) {
      const installed = await checkInstalled(tool.install.check);
      if (installed) return null; // Already available, no action needed
    } else {
      // No check command → assume installed (can't verify)
      return null;
    }

    // Tool is not installed — attempt auto-provision
    const provisioner = new Provisioner();
    const provisionOpts: ProvisionOptions = {
      autoApprove: options.autoApprove,
      confirm: options.confirm,
      timeout: 120_000,
    };

    return provisioner.provision(tool, provisionOpts);
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
