/**
 * aCLImatise Adapter — Convert aCLImatise YAML data to ToolMetadata.
 *
 * aCLImatise (github.com/aCLImatise/BaseCamp) provides 3,145 structured
 * CLI tool definitions parsed from --help output using PEG grammar.
 *
 * Note: BaseCamp tools are primarily bioinformatics (BioConda).
 * This adapter also provides a generic --help parser for general CLI tools.
 */

import type { ToolMetadata, Subcommand } from "../tool-registry/schema.js";

// ─── aCLImatise YAML Schema Types ───

interface ACliFlag {
  synonyms: string[];
  description: string;
  optional: boolean;
  args: { _type?: string; name?: string; names?: string[] };
}

interface ACliPositional {
  name: string;
  description: string;
  position: number;
  optional: boolean;
}

interface ACliCommand {
  command: string[];
  positional: ACliPositional[];
  named: ACliFlag[];
  subcommands: ACliCommand[];
  help_text: string;
  docker_image?: string;
}

/**
 * Convert a parsed aCLImatise YAML command to ToolMetadata.
 */
export function convertACliCommand(cmd: ACliCommand): ToolMetadata {
  const toolName = cmd.command[0] ?? "unknown";

  // Extract subcommands
  const subcommands: Subcommand[] = cmd.subcommands
    .slice(0, 20)
    .map((sub) => {
      const subName = sub.command[sub.command.length - 1] ?? "";
      const desc = extractFirstLine(sub.help_text) || subName;
      return { name: subName, description: desc };
    })
    .filter((s) => s.name);

  // Extract description from help_text
  const description = extractDescription(cmd.help_text) || toolName;

  // Build tags from flag names and subcommand names
  const tags = buildTags(cmd);

  return {
    id: toolName,
    name: toolName,
    type: "cli",
    categories: inferCategories(toolName, description, tags),
    tags,
    description,
    install: {
      check: `${toolName} --version`,
    },
    subcommands,
    intents: [],
    source: "auto",
    updated_at: new Date().toISOString().slice(0, 10),
  };
}

/** Extract first meaningful line from help text */
function extractFirstLine(helpText: string): string {
  if (!helpText) return "";
  const lines = helpText.split("\n").filter((l) => l.trim());
  // Skip lines that are just the command name or usage
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("Usage:")) continue;
    if (trimmed.startsWith("usage:")) continue;
    if (trimmed.length < 5) continue;
    if (trimmed.startsWith("-")) continue;
    return trimmed.slice(0, 200);
  }
  return lines[0]?.trim().slice(0, 200) ?? "";
}

/** Extract description from help text (first paragraph) */
function extractDescription(helpText: string): string {
  if (!helpText) return "";
  const lines = helpText.split("\n");
  const descLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip initial empty lines and usage lines
    if (!started) {
      if (!trimmed) continue;
      if (trimmed.startsWith("Usage:") || trimmed.startsWith("usage:")) continue;
      if (trimmed.match(/^[\w-]+\s+\[/)) continue; // "tool [options]"
      started = true;
    }

    if (started) {
      if (!trimmed) break; // End of first paragraph
      if (trimmed.startsWith("-")) break; // Start of options
      if (trimmed.startsWith("Options:")) break;
      if (trimmed.startsWith("Commands:")) break;
      descLines.push(trimmed);
    }
  }

  return descLines.join(" ").slice(0, 300);
}

/** Build tags from command structure */
function buildTags(cmd: ACliCommand): string[] {
  const tags = new Set<string>();

  // Add subcommand names as tags
  for (const sub of cmd.subcommands.slice(0, 10)) {
    const name = sub.command[sub.command.length - 1];
    if (name && name.length > 2) tags.add(name);
  }

  // Add key flag indicators
  for (const flag of cmd.named) {
    for (const syn of flag.synonyms) {
      if (syn === "--json") tags.add("json");
      if (syn === "--verbose") tags.add("verbose");
      if (syn === "--output" || syn === "-o") tags.add("output");
      if (syn === "--recursive" || syn === "-r" || syn === "-R") tags.add("recursive");
    }
  }

  return Array.from(tags).slice(0, 10);
}

