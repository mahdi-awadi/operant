#!/usr/bin/env bash
# Operant installer — gold standard one-liner install
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/mahdi-awadi/operant/main/install.sh | bash
# Or:
#   ./install.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Config
REPO="mahdi-awadi/operant"
INSTALL_DIR="${OPERANT_DIR:-$HOME/.operant}"
CONFIG_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/channels/hub}"
CLAUDE_CONFIG="$HOME/.claude.json"

log() { echo -e "${BLUE}==>${NC} ${BOLD}$*${NC}"; }
ok()  { echo -e "${GREEN}✓${NC} $*"; }
warn(){ echo -e "${YELLOW}⚠${NC} $*"; }
err() { echo -e "${RED}✗${NC} $*" >&2; }
die() { err "$*"; exit 1; }

# ─── Header ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Operant Installer${NC}"
echo "Multi-session channel plugin for Claude Code"
echo ""

# ─── Prerequisites ───────────────────────────────────────────────────────────
log "Checking prerequisites"

# 1. Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)  PLATFORM=linux ;;
  Darwin*) PLATFORM=macos ;;
  *)       die "Unsupported OS: $OS (supported: Linux, macOS)" ;;
esac
ok "Platform: $PLATFORM"

# 2. Check git
if ! command -v git >/dev/null 2>&1; then
  die "git is required but not installed. Install it first: https://git-scm.com"
fi
ok "git: $(git --version | head -1)"

# 3. Check/install Bun
if ! command -v bun >/dev/null 2>&1; then
  warn "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    die "Bun install failed. Install manually: https://bun.sh"
  fi
fi
ok "bun: $(bun --version)"

# 4. Check tmux (required for daemon and session management)
if ! command -v tmux >/dev/null 2>&1; then
  err "tmux is required but not installed."
  echo "  Install: apt install tmux  (Debian/Ubuntu)"
  echo "           dnf install tmux  (RHEL/Fedora)"
  echo "           brew install tmux (macOS)"
  die "Please install tmux and re-run"
fi
ok "tmux: $(tmux -V)"

# 5. Check Claude Code
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code CLI not found. Install from: https://claude.ai/code"
  echo "  (You can still install Operant; set up Claude later)"
fi

# 6. Check jq (optional, used for config edits)
HAVE_JQ=0
if command -v jq >/dev/null 2>&1; then
  HAVE_JQ=1
  ok "jq: $(jq --version)"
else
  warn "jq not found (recommended for automatic config updates)"
fi

echo ""

# ─── Clone / Update ──────────────────────────────────────────────────────────
log "Installing Operant to $INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  ok "Existing install found, updating..."
  git -C "$INSTALL_DIR" pull --ff-only || warn "Could not update (local changes?)"
else
  git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# ─── Install Dependencies ────────────────────────────────────────────────────
log "Installing dependencies"
cd "$INSTALL_DIR"
bun install --no-summary
ok "Dependencies installed"

# ─── Create Config ───────────────────────────────────────────────────────────
log "Setting up config"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"

if [ -f "$CONFIG_DIR/config.json" ]; then
  ok "Config already exists at $CONFIG_DIR/config.json"
else
  cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "webPort": 3000,
  "telegramToken": "",
  "telegramAllowFrom": [],
  "defaultTrust": "ask",
  "defaultUploadDir": "."
}
EOF
  chmod 600 "$CONFIG_DIR/config.json"
  ok "Created config template at $CONFIG_DIR/config.json"
fi

# ─── Register MCP Server in ~/.claude.json ───────────────────────────────────
log "Registering MCP server"
if [ ! -f "$CLAUDE_CONFIG" ]; then
  warn "$CLAUDE_CONFIG not found — Claude Code may not be set up yet"
  echo "  After installing Claude Code, add this to $CLAUDE_CONFIG manually:"
  echo ""
  cat << EOF
  {
    "mcpServers": {
      "hub": {
        "command": "bun",
        "args": ["run", "$INSTALL_DIR/src/shim.ts"]
      }
    }
  }
EOF
elif [ "$HAVE_JQ" = "1" ]; then
  # Idempotent update using jq
  TMP=$(mktemp)
  jq --arg path "$INSTALL_DIR/src/shim.ts" \
    '.mcpServers = (.mcpServers // {}) | .mcpServers.hub = {"command": "bun", "args": ["run", $path]}' \
    "$CLAUDE_CONFIG" > "$TMP"
  mv "$TMP" "$CLAUDE_CONFIG"
  ok "Added hub MCP server to $CLAUDE_CONFIG"
else
  warn "Install jq to automatically update $CLAUDE_CONFIG"
  echo "  Or add this manually to the mcpServers section:"
  echo ""
  cat << EOF
  "hub": {
    "command": "bun",
    "args": ["run", "$INSTALL_DIR/src/shim.ts"]
  }
EOF
fi

# ─── Install CLI ─────────────────────────────────────────────────────────────
log "Installing operant command"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/operant" << EOF
#!/usr/bin/env bash
# Operant CLI wrapper
INSTALL_DIR="$INSTALL_DIR"

case "\${1:-}" in
  start)
    tmux kill-session -t hub-daemon 2>/dev/null || true
    tmux new-session -d -s hub-daemon "bun run \$INSTALL_DIR/src/daemon.ts"
    echo "Operant daemon started (tmux session: hub-daemon)"
    ;;
  stop)
    tmux kill-session -t hub-daemon 2>/dev/null && echo "Stopped" || echo "Not running"
    ;;
  restart)
    "\$0" stop
    sleep 1
    "\$0" start
    ;;
  status)
    if tmux has-session -t hub-daemon 2>/dev/null; then
      echo "Running (tmux session: hub-daemon)"
      tmux list-sessions | grep hub-
    else
      echo "Not running"
    fi
    ;;
  attach)
    tmux attach -t hub-daemon
    ;;
  logs)
    tmux capture-pane -t hub-daemon -p
    ;;
  update)
    cd "\$INSTALL_DIR" && git pull && bun install --no-summary
    echo "Updated. Run 'operant restart' to apply."
    ;;
  *)
    # Pass through to the hub CLI tool
    HUB_URL="\${HUB_URL:-http://localhost:3000}" bun run "\$INSTALL_DIR/src/cli.ts" "\$@"
    ;;
esac
EOF
chmod +x "$BIN_DIR/operant"
ok "Installed: $BIN_DIR/operant"

# Check if BIN_DIR is in PATH
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  warn "$BIN_DIR is not in your PATH"
  echo "  Add this to your shell config (~/.bashrc or ~/.zshrc):"
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ Operant installed successfully${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo ""
echo "  1. Configure your Telegram bot (optional):"
echo "     - Create a bot with @BotFather on Telegram"
echo "     - Get your user ID from @userinfobot"
echo "     - Edit: $CONFIG_DIR/config.json"
echo ""
echo "  2. Start the daemon:"
echo "     ${BLUE}operant start${NC}"
echo ""
echo "  3. Connect Claude Code (from any project):"
echo "     ${BLUE}claude --dangerously-load-development-channels server:hub${NC}"
echo ""
echo "  4. Open the web dashboard:"
echo "     ${BLUE}http://localhost:3000${NC}"
echo ""
echo -e "${BOLD}Commands:${NC}"
echo "  operant start    # Start daemon"
echo "  operant stop     # Stop daemon"
echo "  operant status   # Check status"
echo "  operant attach   # View daemon logs"
echo "  operant update   # Update to latest"
echo "  operant list     # List sessions"
echo ""
echo "Documentation: https://github.com/$REPO"
