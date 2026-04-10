/**
 * aCLImatise-style Help Parser — Convert CLI --help output to ToolMetadata.
 *
 * Inspired by aCLImatise (github.com/aCLImatise/CliHelpParser), which uses
 * a PEG parser to extract structured information from --help text.
 *
 * This module implements an independent parser in pure TypeScript so we can
 * ingest any CLI that supports a conventional --help format, without taking
 * on the GPL v3 licensing of the aCLImatise BaseCamp data set.
 *
 * Target help formats: commander, yargs, clap, cobra, argparse, click,
 * GNU-style getopt, BSD-style.
 */

import type {
  InstallInfo,
  Subcommand,
  ToolMetadata,
} from "../tool-registry/schema.js";

// ─── Parsed Help ───

export interface ParsedFlag {
  /** Long form, e.g. "--output" */
  name: string;
  /** Short form, e.g. "-o" */
  short?: string;
  description: string;
  /** Argument name if any, e.g. "FILE" in "-o, --output FILE" */
  arg?: string;
}

export interface ParsedHelp {
  description: string;
  usage?: string;
  subcommands: Subcommand[];
  flags: ParsedFlag[];
}

// ─── Parser ───

/**
 * Parse generic --help output into structured data.
 * Handles common CLI conventions: Usage, Commands/Subcommands, Options/Flags.
 */
export function parseHelpOutput(helpText: string): ParsedHelp {
  const text = stripAnsi(helpText);
  const lines = text.split("\n");
  const description = extractDescription(text);
  const usage = extractUsage(text);
  const subcommands: Subcommand[] = [];
  const flags: ParsedFlag[] = [];

  let section: "none" | "commands" | "options" = "none";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Section headers (handle both "Commands:" and "COMMANDS")
    if (
      /^(Commands|COMMANDS|Subcommands|SUBCOMMANDS|Available Commands)\s*:?\s*$/i.test(
        trimmed,
      )
    ) {
      section = "commands";
      continue;
    }
    if (
      /^(Options|OPTIONS|Flags|FLAGS|Global Options|GLOBAL OPTIONS|Arguments|ARGUMENTS)\s*:?\s*$/i.test(
        trimmed,
      )
    ) {
      section = "options";
      continue;
    }

    if (!trimmed) continue;

    if (section === "commands") {
      const cmd = parseCommandLine(raw);
      if (cmd) subcommands.push(cmd);
    } else if (section === "options") {
      const flag = parseFlagLine(raw);
      if (flag) flags.push(flag);
    }
  }

  return { description, ...(usage ? { usage } : {}), subcommands, flags };
}

/** Strip ANSI color escape sequences from help output */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Extract a Usage: line if present */
function extractUsage(text: string): string | undefined {
  const match = text.match(/^[\s]*[Uu]sage:\s*(.+)$/m);
  return match ? match[1].trim() : undefined;
}

/**
 * Extract the first paragraph of prose description.
 * Skips Usage lines, command name lines, and stops at the next section.
 */
export function extractDescription(helpText: string): string {
  const text = stripAnsi(helpText);
  const lines = text.split("\n");
  const descLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!started) {
      if (!trimmed) continue;
      if (/^[Uu]sage:/i.test(trimmed)) continue;
      // Skip "toolname [OPTIONS]" style command name lines
      if (/^[\w./-]+\s+\[/.test(trimmed)) continue;
      // Skip version strings like "git version 2.39.2"
      if (/^\w+\s+version\s+[\d.]/.test(trimmed)) continue;
      started = true;
    }

    if (started) {
      if (!trimmed) break;
      if (
        /^(Options|Commands|Subcommands|Arguments|Flags|Global Options|Available Commands)\s*:/i.test(
          trimmed,
        )
      ) {
        break;
      }
      // Indented lines are usually sub-lists — stop collecting
      if (/^\s{2,}/.test(line) && descLines.length > 0) break;
      descLines.push(trimmed);
      if (descLines.join(" ").length > 280) break;
    }
  }

  return descLines.join(" ").slice(0, 300);
}

/**
 * Parse a single "Commands:" section line into a Subcommand.
 * Expected formats:
 *   "  commit                         Record changes"
 *   "  deploy [environment]           deploy to a target"
 *   "  checkout <branch>              switch branches"
 */
function parseCommandLine(raw: string): Subcommand | null {
  // Must be indented (commands are always indented under "Commands:")
  if (!/^\s{2,}/.test(raw)) return null;
  const trimmed = raw.trim();
  // Subcommand name optionally followed by one or more [arg] / <arg> placeholders,
  // then two-or-more spaces, then the description.
  const match = trimmed.match(
    /^([a-zA-Z][\w-]*)(?:\s+(?:\[[^\]]+\]|<[^>]+>))*\s{2,}(.+)$/,
  );
  if (!match) return null;
  const name = match[1];
  const description = match[2].trim();
  if (description.length < 3) return null;
  return { name, description: description.slice(0, 200) };
}

