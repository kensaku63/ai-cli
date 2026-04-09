#!/usr/bin/env node
/**
 * ai-cli — Natural language → tool discovery → command → execute.
 *
 * MVP: Uses tool-registry to discover the best CLI tool for the user's intent,
 * then generates and executes the optimal command.
 */

import { parseArgs } from "node:util";
import { isatty } from "node:tty";
import { spawn } from "node:child_process";
import { Registry, searchTools } from "./tool-registry/index.js";
import type { SearchResult } from "./tool-registry/index.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function buildSystemPrompt(
  matches: SearchResult[],
  cwd: string,
  os: string,
): string {
  let toolSection: string;
  if (matches.length > 0) {
    const toolDescriptions = matches.map((m) => {
      const t = m.tool;
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
    toolSection = `Matched tools (use the most appropriate one):\n${toolDescriptions.join("\n\n")}`;
  } else {
    toolSection = "No specific tool matched. Use standard Linux/macOS commands.";
  }

  return `\
Output ONLY executable bash. No explanation, no markdown fences, no comments.
Catastrophic commands (rm -rf /, mkfs, dd to disk): output \`echo "REFUSED: <reason>" >&2; exit 1\`
Cap large output with \`head -n 50\`. Bound long-running commands with \`timeout\`.
CWD: ${cwd} | OS: ${os}

${toolSection}`;
}

async function ask(
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

/** Read all stdin data (non-blocking if no pipe) */
async function readStdin(): Promise<string> {
  if (isatty(0)) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** Run a shell command and capture output */
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
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

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

function printHelp(): void {
  console.log(`\
ai-cli — Natural language → tool discovery → command → execute

Usage:
  ai-cli INSTRUCTION...
  cat data.csv | ai-cli "aggregate by month"
  ai-cli --dry "list running docker containers"
  ai-cli --discover "compress a PDF"

Options:
  --dry          Show generated command without executing
  --show         Show command on stderr, then execute
  --discover     Only show discovered tools, don't execute
  --retry N      Max retries on failure (default: 2)
  -h, --help     Show this help

Environment:
  ANTHROPIC_API_KEY   API key (required for execution)
  AI_MODEL            Default model (default: claude-sonnet-4-6)
  AI_MAX_TOKENS       Default max tokens (default: 4096)`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dry:      { type: "boolean", default: false },
      show:     { type: "boolean", default: false },
      discover: { type: "boolean", default: false },
      retry:    { type: "string", default: "2" },
      help:     { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) { printHelp(); return; }

  const prompt = positionals.join(" ");
  if (!prompt) {
    console.error('Usage: ai-cli INSTRUCTION...\n  ai-cli "list running docker containers"');
    process.exit(1);
  }

  // 1. Load tool registry
  const registry = new Registry();
  await registry.loadBuiltin();

  // 2. Search for matching tools
  const matches = searchTools(prompt, registry.all(), { limit: 3 });

  // --discover mode: just show what tools were found
  if (values.discover) {
    if (matches.length === 0) {
      console.log("No matching tools found.");
    } else {
      console.log("Discovered tools:\n");
      for (const m of matches) {
        const installed = m.tool.install.check ?? "unknown";
        console.log(`  ${m.tool.name} (score: ${m.score.toFixed(2)}) — ${m.tool.description}`);
        console.log(`    matched: ${m.matchedOn.join(", ")}`);
        console.log(`    check: ${installed}\n`);
      }
    }
    return;
  }

  // 3. Generate and execute command
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const stdinData = await readStdin();

  let userMsg = "";
  if (stdinData) {
    const preview = stdinData.slice(0, 2000);
    userMsg += `Input data:\n${preview}${stdinData.length > 2000 ? `\n... (${stdinData.length} bytes total)` : ""}\n\n`;
  }
  userMsg += `Instruction: ${prompt}`;

  if (matches.length > 0 && values.show) {
    console.error(`[discovered: ${matches.map((m) => m.tool.name).join(", ")}]`);
  }

  const system = buildSystemPrompt(
    matches,
    process.cwd(),
    `${process.platform} ${process.arch}`,
  );

  type Message = { role: "user" | "assistant"; content: string };
  const messages: Message[] = [{ role: "user", content: userMsg }];
  const maxRetries = parseInt(values.retry!, 10);
  let code = await ask(apiKey, system, messages);

  if (values.dry) { console.log(code); return; }

  const isRefusal = /^echo\s+"REFUSED:/.test(code);
  if (isRefusal) {
    const proc = spawn("bash", ["-c", code], { stdio: "inherit" });
    proc.on("close", () => process.exit(1));
    return;
  }

  if (values.show) console.error(code);

  const timeoutMs = parseInt(process.env.AI_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS), 10);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runCommand(code, stdinData, timeoutMs);

    if (result === "timeout") {
      if (attempt >= maxRetries) {
        console.error(`Command timed out after ${timeoutMs / 1000}s. Last command:\n${code}`);
        process.exit(124);
      }
      if (values.show) console.error(`[timeout — retry ${attempt + 1}/${maxRetries}]`);
      messages.push(
        { role: "assistant", content: code },
        { role: "user", content: `Command timed out after ${timeoutMs / 1000}s. Generate a faster alternative. Output ONLY the corrected bash.` },
      );
      code = await ask(apiKey, system, messages);
      if (values.show) console.error(code);
      continue;
    }

    if (result.exitCode === 0) {
      process.stdout.write(result.stdout);
      return;
    }

    if (attempt >= maxRetries) {
      console.error(`Failed after ${maxRetries + 1} attempts.`);
      if (result.stderr) console.error(result.stderr);
      process.exit(result.exitCode || 1);
    }

    if (values.show) console.error(`[retry ${attempt + 1}/${maxRetries}]`);

    const mainCmd = code.split(/[\s|;&]/)[0];
    let helpText = "";
    try {
      const helpResult = await runCommand(`${mainCmd} --help 2>&1 | head -40`, "", 5000);
      if (helpResult !== "timeout") helpText = helpResult.stdout.trim();
    } catch {}

    let retryMsg = `Script failed (exit ${result.exitCode}):\nstdout: ${result.stdout.slice(0, 500)}\nstderr: ${result.stderr.slice(0, 500)}`;
    if (helpText) retryMsg += `\n\n${mainCmd} --help:\n${helpText}`;
    retryMsg += `\nFix it. Output ONLY the corrected bash.`;

    messages.push(
      { role: "assistant", content: code },
      { role: "user", content: retryMsg },
    );
    code = await ask(apiKey, system, messages);
    if (values.show) console.error(code);
  }
}

main();
