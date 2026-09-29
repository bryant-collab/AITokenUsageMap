# AI Token Usage

Cross-platform Electron application for viewing token usage from supported AI coding tools. All log parsing stays on the local machine.

Supported sources:

- Codex session JSONL logs.
- GitHub Copilot Chat/agent debug JSONL logs from VS Code and Copilot CLI session JSONL logs.
- Claude Code local `/usage` aggregates and session transcript JSONL logs.

The application only shows sources that are present on the current machine. Each detected provider gets its own tab, and the cross-provider cost calculator has a separate tab so the interface stays focused.

For each detected source, the dashboard reports total, input, cached input, output, and reasoning tokens separately when those fields are present in local logs. It also includes a small "Why these numbers can mislead" disclosure for source-specific caveats such as local-only coverage, unofficial debug fields, cache accounting, log retention, and billing differences.

## Cost analysis

The Cost Calculator tab has a prominent total for all models in the selected date range. Enter a start and end date, or use the calendar buttons to pick them. The dashboard estimates cost from input, cached input, and output token rates and shows each model's share.

The Electron main process refreshes standard per-token rates from the official [OpenAI pricing](https://developers.openai.com/api/docs/pricing), [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), and [GitHub Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing) tables. It fetches OpenAI's documented Markdown page and the providers' Markdown pricing tables. Results are cached for six hours, and a verified built-in snapshot covers current models when those sites are unavailable. Unknown models can be filled in directly in the application with input, cached input, and output prices in USD per 1M tokens. Manual rates are remembered for the running application session and are cleared when the application exits.

The top controls let you set an optional monthly cost alert and choose manual scans or automatic scans at a configurable interval (60 minutes initially). The app displays an alert when the locally estimated cost since the first of the month reaches your limit; it never blocks requests. **Reset now** restarts the tracked amount from the current estimate. The alert resets automatically at the first of each month in the configured timezone. These preferences are saved locally for future app launches. A manual **Rescan** remains available in either mode.

Cost values and the monthly alert are local estimates. Subscription allowances, long-context requests, regional routing, batch discounts, cache writes, missing model rates, and provider-side billing adjustments can differ from the displayed standard per-token estimate. GitHub does not disclose the underlying model used by Copilot code review, so `codex-auto-review` cannot be assigned an official token rate.

## Development

Node.js 22 LTS is recommended for the Electron Forge 7 toolchain.

```bash
npm install
npm run dev
```

Electron opens the application window automatically. The renderer is sandboxed and communicates with the local scanner through a narrow, typed preload bridge; there is no localhost API server.

Useful commands:

```bash
npm test          # run unit tests
npm run typecheck # check TypeScript
npm run package   # create an unpacked application for this OS
npm run make      # create native distributables for this OS
```

Forge writes packages and installers beneath `out/`. Native distributables are built on their target operating systems:

- Windows: Squirrel Setup executable.
- macOS: DMG and ZIP application bundles.
- Linux: DEB and RPM packages.

The GitHub Actions `Desktop builds` workflow can build all three platforms manually or for version tags. Builds are unsigned until platform signing and macOS notarization credentials are configured.

By default, the scanner reads Codex logs from:

- Windows: `%USERPROFILE%\.codex\sessions` and `%USERPROFILE%\.codex\archived_sessions`
- macOS/Linux: `~/.codex/sessions` and `~/.codex/archived_sessions`

It reads GitHub Copilot usage from VS Code Copilot Chat debug logs and Copilot CLI session logs.

VS Code Copilot Chat debug logs are read from:

- Windows: `%APPDATA%\Code\User\workspaceStorage`, `%APPDATA%\Code - Insiders\User\workspaceStorage`, and `%APPDATA%\VSCodium\User\workspaceStorage`
- macOS: `~/Library/Application Support/Code/User/workspaceStorage`, `~/Library/Application Support/Code - Insiders/User/workspaceStorage`, and `~/Library/Application Support/VSCodium/User/workspaceStorage`
- Linux: `~/.config/Code/User/workspaceStorage`, `~/.config/Code - Insiders/User/workspaceStorage`, and `~/.config/VSCodium/User/workspaceStorage`

Copilot CLI session logs are read from:

- Windows: `%USERPROFILE%\.copilot\session-state`
- macOS/Linux: `~/.copilot/session-state`
- Any platform: the `session-state` directory under `COPILOT_HOME` when `COPILOT_HOME` is set

It reads Claude Code usage from:

- Windows: `%USERPROFILE%\.claude`
- macOS/Linux: `~/.claude`
- Any platform: `CLAUDE_CONFIG_DIR` when set

## Configuration

- `CODEX_HOME`: override the Codex home directory.
- `CODEX_USAGE_TZ`: override the timezone. Defaults to `America/Denver`.
- `COPILOT_HOME`: changes where Copilot CLI stores its config and session data. The dashboard follows this for CLI session logs.
- `COPILOT_USAGE_ROOTS`: override all GitHub Copilot roots, including VS Code workspace storage and Copilot CLI session-state roots. Use the platform path delimiter (`;` on Windows, `:` on macOS/Linux) for multiple roots.
- `CLAUDE_CONFIG_DIR`: override Claude Code's config/data directory. This matches Claude Code's own environment variable.
- `CLAUDE_USAGE_ROOTS`: override Claude Code usage roots. Use the platform path delimiter (`;` on Windows, `:` on macOS/Linux) for multiple roots.

Generated scanner cache data is stored beneath Electron's per-user application data directory, not beside the installed application. The cache contains parsed token metadata and can be safely rebuilt from the source logs.

## GitHub Copilot tracking

Copilot tracking is local and estimated. It reads VS Code Copilot Chat debug logs and Copilot CLI session logs after they have been written to disk; the dashboard does not need to be running while Copilot is used.

To produce logs with token fields, VS Code Copilot Chat debug file logging may need to be enabled:

1. Open VS Code.
2. Open the Command Palette with `Ctrl+Shift+P`.
3. Run `Preferences: Open Settings (UI)` or `Preferences: Open User Settings (JSON)`.
4. Add or update this setting:

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

5. Save the settings file and restart VS Code if Copilot logs do not appear after new chat or agent activity.

Copilot CLI does not need the VS Code debug-log setting. Current Copilot CLI versions persist local session data under `~/.copilot/session-state/` by default, or under `COPILOT_HOME/session-state/` when `COPILOT_HOME` is set. The dashboard reads completed CLI session aggregates from `events.jsonl` files, including the per-model usage that backs the CLI's `/usage` command. If you refresh while a Copilot CLI session is still active, subagent models may be absent or incomplete until the CLI writes its final `session.shutdown` aggregate. The dashboard intentionally avoids counting output-only active subagent messages because those records do not include complete input, cached input, or reasoning token totals. If you need standalone telemetry files outside this dashboard, Copilot CLI can also export OpenTelemetry JSONL by setting `COPILOT_OTEL_FILE_EXPORTER_PATH`, but that is not required for this dashboard.

After enabling VS Code logging or using Copilot CLI normally, run or rescan this dashboard. If no Copilot display appears, the dashboard did not find Copilot debug JSONL files with countable token events or Copilot CLI `session.shutdown` usage aggregates.

Accuracy guidance:

- High for captured local VS Code Copilot Chat/agent requests when debug logs include token fields, and for completed Copilot CLI sessions that still have local `events.jsonl` shutdown usage aggregates.
- Medium for a developer's total personal Copilot usage because completions, GitHub.com, other IDEs, remote environments, disabled logging, deleted sessions, and log rotation can be missed.
- Low for billing reconciliation because GitHub bills pooled overages in AI Credits with server-side pricing, entitlements, and adjustments.

## Claude Code tracking

Claude Code tracking is local and estimated. The scanner prefers `stats-cache.json`, the local aggregate cache used by Claude Code's `/usage` display, for daily totals. It also scans `projects/**/*.jsonl` transcript files for recent and session-level detail. When both sources cover the same Claude config root and date, aggregate `/usage` totals win so the dashboard does not double-count.

Claude transcript files are plaintext and may include prompts, file contents, command output, and secrets printed by tools. This dashboard only extracts timestamps, session IDs, model names, and token counts, but users should still treat the source directory as sensitive.

Accuracy guidance:

- Medium-high for local Claude Code `/usage` aggregates in `stats-cache.json` when present.
- Medium for a developer's total personal Claude Code usage because other machines, cloud sessions, disabled persistence, transcript cleanup, and alternate config directories can be missed.
- Low for billing reconciliation because local token and cost figures are estimates and provider billing uses server-side accounting.

## Notes

The Codex scanner streams rollout files and only parses session metadata, model context, and `token_count` events. Usage is counted from `last_token_usage` when present, with cumulative delta fallback for older records.

The GitHub Copilot scanner streams VS Code Copilot debug JSONL files and counts `llm_request` events with numeric token fields. It also scans Copilot CLI `session-state/**/events.jsonl` files and counts per-model `session.shutdown` usage aggregates, preferring per-request `assistant.usage` events if a future CLI version persists them. Active CLI child-agent records can mention their model before shutdown, but they are not counted until complete usage fields are available. These logs are unofficial local data, so field names and availability may change.

The Claude Code scanner reads `stats-cache.json` for aggregate daily totals and streams Claude transcript JSONL files for assistant messages with `message.usage` token fields. Transcript token fields are version-sensitive, so aggregate totals are preferred whenever both sources are available.
