#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${1:-$HOME/.local/bin}"

if ! command -v bun &>/dev/null; then
    echo "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

mkdir -p "$INSTALL_DIR"
ln -sf "$SCRIPT_DIR/ai.ts" "$INSTALL_DIR/ai"
chmod +x "$SCRIPT_DIR/ai.ts"

echo "Installed: ai → $INSTALL_DIR/ai"
[[ ":$PATH:" != *":$INSTALL_DIR:"* ]] && echo "WARNING: Add to PATH: export PATH=\"$INSTALL_DIR:\$PATH\""
echo ""
echo "Set ANTHROPIC_API_KEY, then try:"
echo '  ai "top 5 disk usage"'
