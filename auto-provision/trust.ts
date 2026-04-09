/**
 * Auto-Provision — Trust score calculation
 *
 * 4-signal weighted average to assess tool trustworthiness:
 *   registry_source (40%) + install_check (30%) + methods_count (20%) + description (10%)
 */

import type { ToolMetadata } from "../tool-registry/schema.js";

export type TrustLevel = "high" | "medium" | "low";

export interface TrustScore {
  score: number;       // 0.0 – 1.0
  level: TrustLevel;
  breakdown: {
    registrySource: number;
    installCheck: number;
    methodsCount: number;
    description: number;
  };
}

/** Score the registry source (builtin = 1.0, community = 0.6, auto = 0.3) */
function scoreRegistrySource(source: string): number {
  switch (source) {
    case "builtin":   return 1.0;
    case "community": return 0.6;
    case "auto":      return 0.3;
    default:          return 0.1;
  }
}

/** Score whether the tool has an install check command */
function scoreInstallCheck(install: ToolMetadata["install"]): number {
  return install.check ? 1.0 : 0.0;
}

/** Score the number of install methods (more = more established) */
function scoreMethodsCount(install: ToolMetadata["install"]): number {
  const { check, ...methods } = install;
  const count = Object.values(methods).filter(Boolean).length;
  if (count >= 3) return 1.0;
  if (count === 2) return 0.7;
  if (count === 1) return 0.4;
  return 0.0;
}

/** Score whether the tool has a meaningful description */
function scoreDescription(tool: ToolMetadata): number {
  const hasEn = (tool.description?.length ?? 0) > 10;
  const hasJa = (tool.description_ja?.length ?? 0) > 5;
  if (hasEn && hasJa) return 1.0;
  if (hasEn || hasJa) return 0.6;
  return 0.0;
}

/** Map numeric score to trust level */
function toLevel(score: number): TrustLevel {
  if (score >= 0.7) return "high";
  if (score >= 0.4) return "medium";
  return "low";
}

/** Calculate trust score for a tool */
export function calculateTrust(tool: ToolMetadata): TrustScore {
  const registrySource = scoreRegistrySource(tool.source);
  const installCheck = scoreInstallCheck(tool.install);
  const methodsCount = scoreMethodsCount(tool.install);
  const description = scoreDescription(tool);

  const score =
    registrySource * 0.4 +
    installCheck * 0.3 +
    methodsCount * 0.2 +
    description * 0.1;

  return {
    score,
    level: toLevel(score),
    breakdown: { registrySource, installCheck, methodsCount, description },
  };
}