/**
 * Parse a flag/option line.
 * Handles common formats:
 *   -s, --long <ARG>      Description
 *   -s, --long <path>     Description
 *   --long-only=<arg>     Description
 *   -s                    Description
 *   -s, --long            Description
 */
function parseFlagLine(raw: string): ParsedFlag | null {
  if (!/^\s{2,}/.test(raw)) return null;
  const trimmed = raw.trim();

  // Argument placeholder: <something>, [something], =<something>, or a
  // bare UPPERCASE word following a space. Accept lower/upper.
  const argPattern = /(?:[=\s](?:<([^>]+)>|\[([^\]]+)\]|([A-Za-z_][\w-]*)))?/;

  // Short + long combined: -s, --long [arg]  Description
  const combinedRe = new RegExp(
    `^(-\\w),\\s*(--[\\w-]+)${argPattern.source}\\s{2,}(.+)$`,
  );
  const combined = trimmed.match(combinedRe);
  if (combined) {
    const arg = combined[3] || combined[4] || combined[5];
    return {
      short: combined[1],
      name: combined[2],
      ...(arg ? { arg } : {}),
      description: combined[6].trim().slice(0, 200),
    };
  }

  // Long only: --long [arg]  Description
  const longOnlyRe = new RegExp(
    `^(--[\\w-]+)${argPattern.source}\\s{2,}(.+)$`,
  );
  const longOnly = trimmed.match(longOnlyRe);
  if (longOnly) {
    const arg = longOnly[2] || longOnly[3] || longOnly[4];
    return {
      name: longOnly[1],
      ...(arg ? { arg } : {}),
      description: longOnly[5].trim().slice(0, 200),
    };
  }

  // Short only: -s [arg]  Description
  const shortOnlyRe = new RegExp(
    `^(-\\w)${argPattern.source}\\s{2,}(.+)$`,
  );
  const shortOnly = trimmed.match(shortOnlyRe);
  if (shortOnly) {
    const arg = shortOnly[2] || shortOnly[3] || shortOnly[4];
    return {
      name: shortOnly[1],
      short: shortOnly[1],
      ...(arg ? { arg } : {}),
      description: shortOnly[5].trim().slice(0, 200),
    };
  }

  return null;
}

// ─── ToolMetadata Generation ───

export interface HelpToMetadataOptions {
  /** Tool id/name to use (defaults to inferring from usage) */
  id?: string;
  /** Additional install hints */
  install?: Partial<InstallInfo>;
}

/**
 * Convert parsed --help output into a ToolMetadata entry.
 */
export function helpToToolMetadata(
  toolName: string,
  helpText: string,
  options: HelpToMetadataOptions = {},
): ToolMetadata {
  const parsed = parseHelpOutput(helpText);
  const subcommands = parsed.subcommands.slice(0, 20);
  const description = parsed.description || toolName;
  const categories = inferCategories(toolName, description);
  const tags = buildTags(toolName, parsed);
  const intents = generateIntents(toolName, description, subcommands);
  const install: InstallInfo = {
    ...inferInstallInfo(toolName),
    ...options.install,
  };

  return {
    id: options.id ?? toolName,
    name: toolName,
    type: "cli",
    categories,
    tags,
    description,
    install,
    subcommands,
    intents,
    source: "auto",
    updated_at: new Date().toISOString().slice(0, 10),
  };
}

// ─── Category inference ───

const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\bgit\b|version.?control|vcs|repository/i, category: "vcs" },
  { pattern: /\bdocker\b|container|podman|kubernetes|k8s\b/i, category: "container" },
  { pattern: /\btest|spec\b|assert|bench/i, category: "testing" },
  { pattern: /\bbuild\b|compile|make\b|linker/i, category: "build" },
  { pattern: /\blint|format|prettier|eslint/i, category: "development" },
  { pattern: /\bnetwork|http|curl|wget|dns|tcp\b|udp\b|ip\b|socket/i, category: "network" },
  { pattern: /\bfile|directory|path|copy|move|archive/i, category: "file" },
  { pattern: /\bprocess|daemon|service|systemd|pid\b/i, category: "process" },
  { pattern: /\bsearch|find\b|grep|locate|fuzzy/i, category: "search" },
  { pattern: /\bjson|csv|yaml|data|transform|parse/i, category: "data" },
  { pattern: /\bdatabase|sql|mysql|postgres|mongo|sqlite|redis/i, category: "database" },
  { pattern: /\bmonitor|metric|log\b|observe|trace/i, category: "monitoring" },
  { pattern: /\bsecurity|encrypt|decrypt|auth|cert|ssl|tls|crypto/i, category: "security" },
  { pattern: /\bshell|terminal|bash|zsh|tmux\b/i, category: "shell" },
  { pattern: /\btext|string|regex|stream/i, category: "text" },
  { pattern: /\bpackage|install|pip\b|npm\b|brew\b|cargo/i, category: "package" },
  { pattern: /\bcloud|aws|gcp|azure|deploy/i, category: "cloud" },
  { pattern: /\bimage|video|audio|media|pdf\b/i, category: "media" },
  { pattern: /\bcompress|archive|zip|tar\b|gzip/i, category: "archive" },
];

