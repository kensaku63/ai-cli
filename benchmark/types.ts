/**
 * Benchmark — Type definitions
 */

export interface BenchmarkCase {
  id: string;
  query: string;
  language: "en" | "ja";
  difficulty: "simple" | "compound" | "pipe" | "conditional";
  expected_tool: string;
  expected_patterns: string[];
  category: string;
}

export interface BenchmarkResult {
  id: string;
  query: string;

  // Discovery metrics
  discoveryMatch: boolean;
  discoveryMatchTop3?: boolean;
  discoveryTool: string | null;
  discoveryConfidence: number;
  discoveryTimeMs: number;
  discoveryCandidates?: string[];

  // Command metrics (only in full mode)
  command?: string | null;
  commandExactMatch?: boolean;
  commandPartialMatch?: boolean;
  matchedPatterns?: string[];
  generatedTool?: string;
  status?: string;

  error?: string;
}

export interface BenchmarkSummary {
  total: number;
  discovery: {
    exactMatchRate: number;
    top3MatchRate: number;
    hits: number;
    top3Hits: number;
  };
  command: {
    exactMatchRate: number;
    partialMatchRate: number;
    exactHits: number;
    partialHits: number;
    total: number;
  } | null;
  byDifficulty: Record<string, {
    total: number;
    discoveryRate: number;
    commandRate: number;
  }>;
  byLanguage: Record<string, {
    total: number;
    discoveryRate: number;
    commandRate: number;
  }>;
}
