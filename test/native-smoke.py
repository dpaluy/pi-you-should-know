"""Exercise the real Pi TUI with synthetic session text and offline local providers."""
import datetime
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parents[1]

FIXTURE = r'''
import { writeFile } from "node:fs/promises";
const calls = [];
export default function(pi) {
  globalThis.fetch = async () => { throw new Error("Network forbidden in native smoke fixture"); };
  pi.on("session_start", (_event, ctx) => {
    const save = () => writeFile(process.env.YSK_FIXTURE_METRICS, JSON.stringify(calls));
    ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true });
    ctx.modelRegistry.classify = async (_model, input, options) => {
      calls.push({ stage: "rank", questions: Object.keys(input.questions), retries: options.maxRetries });
      await save();
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(input.questions).map(id => [id, { type: "score", score: 3 }])) };
    };
    ctx.modelRegistry.streamSimple = (_model, context) => {
      const payload = JSON.parse(context.messages[0].content);
      const count = calls.filter(call => call.stage === "chat").length;
      const slow = payload.question === "slow";
      const text = slow ? "LATE CANCELLED OUTPUT" : count === 0
        ? "- BRIEFING READY\n\n" + Array.from({ length: 30 }, (_, i) => `Detail ${i + 1}`).join("\n\n")
        : count === 1 ? "FOLLOWUP ONE COMPLETE" : "FOLLOWUP TWO COMPLETE";
      calls.push({ stage: "chat", question: payload.question, history: payload.privateDiscussion?.length ?? 0 });
      const finished = (async () => {
        await save();
        await new Promise(resolve => setTimeout(resolve, slow ? 1800 : 200));
        return { stopReason: "stop", content: [{ type: "text", text }] };
      })();
      return {
        async *[Symbol.asyncIterator]() {
          const response = await finished;
          for (const delta of response.content[0].text.match(/.{1,80}/gs)) {
            yield { type: "text_delta", delta };
          }
        },
        result: () => finished,
      };
    };
  });
}
'''

with tempfile.TemporaryDirectory(prefix="ysk-native-") as temporary:
    temp = Path(temporary)
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    session = temp / "fixture.jsonl"
    messages = [
        {"type": "session", "version": 3, "id": "ysk-native-fixture", "timestamp": now, "cwd": temporary},
        {"type": "message", "id": "u", "parentId": None, "timestamp": now,
         "message": {"role": "user", "content": "Explain the synthetic result", "timestamp": 1}},
        {"type": "message", "id": "a", "parentId": "u", "timestamp": now,
         "message": {"role": "assistant", "content": [{"type": "text", "text": "Synthetic decision: use local fixtures. Live verification is not authorized."}],
                     "api": "openai-responses", "provider": "openai", "model": "gpt-6-luna", "stopReason": "stop", "timestamp": 2,
                     "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0,
                               "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}}},
    ]
    session.write_text("".join(json.dumps(message) + "\n" for message in messages))
    original_session = session.read_bytes()
    fixture = temp / "fixture.ts"
    fixture.write_text(FIXTURE)
    metrics = temp / "calls.json"
    agent = temp / "agent"
    agent.mkdir()
    package_source = os.environ.get("YSK_TEST_PACKAGE_SOURCE", str(ROOT))
    (agent / "settings.json").write_text(json.dumps({"packages": [package_source]}))
    config_path = os.environ.get("YSK_TEST_CONFIG")
    if config_path:
        (agent / "you-should-know.json").write_text(Path(config_path).read_text())
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    env = {"PATH": os.environ["PATH"], "HOME": temporary, "PI_CODING_AGENT_DIR": str(agent),
           "PI_OFFLINE": "1", "TERM": "xterm-256color", "YSK_FIXTURE_METRICS": str(metrics)}
    executable = os.environ.get("YSK_TEST_PI")
    cli = [executable] if executable else ["node", str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")]
    version = subprocess.run(cli + ["--version"], cwd=temporary, env=env, capture_output=True, text=True, check=True).stdout.strip()
    # Load YSK through package discovery, not an explicit extension path.
    command = cli + ["--offline", "--session", str(session), "--no-skills", "--no-prompt-templates",
                     "--no-context-files", "--no-themes", "--no-tools", "--no-approve", "--extension", str(fixture)]
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, cwd=temporary, env=env, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def drain(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.05)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break

    def send(data, seconds=0.5):
        os.write(master, data)
        drain(seconds)

    def calls():
        return json.loads(metrics.read_text()) if metrics.exists() else []

    try:
        drain(3)
        # Pi may normalize a resumed fixture or append its own startup metadata.
        # Compare the private workflow against the session after startup is complete.
        original_session = session.read_bytes()
        assert not calls(), "provider calls before /ysk"
        send(b"/ysk\r", 1)
        if not config_path:
            assert b"1/3" in output, "first-run model setup did not open"
            assert not calls(), "model calls before selecting models"
            send(b"jev-latest\r")
            assert b"2/3" in output, "ranking choice did not advance setup"
            send(b"openai-codex/gpt-6-luna\r")
            assert b"3/3" in output, "chat choice did not reach save confirmation"
            assert not calls(), "model calls before confirming setup"
            send(b"\r", 1)
            saved = json.loads((agent / "you-should-know.json").read_text())
            assert saved == {"rankModel": "typesafe/jev-latest", "chatModel": "openai-codex/gpt-6-luna"}
        assert b"BRIEFING READY" in output, output[-3000:].decode(errors="replace")
        assert "╭".encode() in output and "╰".encode() in output, "modal border is missing"
        assert b"Follow-up" in output, "separate follow-up input area is missing"
        assert b"Detail 30" not in output, "briefing is not a bounded viewport"
        send(b"\x1b[6~" * 8)
        assert b"Detail 30" in output, "Page Down did not expose the end of the briefing"
        send(b"why?\r")
        send(b"\x1b[6~" * 8)
        assert b"FOLLOWUP ONE COMPLETE" in output, "first streamed follow-up was not visible"
        send(b"what next?\r")
        send(b"\x1b[6~" * 8)
        assert b"FOLLOWUP TWO COMPLETE" in output, "second streamed follow-up was not visible"
        assert calls()[-1]["history"] == 2, "second follow-up lost private history"
        send(b"\x1b")
        before = calls()
        send(b"/ysk\r")
        assert calls() == before, "reopen called providers despite unchanged evidence"
        send(b"slow\r", 0.2)
        assert calls()[-1]["question"] == "slow"
        send(b"\x1b", 2)
        assert b"LATE CANCELLED OUTPUT" not in output, "cancelled stream updated the closed modal"
        assert session.read_bytes() == original_session, "private workflow changed the session: " + repr([
            json.loads(line) for line in session.read_text().splitlines()
            if line.encode() not in original_session.splitlines()
        ])
        assert len([call for call in calls() if call["stage"] == "rank"]) == 1
        assert calls()[0]["retries"] == 0
        send(b"\x04")
        setup_check = "existing configuration" if config_path else "first-run model setup and automatic configuration save"
        print(f"PASS installed-package discovery on Pi {version}: {setup_check}, ranked briefing, keyboard scrolling, two streamed follow-ups, cache reopen, ignored-abort close, unchanged session; local fixtures only")
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
