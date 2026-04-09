/**
 * Auto-Knowledge Extractor — Generate ToolMetadata from CrawlResult using LLM.
 *
 * L1: name + description + keywords → basic ToolMetadata (Haiku, ~500 tokens)
 * L2: + README → enhanced ToolMetadata (Haiku/Sonnet, ~2000 tokens)
 */

import type { ToolMetadata } from "../tool-registry/schema.js";
import type { CrawlResult } from "./crawler.js";

// Known categories from existing builtin tools
const KNOWN_CATEGORIES = [
  "development", "data", "network", "system", "security", "cloud",
  "container", "database", "editor", "file", "git", "json", "media",
  "monitoring", "package", "process", "search", "shell", "terminal",
  "text", "version-control", "web", "devops", "testing", "build",
];

export interface ExtractOptions {
  /** Quality level: L1 (basic) or L2 (enhanced with README) */
  level?: "L1" | "L2";
  /** Anthropic API key */
  apiKey: string;
  /** Model to use (default: claude-haiku-4-5-20251001) */
  model?: string;
}

/** Build L1 prompt: name + description + keywords only */
function buildL1Prompt(pkg: CrawlResult): string {
  const binCommands = Object.keys(pkg.bin).join(", ");

  return `以下のCLIツールについて、ai-cli検索用のメタデータをJSON形式で生成してください。

パッケージ情報:
- name: ${pkg.name}
- description: ${pkg.description}
- keywords: ${pkg.keywords.join(", ")}
- CLI commands: ${binCommands}

出力フォーマット（JSONのみ、他は何も出力しないでください）:
{
  "categories": ["最大3カテゴリ。選択肢: ${KNOWN_CATEGORIES.join(", ")}"],
  "tags": ["検索用タグ5-10個。英語で"],
  "description": "英語の簡潔な説明（1文、元のdescriptionを改善）",
  "description_ja": "日本語の簡潔な説明（1文）",
  "intents": [
    "日本語の意図クエリ1（〜したい形式）",
    "日本語の意図クエリ2",
    "日本語の意図クエリ3",
    "English intent query 1",
    "English intent query 2",
    "English intent query 3"
  ]
}

注意:
- intentsはユーザーが実際に入力する自然言語クエリを想定
- categoriesは上記リストから選択
- 推測できない場合でもベストエフォートで生成`;
}

/** Build L2 prompt: adds README context */
function buildL2Prompt(pkg: CrawlResult): string {
  const binCommands = Object.keys(pkg.bin).join(", ");
  const readmePreview = pkg.readme.slice(0, 3000);

  return `以下のCLIツールについて、ai-cli検索用のメタデータをJSON形式で生成してください。

パッケージ情報:
- name: ${pkg.name}
- description: ${pkg.description}
- keywords: ${pkg.keywords.join(", ")}
- CLI commands: ${binCommands}

README (先頭部分):
${readmePreview}

出力フォーマット（JSONのみ、他は何も出力しないでください）:
{
  "categories": ["最大3カテゴリ。選択肢: ${KNOWN_CATEGORIES.join(", ")}"],
  "tags": ["検索用タグ5-10個。英語で"],
  "description": "英語の簡潔な説明（1文、元のdescriptionを改善）",
  "description_ja": "日本語の簡潔な説明（1文）",
  "intents": [
    "日本語の意図クエリ1（〜したい形式）",
    "日本語の意図クエリ2",
    "日本語の意図クエリ3",
    "日本語の意図クエリ4",
    "日本語の意図クエリ5",
    "English intent query 1",
    "English intent query 2",
    "English intent query 3",
    "English intent query 4",
    "English intent query 5"
  ],
  "subcommands": [
    {"name": "subcommand-name", "description": "what it does"},
    ...最大10個、READMEから判読できるもののみ
  ]
}

注意:
- intentsはユーザーが実際に入力する自然言語クエリを想定
- subcommandsはREADMEから判読できるもののみ。なければ空配列
- categoriesは上記リストから選択`;
}

