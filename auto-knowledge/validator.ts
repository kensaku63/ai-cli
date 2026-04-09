/**
 * Auto-Knowledge Validator — Schema validation and quality scoring.
 *
 * Validates auto-generated ToolMetadata:
 * 1. Schema validation (required fields, types)
 * 2. Builtin duplicate detection
 * 3. Quality scoring (description length, intents count, etc.)
 */

import type { ToolMetadata } from "../tool-registry/schema.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  qualityScore: number; // 0-100
}

const KNOWN_CATEGORIES = new Set([
  "development", "data", "network", "system", "security", "cloud",
  "container", "database", "editor", "file", "git", "json", "media",
  "monitoring", "package", "process", "search", "shell", "terminal",
  "text", "version-control", "web", "devops", "testing", "build",
]);

/**
 * Validate a single ToolMetadata entry.
 */
export function validate(
  tool: ToolMetadata,
  builtinIds: Set<string>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!tool.id) errors.push("missing id");
  if (!tool.name) errors.push("missing name");
  if (!tool.type) errors.push("missing type");
  if (!tool.description) errors.push("missing description");
  if (!tool.source) errors.push("missing source");

  // Type checks
  if (tool.type && !["cli", "mcp", "api"].includes(tool.type)) {
    errors.push(`invalid type: ${tool.type}`);
  }
  if (tool.source && !["builtin", "community", "auto"].includes(tool.source)) {
    errors.push(`invalid source: ${tool.source}`);
  }
  if (!Array.isArray(tool.categories)) errors.push("categories must be array");
  if (!Array.isArray(tool.tags)) errors.push("tags must be array");
  if (!Array.isArray(tool.intents)) errors.push("intents must be array");
  if (!Array.isArray(tool.subcommands)) errors.push("subcommands must be array");

  // Builtin duplicate check
  if (builtinIds.has(tool.id)) {
    errors.push(`duplicate: id "${tool.id}" already exists in builtin`);
  }

  // Category validation
  if (Array.isArray(tool.categories)) {
    for (const cat of tool.categories) {
      if (!KNOWN_CATEGORIES.has(cat)) {
        warnings.push(`unknown category: "${cat}"`);
      }
    }
  }

  // Quality warnings
  if (tool.description && tool.description.length < 10) {
    warnings.push("description too short (< 10 chars)");
  }
  if (Array.isArray(tool.intents) && tool.intents.length < 2) {
    warnings.push("too few intents (< 2)");
  }
  if (Array.isArray(tool.tags) && tool.tags.length < 3) {
    warnings.push("too few tags (< 3)");
  }

  // Quality score calculation
  const qualityScore = calculateQualityScore(tool);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    qualityScore,
  };
}

/**
 * Calculate quality score (0-100).
 */
function calculateQualityScore(tool: ToolMetadata): number {
  let score = 0;

  // Description (max 20)
  if (tool.description) {
    if (tool.description.length >= 30) score += 20;
    else if (tool.description.length >= 10) score += 10;
    else score += 5;
  }

  // Description JA (max 10)
  if (tool.description_ja) {
    score += 10;
  }

  // Categories (max 10)
  const validCats = (tool.categories ?? []).filter((c) => KNOWN_CATEGORIES.has(c));
  score += Math.min(validCats.length * 5, 10);

  // Tags (max 15)
  const tagCount = (tool.tags ?? []).length;
  score += Math.min(tagCount * 3, 15);

  // Intents (max 30)
  const intentCount = (tool.intents ?? []).length;
  const jaIntents = (tool.intents ?? []).filter(isJapanese).length;
  const enIntents = intentCount - jaIntents;

  score += Math.min(enIntents * 3, 15);
  score += Math.min(jaIntents * 3, 15);

  // Subcommands (max 10)
  const subCount = (tool.subcommands ?? []).length;
  score += Math.min(subCount * 2, 10);

  // Install info (max 5)
  if (tool.install?.npm || tool.install?.brew || tool.install?.apt) {
    score += 5;
  }

  return Math.min(score, 100);
}

/** Simple heuristic to detect Japanese text */
function isJapanese(text: string): boolean {
  return /[\u3040-\u30FF\u4E00-\u9FFF]/.test(text);
}

/**
 * Validate a batch of tools and return summary.
 */
export function validateBatch(
  tools: ToolMetadata[],
  builtinIds: Set<string>,
): {
  valid: ToolMetadata[];
  invalid: Array<{ tool: ToolMetadata; result: ValidationResult }>;
  stats: {
    total: number;
    validCount: number;
    invalidCount: number;
    avgQualityScore: number;
    duplicateCount: number;
  };
} {
  const valid: ToolMetadata[] = [];
  const invalid: Array<{ tool: ToolMetadata; result: ValidationResult }> = [];
  let totalScore = 0;
  let duplicateCount = 0;

  // Track auto IDs to detect self-duplicates
  const seenIds = new Set<string>();

  for (const tool of tools) {
    // Check for self-duplicate (same id within the auto-generated batch)
    if (seenIds.has(tool.id)) {
      invalid.push({
        tool,
        result: {
          valid: false,
          errors: [`self-duplicate: id "${tool.id}" already in this batch`],
          warnings: [],
          qualityScore: 0,
        },
      });
      duplicateCount++;
      continue;
    }
    seenIds.add(tool.id);

    const result = validate(tool, builtinIds);
    totalScore += result.qualityScore;

    if (result.valid) {
      valid.push(tool);
    } else {
      invalid.push({ tool, result });
      if (result.errors.some((e) => e.startsWith("duplicate:"))) {
        duplicateCount++;
      }
    }
  }

  return {
    valid,
    invalid,
    stats: {
      total: tools.length,
      validCount: valid.length,
      invalidCount: invalid.length,
      avgQualityScore: tools.length > 0 ? Math.round(totalScore / tools.length) : 0,
      duplicateCount,
    },
  };
}
