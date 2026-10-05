# You should know

An on-demand private briefing for the Pi interactive TUI. Tested on Pi 1.0.2 and 1.0.3.

Try without installing or changing Pi settings:

```sh
pi --extension ./src/index.ts
```

Run `/ysk` to open a focused overlay immediately. Jev ranks recent active-branch evidence; GPT-6-Luna writes a concise briefing of discoveries, decisions, verification, limitations, unresolved work, and risks. Enter a follow-up question in the modal. Page Up, Page Down, or the mouse wheel scrolls the briefing and discussion. Escape cancels pending work and closes it.

There are no automatic scans, notifications, widgets, indicators, tools, or main-session messages. The extension does not change the active model, tools, thinking level, transcript, or model context. Non-TUI modes reject `/ysk` before provider calls.

## Install

Install from GitHub:

```sh
pi install git:github.com/dpaluy/pi-you-should-know
```

Or install a local checkout:

```sh
pi install /absolute/path/to/pi-you-should-know
```

Run `/reload` in an existing Pi session, or restart Pi. Then enter `/ysk`. Loading the extension alone does not open the modal. An empty session shows an empty-state message.

## Personal configuration

The optional `<agent-dir>/you-should-know.json` file is read on every open. Pi's `getAgentDir()` respects `PI_CODING_AGENT_DIR`; normally this is `~/.pi/agent`.

```json
{
  "rankModel": "typesafe/jev-latest",
  "chatModel": "openai/gpt-6-luna"
}
```

Missing fields use these defaults. If you use OpenAI Codex OAuth instead of an OpenAI API key, set `chatModel` to `openai-codex/gpt-6-luna`. Jev needs TypeSafe credentials configured in Pi. The active main-session model is not a fallback.

IDs must be exact `provider/model-id` identities. Pi's native model registry, credentials, and provider routing are used. Invalid settings, unavailable models, authentication failures, and provider errors appear only inside the modal. There is no fallback or automatic retry.

## Evidence and private state

Evidence is an immutable snapshot of the active branch, bounded to 12 recent request groups and 24,000 serialized characters. It includes user text, assistant text, and tool-result text with source identities and result status. Thinking, images, custom entries, and abandoned branches are excluded. Omitted context is reported. Luna receives the full bounded evidence, not just high-priority groups.

Follow-ups use the same snapshot and Luna model, even while the main agent continues. Reopen to include new output. Only completed exchanges enter the private discussion, bounded to the latest four exchanges with 8,000 characters per turn. Busy submissions cannot queue duplicate calls.

Only the latest completed briefing and discussion are retained in process memory. Reopening unchanged session, branch, evidence, and model settings reuses them without provider calls. Changed evidence or settings generates a replacement and resets discussion after success. A failed replacement shows an error, not an old briefing as current. The prior same-session, uninterrupted-branch briefing may guide novelty. Session/branch switches and shutdown cancel requests and clear private state. Closing invalidates late updates. Each operation has a total 40-second deadline, even if a provider ignores abort.

Invoking `/ysk` sends bounded session text to the configured providers. Session text can contain secrets; no guaranteed redaction is claimed. Private state is not persisted to disk or included in Pi's main-session usage totals.

## Validation

```sh
npm run check
npm test
```

Tests use local provider fixtures, the actual Pi extension loader, native message conversion and classifier transport, and native TUI components. Run `npm run test:native` on macOS or Linux with Python 3 to check package discovery and the real Pi TUI in a disposable terminal. This offline check covers streaming, scrolling, repeated follow-ups, cache reuse, cancellation, and an unchanged main session file.

To test your installed Pi executable and model configuration without provider calls:

```sh
YSK_TEST_PI="$(command -v pi)" \
YSK_TEST_CONFIG="$HOME/.pi/agent/you-should-know.json" \
npm run test:native
```

Omit `YSK_TEST_CONFIG` to test the extension's defaults. Credentials and other user resources are not copied into the test environment.

Paid model quality and account availability require separately authorized live validation. RPC, print, JSON interfaces, private disk history, and main-agent injection are outside scope.
