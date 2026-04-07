#!/usr/bin/env bun
/**
 * ai — Natural language → optimal command → execute.
 */

import { parseArgs } from "node:util";
import { isatty } from "node:tty";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;

const SYSTEM_TEMPLATE = `\
Output ONLY executable bash. No explanation, no markdown fences, no comments.
Catastrophic commands (rm -rf /, mkfs, dd to disk): output \`echo "REFUSED: <reason>" >&2; exit 1\`
Cap large output with \`head -n 50\`. Bound long-running commands with \`timeout\`.
CWD: {cwd} | OS: {os}

Custom commands:
{commands}`;

type Message = { role: "user" | "assistant"; content: string };
type RegisteredCommand = { name: string; description: string };

const COMMANDS_PATH = join(homedir(), ".config", "ai-cli", "commands.json");

async function getRegisteredCommands(): Promise<RegisteredCommand[]> {
  try {
    const file = Bun.file(COMMANDS_PATH);
    if (!(await file.exists())) return [];
    return JSON.parse(await file.text());
  } catch {
    return [];
  }
}

function formatCommands(commands: RegisteredCommand[]): string {
  if (commands.length === 0) {
    return "No custom commands registered. Use standard Linux/macOS commands only.";
  }
  return commands.map((c) => `- ${c.name}: ${c.description}`).join("\n");
}

async function ask(
  apiKey: string,
  system: string,
  messages: Message[],
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

function printHelp(): void {
  console.log(`\
ai — Natural language → optimal command → execute

Usage:
  ai INSTRUCTION...
  cat data.csv | ai "aggregate by month"
  ai --dry "list running docker containers"

Options:
  --dry          Show generated command without executing
  --show         Show command on stderr, then execute
  --retry N      Max retries on failure (default: 2)
  -h, --help     Show this help

Environment:
  ANTHROPIC_API_KEY   API key (required)
  AI_MODEL            Default model (default: claude-sonnet-4-6)
  AI_MAX_TOKENS       Default max tokens (default: 4096)`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      dry:   { type: "boolean", default: false },
      show:  { type: "boolean", default: false },
      retry: { type: "string",  default: "2" },
      help:  { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) { printHelp(); return; }

  const prompt = positionals.join(" ");
  if (!prompt) {
    console.error('Usage: ai INSTRUCTION...\n  ai "top 5 disk usage"');
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  let stdinData = "";
  if (!isatty(0)) {
    stdinData = await Promise.race([
      Bun.file(0).text(),
      new Promise<string>((r) => setTimeout(() => r(""), 100)),
    ]);
  }

  let userMsg = "";
  if (stdinData) {
    const preview = stdinData.slice(0, 2000);
    userMsg += `Input data:\n${preview}${stdinData.length > 2000 ? `\n... (${stdinData.length} bytes total)` : ""}\n\n`;
  }
  userMsg += `Instruction: ${prompt}`;

  const commands = await getRegisteredCommands();
  const system = SYSTEM_TEMPLATE
    .replace("{commands}", formatCommands(commands))
    .replace("{cwd}", process.cwd())
    .replace("{os}", `${process.platform} ${process.arch}`);

  const messages: Message[] = [{ role: "user", content: userMsg }];
  const maxRetries = parseInt(values.retry!, 10);
  let code = await ask(apiKey, system, messages);

  if (values.dry) { console.log(code); return; }

  const isRefusal = /^echo\s+"(REFUSED:|This tool converts)/.test(code);
  if (isRefusal) {
    Bun.spawn(["bash", "-c", code], { stdout: "inherit", stderr: "inherit" });
    process.exit(1);
  }

  if (values.show) console.error(code);

  const timeoutMs = parseInt(process.env.AI_TIMEOUT ?? String(DEFAULT_TIMEOUT_MS), 10);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const proc = Bun.spawn(["bash", "-c", code], {
      stdin: stdinData ? new Response(stdinData) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
    const exited = proc.exited.then((c) => c as number);
    const race = await Promise.race([exited, timeout]);

    if (race === "timeout") {
      proc.kill();
      await proc.exited;
      if (attempt >= maxRetries) {
        console.error(`Command timed out after ${timeoutMs / 1000}s. Last command:\n${code}`);
        process.exit(124);
      }
      if (values.show) console.error(`[timeout — retry ${attempt + 1}/${maxRetries}]`);
      const retryMsg = `Command timed out after ${timeoutMs / 1000}s. It was too slow.\nGenerate a faster alternative. Output ONLY the corrected bash.`;
      messages.push(
        { role: "assistant", content: code },
        { role: "user", content: retryMsg },
      );
      code = await ask(apiKey, system, messages);
      if (values.show) console.error(code);
      continue;
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = race;

    if (exitCode === 0) {
      process.stdout.write(stdout);
      return;
    }

    if (attempt >= maxRetries) {
      console.error(`Failed after ${maxRetries + 1} attempts.`);
      if (stderr) console.error(stderr);
      process.exit(exitCode || 1);
    }

    if (values.show) console.error(`[retry ${attempt + 1}/${maxRetries}]`);

    const mainCmd = code.split(/[\s|;&]/)[0];
    let helpText = "";
    try {
      const helpProc = Bun.spawn(["bash", "-c", `${mainCmd} --help 2>&1 | head -40`], {
        stdout: "pipe", stderr: "pipe",
      });
      helpText = (await new Response(helpProc.stdout).text()).trim();
      await helpProc.exited;
    } catch {}

    let retryMsg = `Script failed (exit ${exitCode}):\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`;
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
