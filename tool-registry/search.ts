/**
 * Tool Registry — Semantic search engine
 *
 * P0 implementation: token-based text similarity scoring.
 * Combines exact name matching, intent matching, and keyword overlap
 * to rank tools by relevance to a natural language query.
 */

import type { ToolMetadata, SearchResult } from "./schema.js";

/** Tokenize text into lowercase words, removing punctuation */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Generate character n-grams for fuzzy matching */
function ngrams(text: string, n: number): Set<string> {
  const s = text.toLowerCase();
  const result = new Set<string>();
  for (let i = 0; i <= s.length - n; i++) {
    result.add(s.slice(i, i + n));
  }
  return result;
}

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/** Word overlap ratio: how many query tokens appear in the target text */
function wordOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const targetSet = new Set(targetTokens);
  let matches = 0;
  for (const q of queryTokens) {
    if (targetSet.has(q)) matches++;
  }
  return matches / queryTokens.length;
}

/** Build a searchable text blob from a tool's metadata */
function buildSearchText(tool: ToolMetadata): string {
  const parts = [
    tool.name,
    tool.description,
    tool.description_ja ?? "",
    tool.tags.join(" "),
    tool.categories.join(" "),
    ...tool.subcommands.map((s) => `${s.name} ${s.description}`),
  ];
  return parts.join(" ");
}

/** Score a single tool against a query */
function scoreTool(
  query: string,
  queryTokens: string[],
  queryNgrams: Set<string>,
  tool: ToolMetadata,
): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = [];
  let score = 0;
  const q = query.toLowerCase();

  // 1. Exact name match (highest signal)
  if (q === tool.name.toLowerCase() || q === tool.id.toLowerCase()) {
    score += 10;
    matchedOn.push("name");
  } else if (q.includes(tool.name.toLowerCase()) || q.includes(tool.id.toLowerCase())) {
    score += 5;
    matchedOn.push("name");
  }

  // 2. Intent matching (high signal — pre-defined natural language mappings)
  let bestIntentScore = 0;
  for (const intent of tool.intents) {
    const intentTokens = tokenize(intent);
    const overlap = wordOverlap(queryTokens, intentTokens);
    if (overlap > bestIntentScore) bestIntentScore = overlap;

    // Also check n-gram similarity for fuzzy matching
    const intentNgrams = ngrams(intent, 3);
    const sim = jaccard(queryNgrams, intentNgrams);
    if (sim > bestIntentScore) bestIntentScore = sim;
  }
  if (bestIntentScore > 0) {
    score += bestIntentScore * 6;
    matchedOn.push("intents");
  }

  // 3. Subcommand name match
  for (const sub of tool.subcommands) {
    if (q.includes(sub.name.toLowerCase())) {
      score += 3;
      matchedOn.push(`subcommand:${sub.name}`);
      break;
    }
  }

  // 4. Tag match
  for (const tag of tool.tags) {
    if (queryTokens.includes(tag.toLowerCase())) {
      score += 2;
      if (!matchedOn.includes("tags")) matchedOn.push("tags");
    }
  }

  // 5. General text similarity (description + categories + subcommand descriptions)
  const searchText = buildSearchText(tool);
  const searchTokens = tokenize(searchText);
  const textOverlap = wordOverlap(queryTokens, searchTokens);
  if (textOverlap > 0) {
    score += textOverlap * 3;
    if (!matchedOn.includes("description")) matchedOn.push("description");
  }

  return { score, matchedOn };
}

export interface SearchOptions {
  /** Maximum number of results to return (default: 5) */
  limit?: number;
  /** Minimum score threshold (default: 0.5) */
  threshold?: number;
}

/** Search tools by natural language query */
export function searchTools(
  query: string,
  tools: ToolMetadata[],
  options: SearchOptions = {},
): SearchResult[] {
  const { limit = 5, threshold = 0.5 } = options;
  const queryTokens = tokenize(query);
  const queryNg = ngrams(query, 3);

  const results: SearchResult[] = [];

  for (const tool of tools) {
    const { score, matchedOn } = scoreTool(query, queryTokens, queryNg, tool);
    if (score >= threshold) {
      results.push({ tool, score, matchedOn });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
