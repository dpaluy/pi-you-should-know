# You should know

An on-demand private briefing for the Pi interactive TUI. Tested on Pi 1.0.2 and 1.0.3.

Version: **0.2.0**. See [CHANGELOG.md](CHANGELOG.md).

![You should know briefing and follow-up modal](https://raw.githubusercontent.com/dpaluy/pi-you-should-know/master/ysk-preview.png)

Run `/ysk` to open a focused overlay immediately. Jev ranks recent active-branch evidence; GPT-6-Luna writes a concise briefing of discoveries, decisions, verification, limitations, unresolved work, and risks. Enter a follow-up question in the modal. Page Up, Page Down, or the mouse wheel scrolls the briefing and discussion. Escape cancels pending work and closes it.

There are no automatic scans, notifications, widgets, indicators, tools, or main-session messages. The extension does not change the active model, tools, thinking level, transcript, or model context. Non-TUI modes reject `/ysk` before provider calls.

## Install

### 1. Check requirements

You need Pi and Node.js 22.19 or later. Git is required only for installation from GitHub. If Pi is not installed, follow the [Pi installation guide](https://github.com/earendil-works/pi#getting-started).

Check your Pi installation:

```sh
pi --version
```

### 2. Install the extension

Install with Pi:

```sh
pi install npm:pi-you-should-know
```

Or install from GitHub without npm:

```sh
pi install git:github.com/dpaluy/pi-you-should-know
```

These methods install for your user account, so Pi can load the extension in every project. Keep only one source installed to avoid duplicate commands. Confirm it appears in the package list:

```sh
pi list
```

### 3. Connect the model providers

If the providers are already configured, skip their login steps. Otherwise, start Pi:

```sh
pi
```

Inside Pi, run:

```text
/login typesafe
/login openai-codex
```

Enter your TypeSafe API key for Jev. Use the OpenAI Codex sign-in flow for Luna. Do not put credentials in this repository or in the extension's configuration file.

If you use an OpenAI API key instead of Codex OAuth, run `/login openai` instead of `/login openai-codex` and use the API model setting in the next step.

### 4. Load it and complete first-run setup

In an existing Pi session, run:

```text
/reload
/ysk
```

Or restart Pi and then run `/ysk`. To brief an existing conversation, resume it with `pi --continue` or `pi --resume` before running `/ysk`.

On the first `/ysk`, a setup wizard opens inside the modal:

1. Select a ranking model, usually `typesafe/jev-latest`.
2. Select a briefing and follow-up model. Use `openai-codex/gpt-6-luna` for Codex OAuth or `openai/gpt-6-luna` for an OpenAI API key.
3. Confirm **Save and generate briefing**.

Type to filter models, use the arrow keys to select, and press Enter to confirm each step. The extension creates `~/.pi/agent/you-should-know.json` automatically. No model calls run before confirmation. Escape cancels setup without saving. Setup also works in an empty session.

Existing configuration is kept, so later opens skip setup. If credentials are missing, the modal shows the required `/login` commands and keeps your saved model choices.

Loading the extension alone does not open the modal. A new, empty session shows “No session output to review.” With session output present, `/ysk` sends the bounded evidence to the configured providers and generates a briefing. Provider charges or subscription limits can apply.

Type a follow-up question in the modal and press Enter. Use Page Up, Page Down, or the mouse wheel to scroll. Press Escape to close.

## Personal configuration

First-run setup creates `<agent-dir>/you-should-know.json`; you do not need to create it manually. Pi reads it on every open. `PI_CODING_AGENT_DIR` controls the directory; normally it is `~/.pi/agent`.

For advanced configuration, you can edit the saved model IDs. Existing files are never overwritten by setup. Missing fields in an existing file use these defaults:

```json
{
  "rankModel": "typesafe/jev-latest",
  "chatModel": "openai/gpt-6-luna"
}
```

The active main-session model is not a fallback. Jev needs TypeSafe credentials configured in Pi.

IDs must be exact `provider/model-id` identities. Pi's native model registry, credentials, and provider routing are used. Invalid settings, unavailable models, authentication failures, and provider errors appear only inside the modal. There is no fallback or automatic retry.

## Evidence and private state

Evidence is an immutable snapshot of the active branch, bounded to 12 recent request groups and 24,000 serialized characters. It includes user text, assistant text, and tool-result text with source identities and result status. Thinking, images, custom entries, and abandoned branches are excluded. Omitted context is reported. Luna receives the full bounded evidence, not just high-priority groups.

Follow-ups use the same snapshot and Luna model, even while the main agent continues. Reopen to include new output. Only completed exchanges enter the private discussion, bounded to the latest four exchanges with 8,000 characters per turn. Busy submissions cannot queue duplicate calls.

Only the latest completed briefing and discussion are retained in process memory. Reopening unchanged session, branch, evidence, and model settings reuses them without provider calls. Changed evidence or settings generates a replacement and resets discussion after success. A failed replacement shows an error, not an old briefing as current. The prior same-session, uninterrupted-branch briefing may guide novelty. Session/branch switches and shutdown cancel requests and clear private state. Closing invalidates late updates. Each operation has a total 40-second deadline, even if a provider ignores abort.

Invoking `/ysk` sends bounded session text to the configured providers. Session text can contain secrets; no guaranteed redaction is claimed. Private state is not persisted to disk or included in Pi's main-session usage totals.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:native
```

Tests use local fixtures, with no paid provider calls. The native TUI check requires Python 3 on macOS or Linux.