interface LlmExtractedData {
  categories?: string[];
  tags?: string[];
  description?: string;
  description_ja?: string;
  intents?: string[];
  subcommands?: Array<{ name: string; description: string }>;
}

/** Call Anthropic API */
async function callLlm(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { content: Array<{ text: string }> };
  return data.content[0].text.trim();
}

/** Parse LLM JSON response (handles markdown fences) */
function parseLlmJson(raw: string): LlmExtractedData {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  return JSON.parse(cleaned) as LlmExtractedData;
}

/**
 * Extract ToolMetadata from a CrawlResult using LLM.
 */
export async function extract(
  pkg: CrawlResult,
  options: ExtractOptions,
): Promise<ToolMetadata> {
  const { level = "L1", apiKey, model = "claude-haiku-4-5-20251001" } = options;

  // Build prompt based on level
  const prompt = level === "L2" ? buildL2Prompt(pkg) : buildL1Prompt(pkg);

  // Call LLM
  const raw = await callLlm(apiKey, model, prompt);
  const extracted = parseLlmJson(raw);

  // Determine the primary CLI command name
  const binKeys = Object.keys(pkg.bin);
  const primaryCommand = binKeys.includes(pkg.name) ? pkg.name : binKeys[0] ?? pkg.name;

  // Build ToolMetadata
  const tool: ToolMetadata = {
    id: primaryCommand,
    name: primaryCommand,
    version: pkg.version,
    type: "cli",
    categories: filterCategories(extracted.categories ?? []),
    tags: extracted.tags ?? pkg.keywords.slice(0, 10),
    description: extracted.description ?? pkg.description,
    description_ja: extracted.description_ja,
    install: {
      npm: pkg.name,
      check: `${primaryCommand} --version`,
    },
    subcommands: (extracted.subcommands ?? []).map((s) => ({
      name: s.name,
      description: s.description,
    })),
    intents: extracted.intents ?? [],
    source: "auto",
    updated_at: new Date().toISOString().slice(0, 10),
  };

  return tool;
}

/** Filter categories to only known values */
function filterCategories(categories: string[]): string[] {
  return categories.filter((c) => KNOWN_CATEGORIES.includes(c)).slice(0, 3);
}

/**
 * Extract multiple packages in batch with rate limiting.
 */
export async function extractBatch(
  packages: CrawlResult[],
  options: ExtractOptions & { delayMs?: number },
  onProgress?: (completed: number, total: number) => void,
): Promise<{ tool: ToolMetadata; error?: string }[]> {
  const { delayMs = 500, ...extractOpts } = options;
  const results: { tool: ToolMetadata; error?: string }[] = [];

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    try {
      const tool = await extract(pkg, extractOpts);
      results.push({ tool });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Extract failed for ${pkg.name}: ${msg}`);
      // Create a minimal fallback without LLM
      results.push({
        tool: createFallbackMetadata(pkg),
        error: msg,
      });
    }

    onProgress?.(i + 1, packages.length);

    // Rate limit between LLM calls
    if (i < packages.length - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return results;
}

/** Create a minimal ToolMetadata without LLM (pure heuristic fallback) */
function createFallbackMetadata(pkg: CrawlResult): ToolMetadata {
  const binKeys = Object.keys(pkg.bin);
  const primaryCommand = binKeys.includes(pkg.name) ? pkg.name : binKeys[0] ?? pkg.name;

  return {
    id: primaryCommand,
    name: primaryCommand,
    version: pkg.version,
    type: "cli",
    categories: [],
    tags: pkg.keywords.slice(0, 10),
    description: pkg.description,
    install: {
      npm: pkg.name,
      check: `${primaryCommand} --version`,
    },
    subcommands: [],
    intents: [],
    source: "auto",
    updated_at: new Date().toISOString().slice(0, 10),
  };
}
