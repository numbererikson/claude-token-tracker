# Claude Token Tracker

VSCode extension that tracks [Claude Code](https://claude.com/claude-code) token usage and cost in real time, with accurate per-model pricing.

## Features

- **Live status bar** — current session cost, weekly cost, % of plan limit
- **Per-model pricing** — Opus / Sonnet / Haiku 4.x families (plus legacy 3.x)
- **Full cache accounting** — 5-minute and 1-hour ephemeral cache tiers, cache reads
- **1M context tier** — automatic 2× pricing when input exceeds 200K tokens on a single call
- **`web_search` billing** — counts Anthropic server-side tool usage
- **Dashboard webview** — breakdown by model, session history, plan-limit progress
- **CSV export** — all sessions, all models
- **Calibration** — adjust local limits to match your Anthropic plan

## Install

### From `.vsix` (recommended)

1. Download the latest `.vsix` from [Releases](https://github.com/numbererikson/claude-token-tracker/releases)
2. In VSCode: `Ctrl+Shift+P` → `Extensions: Install from VSIX...` → pick the file
3. Reload VSCode

### From source

```bash
git clone https://github.com/numbererikson/claude-token-tracker.git
cd claude-token-tracker
npm install -g @vscode/vsce
vsce package
code --install-extension claude-token-tracker-*.vsix
```

## Usage

After install, status bar shows current cost. Commands (`Ctrl+Shift+P`):

| Command | What it does |
|---|---|
| `Claude Tokens: Dashboard` | Open full usage dashboard |
| `Claude Tokens: All Sessions` | List every session with cost breakdown |
| `Claude Tokens: Calibrate` | Adjust session/weekly limits to match your plan |
| `Claude Tokens: Export CSV` | Dump all sessions to CSV |
| `Claude Tokens: Refresh` | Force re-scan of session JSONL files |

## How it works

Reads Claude Code's local session files in `~/.claude/projects/**/*.jsonl` and computes cost using up-to-date Anthropic pricing. Everything is local — no telemetry, no network calls.

## License

MIT — see [LICENSE](LICENSE).
