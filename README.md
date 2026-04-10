# ai-cli

**Natural language → shell command → execute.** One binary, zero config.

Type what you want in plain English (or any language). `ai` figures out the right command, runs it, and gives you the result.

```bash
$ ai "find all TODO comments in this project"
# → rg 'TODO' -n .

$ ai "compress all PNGs in this directory"
# → find . -name '*.png' -exec pngquant --force --ext .png {} +

$ cat data.csv | ai "aggregate sales by month"
# → awk -F',' 'NR>1{split($1,d,"-");m=d[1]"-"d[2];s[m]+=$2}END{for(k in s)print k,s[k]}' | sort
```

## Vision

> **AIの知性に、人類のソフトウェア全てを繋ぐ。**
> *Bridge AI's intelligence to all of humanity's software.*

The `bash` tool gave AI unlimited execution power. But AI only knows a few hundred of the millions of programs humanity has built — an utilization rate below **0.01%**. The ceiling is not intelligence. It is knowing **what tools exist and how to combine them**.

ai-cli closes that gap. It connects AI's reasoning to the entire universe of CLI programs, packages, and Unix composition — and exposes that power through plain language.

```
AI's intelligence
  × Humanity's software  (millions of programs)
  × Unix composition     (pipes, scripts)
  = The ability to solve any problem
```

### What ai-cli stands for

- **Essence** — *AIの知性に、人類のソフトウェア全てを繋ぐ* — Bridge AI's intelligence to all of humanity's software.
- **Experience** — *意図を伝えれば、最適なツールの組み合わせが動く* — Describe your intent; the optimal combination of tools runs itself.
- **Structure** — *Unix哲学の完成形 — 合成の力を、自然言語で解放する* — The Unix philosophy, completed: composition unleashed through natural language.
- **Speed** — *昨日公開されたCLIを、今日AIが使いこなす* — A CLI released yesterday is wielded by AI today — no retraining required.
- **Ecosystem** — *個人開発者のツールが、AIを介して数億人に届く* — A solo developer's tool reaches hundreds of millions through AI.

For the full adopted visions, hypotheses, and design principles, see [`docs/vision/`](docs/vision/).

## Why

Every developer has the same moment: you know *what* you want, but not the exact flags, syntax, or pipe chain to get there. You open a browser, search, scan Stack Overflow, copy-paste, tweak, retry.

`ai` removes that loop. Describe the task → get the result.

## Features

- **Pipe-friendly** — `cat log.txt | ai "extract unique IPs"` just works
- **Auto-retry** — if a command fails, `ai` reads the error and self-corrects (up to N retries)
- **Timeout-aware** — slow commands are killed and replaced with faster alternatives
- **Safety rails** — catastrophic commands (`rm -rf /`, `mkfs`, `dd`) are refused
- **Dry run** — preview the generated command with `--dry` before running
- **Custom commands** — register your own tools so the AI knows about them
- **Configurable** — swap models, adjust token limits, set timeouts via env vars

## Install

> Requires [Bun](https://bun.sh) and an [Anthropic API key](https://console.anthropic.com/).

```bash
git clone https://github.com/kensaku63/ai-cli.git
cd ai-cli
./setup.sh
```

This symlinks the `ai` command to `~/.local/bin/`. Pass a custom path if you prefer:

```bash
./setup.sh /usr/local/bin
```

Then set your API key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## Usage

```
ai INSTRUCTION...
```

### Examples

```bash
# System info
ai "what's eating my disk space"
ai "show memory usage by process"

# File operations
ai "rename all .jpeg files to .jpg"
ai "find files modified in the last hour"

# Git
ai "show commits from last week by author"
ai "diff stats for the current branch vs main"

# Data processing
cat access.log | ai "top 10 IPs by request count"
cat data.json | ai "extract all email addresses"

# Docker / Infra
ai "list running containers sorted by memory"
ai "kill all stopped containers"
```

### Options

| Flag | Description |
|------|-------------|
| `--dry` | Print the generated command without executing |
| `--show` | Print the command to stderr, then execute |
| `--retry N` | Max auto-retries on failure (default: `2`) |
| `-h, --help` | Show help |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required) |
| `AI_MODEL` | `claude-sonnet-4-6` | Model to use |
| `AI_MAX_TOKENS` | `4096` | Max response tokens |
| `AI_TIMEOUT` | `30000` | Command timeout in ms |

## Custom Commands

Teach `ai` about your own scripts and tools. Create `~/.config/ai-cli/commands.json`:

```json
[
  { "name": "deploy-staging", "description": "Deploy the current branch to the staging environment" },
  { "name": "db-backup", "description": "Dump the production database to ~/backups/" }
]
```

Now `ai "deploy to staging"` will know to use your `deploy-staging` command.

## How It Works

```
 "find large files"
        │
        ▼
┌───────────────┐     ┌──────────────┐     ┌──────────────┐
│  Claude API   │────▶│  bash -c ... │────▶│    stdout     │
│  (generate)   │     │  (execute)   │     │   (result)    │
└───────────────┘     └──────┬───────┘     └──────────────┘
                             │ fail?
                             ▼
                      ┌──────────────┐
                      │  read error  │
                      │  + --help    │──▶ retry with context
                      └──────────────┘
```

1. Your instruction is sent to the Claude API with system context (OS, cwd, custom commands)
2. The API returns raw bash — no markdown, no explanation
3. The command is executed. On success, stdout is printed
4. On failure, the error output (and `--help` of the failing command) is fed back to the API for a corrected attempt

## Safety

`ai` refuses to run destructive commands that could cause irreversible damage:

```bash
$ ai "wipe the disk"
# → REFUSED: destructive operation
```

Commands like `rm -rf /`, `mkfs`, and raw `dd` to disk are blocked at the prompt level. Large outputs are automatically capped with `head`.

## License

MIT