/** Infer categories from tool name and description */
function inferCategories(name: string, description: string, tags: string[]): string[] {
  const desc = description.toLowerCase();
  const cats: string[] = [];

  if (desc.includes("git") || name.startsWith("git")) cats.push("version-control");
  if (desc.includes("docker") || desc.includes("container")) cats.push("container");
  if (desc.includes("test") || desc.includes("spec")) cats.push("testing");
  if (desc.includes("build") || desc.includes("compile")) cats.push("build");
  if (desc.includes("lint") || desc.includes("format")) cats.push("development");
  if (desc.includes("network") || desc.includes("http") || desc.includes("curl")) cats.push("network");
  if (desc.includes("file") || desc.includes("directory")) cats.push("file");
  if (desc.includes("process") || desc.includes("daemon")) cats.push("process");
  if (desc.includes("search") || desc.includes("find") || desc.includes("grep")) cats.push("search");
  if (desc.includes("json") || desc.includes("csv") || desc.includes("data")) cats.push("data");
  if (desc.includes("database") || desc.includes("sql")) cats.push("database");
  if (desc.includes("monitor") || desc.includes("metric")) cats.push("monitoring");
  if (desc.includes("security") || desc.includes("encrypt") || desc.includes("auth")) cats.push("security");
  if (desc.includes("shell") || desc.includes("terminal")) cats.push("shell");
  if (desc.includes("text") || desc.includes("string")) cats.push("text");
  if (desc.includes("package") || desc.includes("install")) cats.push("package");
  if (desc.includes("cloud") || desc.includes("aws") || desc.includes("gcp")) cats.push("cloud");

  return cats.length > 0 ? cats.slice(0, 3) : ["development"];
}

// ─── Generic --help Parser ───

interface ParsedHelp {
  description: string;
  subcommands: Subcommand[];
  flags: Array<{ name: string; short?: string; description: string }>;
}

/**
 * Parse generic --help output into structured data.
 * Works with common CLI frameworks: commander, yargs, clap, cobra, argparse, click.
 */
export function parseHelpOutput(helpText: string): ParsedHelp {
  const lines = helpText.split("\n");
  const description = extractDescription(helpText);
  const subcommands: Subcommand[] = [];
  const flags: Array<{ name: string; short?: string; description: string }> = [];

  let section: "none" | "commands" | "options" = "none";

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect sections
    if (/^(Commands|COMMANDS|Subcommands|SUBCOMMANDS):/i.test(trimmed)) {
      section = "commands";
      continue;
    }
    if (/^(Options|OPTIONS|Flags|FLAGS|Arguments|ARGUMENTS):/i.test(trimmed)) {
      section = "options";
      continue;
    }
    // Empty line may end a section
    if (!trimmed) {
      continue;
    }

    // Parse commands section
    if (section === "commands") {
      const cmdMatch = trimmed.match(/^(\S+)\s{2,}(.+)/);
      if (cmdMatch) {
        subcommands.push({
          name: cmdMatch[1],
          description: cmdMatch[2].trim(),
        });
      }
    }

    // Parse options section
    if (section === "options") {
      const flagMatch = trimmed.match(
        /^(-\w),?\s*(--[\w-]+)(?:\s+\S+)?\s{2,}(.+)/,
      );
      if (flagMatch) {
        flags.push({
          short: flagMatch[1],
          name: flagMatch[2],
          description: flagMatch[3].trim(),
        });
        continue;
      }
      const longFlagMatch = trimmed.match(
        /^(--[\w-]+)(?:\s+\S+)?\s{2,}(.+)/,
      );
      if (longFlagMatch) {
        flags.push({
          name: longFlagMatch[1],
          description: longFlagMatch[2].trim(),
        });
      }
    }
  }

  return { description, subcommands, flags };
}

/**
 * Convert parsed --help output to ToolMetadata.
 */
export function helpToToolMetadata(
  toolName: string,
  helpText: string,
  installInfo?: { npm?: string; brew?: string; apt?: string; pip?: string },
): ToolMetadata {
  const parsed = parseHelpOutput(helpText);

  return {
    id: toolName,
    name: toolName,
    type: "cli",
    categories: inferCategories(toolName, parsed.description, []),
    tags: buildTagsFromHelp(parsed),
    description: parsed.description || toolName,
    install: {
      ...installInfo,
      check: `${toolName} --version`,
    },
    subcommands: parsed.subcommands.slice(0, 20),
    intents: [],
    source: "auto",
    updated_at: new Date().toISOString().slice(0, 10),
  };
}

/** Build tags from parsed help */
function buildTagsFromHelp(parsed: ParsedHelp): string[] {
  const tags = new Set<string>();
  for (const sub of parsed.subcommands.slice(0, 10)) {
    if (sub.name.length > 2) tags.add(sub.name);
  }
  return Array.from(tags).slice(0, 10);
}