function inferCategories(name: string, description: string): string[] {
  const text = `${name} ${description}`.toLowerCase();
  const cats: string[] = [];

  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) {
      cats.push(rule.category);
      if (cats.length >= 3) break;
    }
  }

  return cats.length > 0 ? cats : ["development"];
}

// ─── Tag generation ───

function buildTags(toolName: string, parsed: ParsedHelp): string[] {
  const tags = new Set<string>();

  for (const sub of parsed.subcommands.slice(0, 10)) {
    if (sub.name.length > 2) tags.add(sub.name);
  }

  const flagNames = new Set(parsed.flags.map((f) => f.name));
  if (flagNames.has("--json")) tags.add("json");
  if (flagNames.has("--output")) tags.add("output");
  if (flagNames.has("--format")) tags.add("format");
  if (flagNames.has("--recursive")) tags.add("recursive");
  if (flagNames.has("--verbose")) tags.add("verbose");
  if (flagNames.has("--quiet")) tags.add("quiet");

  return Array.from(tags).slice(0, 10);
}

// ─── Intent generation ───

/**
 * Generate intents so the tool is discoverable via natural-language search.
 * Tools with empty intents score poorly in the current SearchEngine — this is
 * the single biggest lever for auto-generated tools to be found correctly.
 */
function generateIntents(
  toolName: string,
  description: string,
  subcommands: Subcommand[],
): string[] {
  const intents: string[] = [];

  if (description && description !== toolName) {
    // Keep the description itself as an intent (English prose)
    intents.push(description.slice(0, 120));

    const action = extractAction(description);
    if (action) intents.push(`${action} with ${toolName}`);
  }

  intents.push(`use ${toolName}`);
  intents.push(`run ${toolName}`);

  for (const sub of subcommands.slice(0, 8)) {
    intents.push(`${toolName} ${sub.name}`);
    if (sub.description && sub.description.length > 5) {
      intents.push(`${sub.description.toLowerCase()} (${toolName})`);
    }
  }

  // Deduplicate while preserving order
  return Array.from(new Set(intents)).slice(0, 15);
}

/**
 * Extract a verb-phrase action from a description, e.g.
 * "Command line tool for transferring data with URLs" -> "transferring data"
 */
function extractAction(description: string): string | null {
  const forMatch = description.match(
    /\bfor\s+(\w+(?:ing)?(?:\s+\w+){0,3})/i,
  );
  if (forMatch) return forMatch[1].toLowerCase();

  const toMatch = description.match(/\bto\s+(\w+(?:\s+\w+){0,3})/i);
  if (toMatch) return toMatch[1].toLowerCase();

  return null;
}

// ─── Install info ───

const KNOWN_INSTALL: Record<string, InstallInfo> = {
  bzip2: { brew: "bzip2", apt: "bzip2", check: "bzip2 --version" },
  xz: { brew: "xz", apt: "xz-utils", check: "xz --version" },
  zstd: { brew: "zstd", apt: "zstd", check: "zstd --version" },
  bc: { brew: "bc", apt: "bc", check: "bc --version" },
  expect: { brew: "expect", apt: "expect", check: "expect -v" },
  jp2a: { brew: "jp2a", apt: "jp2a", check: "jp2a --version" },
  qrencode: { brew: "qrencode", apt: "qrencode", check: "qrencode --version" },
  ncdu: { brew: "ncdu", apt: "ncdu", check: "ncdu --version" },
  glances: { brew: "glances", apt: "glances", check: "glances --version" },
  iftop: { apt: "iftop", brew: "iftop", check: "iftop -h" },
  iotop: { apt: "iotop", check: "iotop --version" },
  dstat: { apt: "dstat", check: "dstat --version" },
  mtr: { apt: "mtr-tiny", brew: "mtr", check: "mtr --version" },
  socat: { apt: "socat", brew: "socat", check: "socat -V" },
  ipcalc: { apt: "ipcalc", check: "ipcalc --version" },
  parallel: { apt: "parallel", brew: "parallel", check: "parallel --version" },
  entr: { apt: "entr", brew: "entr", check: "entr -v" },
  watch: { apt: "procps", check: "watch --version" },
  tree: { apt: "tree", brew: "tree", check: "tree --version" },
  unzip: { apt: "unzip", brew: "unzip", check: "unzip -v" },
  p7zip: { apt: "p7zip-full", brew: "p7zip", check: "7z i" },
  rar: { apt: "rar", check: "rar --help" },
  unrar: { apt: "unrar", check: "unrar --help" },
};

function inferInstallInfo(toolName: string): InstallInfo {
  if (KNOWN_INSTALL[toolName]) return { ...KNOWN_INSTALL[toolName] };
  return { check: `command -v ${toolName}` };
}
