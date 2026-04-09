# ai-cli-bridge

MCP server that lets Claude Code access any CLI tool through natural language — with just one connection.

**Before**: 200+ MCP tools consuming 90K tokens per turn (41% of context window)
**After**: 3 tools consuming ~500 tokens (99.4% reduction)

## Quick Start

```bash
# Connect to Claude Code (one command)
claude mcp add ai-cli -- npx -y ai-cli-bridge
```

That's it. Claude Code now has access to all tools in the ai-cli registry through natural language.

## How It Works

```
Claude Code ──→ ai-cli-bridge (3 MCP tools) ──→ ai-cli-engine
                                                      │
                                               semantic search
                                                      │
                                               20+ CLI tools
                                            (git, docker, curl, jq, ...)
```

Instead of loading 200+ tool definitions into Claude Code's context, ai-cli-bridge exposes just 3 tools:

| Tool | Purpose |
|------|---------|
| `ai_run` | Execute any task using natural language |
| `ai_discover` | Find available tools without executing |
| `ai_catalog` | Browse the tool catalog |

## Usage Examples

Once connected, Claude Code can use ai-cli naturally:

```
You: "Search for large files in this repo"
Claude Code → ai_run("search for large files") → discovers `find` → executes → returns results

You: "What tools can handle Docker?"
Claude Code → ai_discover("docker operations") → returns docker CLI with confidence score

You: "What tools are available?"
Claude Code → ai_catalog() → returns categorized tool list
```

## Manual Setup

If you prefer explicit configuration, add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "ai-cli": {
      "command": "npx",
      "args": ["-y", "ai-cli-bridge"]
    }
  }
}
```

## Requirements

- Node.js >= 20
- Claude Code

## License

MIT
