/**
 * Local CLI import — harvest ToolMetadata from the current environment.
 *
 * For each candidate tool:
 *   1. Check if it is on $PATH (via `command -v`)
 *   2. Run `<tool> --help` (and fall back to `-h`, `help`) with a short timeout
 *   3. Parse the help text via aclimatise.parseHelpOutput()
 *   4. Generate ToolMetadata and append to tool-registry/data/auto/generated.jsonl
 *
 * Built-in tools already defined in tool-registry/data/builtin/ are skipped by
 * default — builtin definitions are hand-curated and higher quality.
 *
 * Usage:
 *   npx tsx auto-knowledge/import-local.ts [--limit N] [--include-builtin]
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { helpToToolMetadata } from "./aclimatise.js";
import type { ToolMetadata } from "../tool-registry/schema.js";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BUILTIN_DIR = join(REPO_ROOT, "tool-registry", "data", "builtin");
const AUTO_DIR = join(REPO_ROOT, "tool-registry", "data", "auto");
const OUTPUT_FILE = join(AUTO_DIR, "generated.jsonl");

// ─── Candidate list ───────────────────────────────────────────────────────
// Common CLI tools that tend to exist across Linux/macOS installations.
// This is the set we try to harvest from the local environment. Tools that
// are missing are silently skipped. Tools with `--help` quirks may fail to
// parse — those are logged and skipped.
//
// Exclusions: tools whose name collides with a common English or Japanese
// keyword are omitted because their auto-generated ToolMetadata ends up
// out-ranking the correct builtin tool on benchmark queries. Known
// offenders from 527-case regression: ip ("IP address"), dd ("YYYYMMDD"),
// pr ("presentation"), gawk, bash, perl, nano, ed, vim, yes, true, false,
// factor, ar. These are still discoverable via their direct name when
// builtin — this list just skips the auto path for them.
const CANDIDATES = [
  // Compression / archiving
  "bzip2", "xz", "zstd", "lz4", "unzip", "gunzip", "zcat",
  // Text processing
  "column", "expand", "unexpand", "fold", "fmt", "paste", "rev",
  "shuf", "split", "tsort", "comm", "join", "csplit",
  // System info
  "uptime", "who", "lastlog", "loginctl", "hostnamectl", "timedatectl",
  "localectl", "lscpu", "lsblk", "lsusb", "lspci", "lsmem", "lshw", "dmidecode",
  "pmap", "pidof", "pgrep", "pkill", "runlevel", "fuser",
  // Disk / filesystem
  "fdisk", "sfdisk", "parted", "mkfs", "fsck", "blkid", "findmnt", "mount",
  "umount", "swapon", "swapoff", "tune2fs", "badblocks", "hdparm",
  "smartctl",
  // Network
  "ifconfig", "arping", "ethtool",
  "nslookup", "ipcalc", "mtr", "socat",
  // Memory / performance
  "vmstat", "mpstat", "pidstat", "sar", "perf", "numactl",
  // Misc utilities
  "bc", "dc", "expect", "watch", "tree", "tac", "shred",
  "cal", "units", "printf",
  // Dev tools
  "autoconf", "automake", "libtool", "pkg-config", "ccache", "distcc",
  "strace", "ltrace", "gdb", "objdump", "readelf", "strip",
  "ldd", "stat", "nohup", "timeout", "setsid", "chrt",
  "nice", "ionice", "taskset",
  // Package managers
  "dpkg-query", "dpkg-deb", "apt-get", "apt-cache", "rpm", "yum",
  "dnf", "pacman", "zypper", "snap", "flatpak",
  // Misc
  "parallel", "entr", "getopt", "tput", "stty", "clear",
  // Hashing / crypto
  "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum",
  "gpg", "gpgv",
  // Text editors / pagers
  "nvim", "emacs",
  // Other
  "xxd", "hexdump", "iconv", "uuidgen", "lsb_release", "hostname",
  "locale", "ncal",
];

// ─── Options ──────────────────────────────────────────────────────────────
interface Options {
  limit: number | null;
  includeBuiltin: boolean;
  verbose: boolean;
}

function parseArgs(): Options {
  const opts: Options = { limit: null, includeBuiltin: false, verbose: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--limit":
        opts.limit = Number(args[++i]);
        break;
      case "--include-builtin":
        opts.includeBuiltin = true;
        break;
      case "--verbose":
      case "-v":
        opts.verbose = true;
        break;
    }
  }
  return opts;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function loadBuiltinIds(): Promise<Set<string>> {
  try {
    const entries = await readdir(BUILTIN_DIR);
    return new Set(
      entries
        .filter((e) => e.endsWith(".json"))
        .map((e) => e.replace(/\.json$/, "")),
    );
  } catch {
    return new Set();
  }
}

async function commandExists(tool: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP("sh", ["-c", `command -v ${tool}`], {
      timeout: 2_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function runHelp(tool: string): Promise<string | null> {
  // Try a few conventional help invocations. Order matters: --help is most
  // common, then -h, then the "help" subcommand.
  const attempts: Array<string[]> = [
    ["--help"],
    ["-h"],
    ["help"],
  ];

  for (const args of attempts) {
    try {
      const { stdout, stderr } = await execFileP(tool, args, {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
      });
      const text = (stdout || stderr || "").trim();
      if (isHelpTextUseful(text)) return text;
    } catch (err) {
      // Many tools exit non-zero on --help; the error object still carries output.
      const e = err as { stdout?: string; stderr?: string };
      const text = ((e.stdout || "") + "\n" + (e.stderr || "")).trim();
      if (isHelpTextUseful(text)) return text;
    }
  }

  return null;
}

function isHelpTextUseful(text: string): boolean {
  if (!text) return false;
  if (text.length < 40) return false; // too short to be real help
  // Must contain at least one of: "Usage", "Options", "Commands", or a flag pattern
  if (/usage:|options:|commands:|-\w|--\w/i.test(text)) return true;
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();
  const builtinIds = await loadBuiltinIds();

  await mkdir(AUTO_DIR, { recursive: true });

  // Deduplicate candidates while preserving order.
  const seen = new Set<string>();
  const candidates = CANDIDATES.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  const generated: ToolMetadata[] = [];
  const skipped = {
    builtin: 0,
    missing: 0,
    noHelp: 0,
    parseEmpty: 0,
  };

  let processed = 0;

  for (const tool of candidates) {
    if (opts.limit !== null && generated.length >= opts.limit) break;

    if (!opts.includeBuiltin && builtinIds.has(tool)) {
      skipped.builtin++;
      continue;
    }

    const path = await commandExists(tool);
    if (!path) {
      skipped.missing++;
      continue;
    }

    const helpText = await runHelp(tool);
    if (!helpText) {
      skipped.noHelp++;
      if (opts.verbose) console.log(`[no-help] ${tool}`);
      continue;
    }

    const meta = helpToToolMetadata(tool, helpText);

    // Quality gate: reject if description is empty AND no subcommands AND no intents
    if (
      meta.description === tool &&
      meta.subcommands.length === 0 &&
      meta.intents.length <= 2
    ) {
      skipped.parseEmpty++;
      if (opts.verbose) console.log(`[parse-empty] ${tool}`);
      continue;
    }

    generated.push(meta);
    processed++;
    if (opts.verbose) {
      console.log(
        `[ok] ${tool} — ${meta.description.slice(0, 60)} (${meta.subcommands.length} subs)`,
      );
    } else {
      process.stdout.write(".");
    }
  }

  if (!opts.verbose) process.stdout.write("\n");

  // Write JSONL (one object per line)
  const jsonl = generated.map((m) => JSON.stringify(m)).join("\n") + "\n";
  await writeFile(OUTPUT_FILE, jsonl, "utf-8");

  // Report
  console.log("\n── Import Summary ──");
  console.log(`  Generated: ${generated.length}`);
  console.log(`  Skipped (builtin):    ${skipped.builtin}`);
  console.log(`  Skipped (missing):    ${skipped.missing}`);
  console.log(`  Skipped (no help):    ${skipped.noHelp}`);
  console.log(`  Skipped (parse empty): ${skipped.parseEmpty}`);
  console.log(`  Candidates total:     ${candidates.length}`);
  console.log(`  Output: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
