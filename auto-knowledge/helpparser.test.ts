import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDescription,
  helpToToolMetadata,
  parseHelpOutput,
} from "./helpparser.js";

// ─── Sample help texts ────────────────────────────────────────────────────

/** A GNU-style tool with a classic usage line, description, and options */
const BZIP2_HELP = `bzip2, a block-sorting file compressor.  Version 1.0.8, 13-Jul-2019.

   usage: bzip2 [flags and input files in any order]

   -h --help           print this message
   -d --decompress     force decompression
   -z --compress       force compression
   -k --keep           keep (don't delete) input files
   -f --force          overwrite existing output files
   -t --test           test compressed file integrity
   -c --stdout         output to standard out
   -q --quiet          suppress noncritical error messages
   -v --verbose        be verbose (a 2nd -v gives more)
   -L --license        display software version & license
   -V --version        display software version & license
   -s --small          use less memory (at most 2500k)
`;

/** A commander/yargs-style tool with a Commands section */
const COMMANDER_HELP = `Usage: myapp [options] [command]

A demo CLI tool for testing the parser

Options:
  -V, --version                output the version number
  -c, --config <path>          config file path
  -h, --help                   display help for command

Commands:
  init                         initialize a new project
  build                        build the current project
  deploy [environment]         deploy to a target environment
  help [command]               display help for command
`;

/** A cobra/go-style tool with Available Commands and Flags */
const COBRA_HELP = `A fast static site generator.

Usage:
  hugo [command]

Available Commands:
  config      Print the site configuration
  convert     Convert your content to different formats
  new         Create new content for your site
  server      A high performance webserver
  version     Print the version number of Hugo

Flags:
  -h, --help                help for hugo
  -D, --buildDrafts         include content marked as draft
  -s, --source <DIR>        filesystem path to read files relative from
  -v, --verbose             verbose output

Use "hugo [command] --help" for more information about a command.
`;

// ─── parseHelpOutput ──────────────────────────────────────────────────────

describe("parseHelpOutput — bzip2-style", () => {
  const parsed = parseHelpOutput(BZIP2_HELP);

  it("extracts description from the header line", () => {
    assert.ok(parsed.description.length > 0);
    assert.ok(/block-sorting file compressor/i.test(parsed.description));
  });

  it("finds no subcommands (bzip2 has none)", () => {
    assert.equal(parsed.subcommands.length, 0);
  });
});

describe("parseHelpOutput — commander/yargs-style", () => {
  const parsed = parseHelpOutput(COMMANDER_HELP);

  it("extracts the description between usage and Options", () => {
    assert.ok(/demo CLI tool/i.test(parsed.description));
  });

  it("parses all 4 subcommands", () => {
    const names = parsed.subcommands.map((s) => s.name).sort();
    assert.deepEqual(names, ["build", "deploy", "help", "init"]);
  });

  it("parses short + long flags with arguments", () => {
    const config = parsed.flags.find((f) => f.name === "--config");
    assert.ok(config);
    assert.equal(config!.short, "-c");
  });
});

describe("parseHelpOutput — cobra-style", () => {
  const parsed = parseHelpOutput(COBRA_HELP);

  it("extracts description from the first line", () => {
    assert.ok(/static site generator/i.test(parsed.description));
  });

  it("parses Available Commands section", () => {
    const names = parsed.subcommands.map((s) => s.name);
    assert.ok(names.includes("config"));
    assert.ok(names.includes("server"));
    assert.ok(names.includes("version"));
  });

  it("parses Flags section", () => {
    const verbose = parsed.flags.find((f) => f.name === "--verbose");
    assert.ok(verbose);
  });
});

// ─── extractDescription ───────────────────────────────────────────────────

describe("extractDescription", () => {
  it("skips Usage lines", () => {
    const desc = extractDescription(
      "Usage: cat [OPTIONS] [FILE...]\n\nConcatenate FILEs to standard output.\n\nOptions:\n  -n   number output\n",
    );
    assert.equal(desc, "Concatenate FILEs to standard output.");
  });

  it("handles empty input", () => {
    assert.equal(extractDescription(""), "");
  });

  it("caps description length", () => {
    const longText = "a".repeat(500);
    const desc = extractDescription(longText);
    assert.ok(desc.length <= 300);
  });
});

// ─── helpToToolMetadata ───────────────────────────────────────────────────

describe("helpToToolMetadata", () => {
  it("produces a valid ToolMetadata object", () => {
    const meta = helpToToolMetadata("hugo", COBRA_HELP);

    assert.equal(meta.id, "hugo");
    assert.equal(meta.name, "hugo");
    assert.equal(meta.type, "cli");
    assert.equal(meta.source, "auto");
    assert.ok(meta.description.length > 0);
    assert.ok(meta.categories.length > 0);
    assert.ok(meta.intents.length > 0);
    assert.ok(meta.subcommands.length > 0);
  });

  it("sets source='auto' for discovery/gating", () => {
    const meta = helpToToolMetadata("bzip2", BZIP2_HELP);
    assert.equal(meta.source, "auto");
  });

  it("generates intents that include the tool name", () => {
    const meta = helpToToolMetadata("bzip2", BZIP2_HELP);
    const allIntents = meta.intents.join(" ").toLowerCase();
    assert.ok(allIntents.includes("bzip2"));
  });

  it("infers reasonable categories from description", () => {
    // "block-sorting file compressor" → should land in archive or file
    const meta = helpToToolMetadata("bzip2", BZIP2_HELP);
    const hasRelevant = meta.categories.some((c) =>
      ["archive", "file"].includes(c),
    );
    assert.ok(
      hasRelevant,
      `expected archive or file category, got ${meta.categories.join(",")}`,
    );
  });
});
