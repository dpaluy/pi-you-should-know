import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import extension from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/briefing.ts";

initTheme();
const tick = () => new Promise<void>((done) => setImmediate(done));
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 1_000; i++) { if (predicate()) return; await tick(); }
  assert.fail("fixture did not settle");
}
const forbidden = () => { throw new Error("Main-session or persistent UI mutation forbidden"); };
async function fixture(configured = true) {
  const dir = await mkdtemp(join(tmpdir(), "ysk-integration-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  if (configured) await writeFile(join(dir, "you-should-know.json"), JSON.stringify(DEFAULT_CONFIG));
  const entries: any[] = [
    { id: "u", type: "message", message: { role: "user", content: "Decide a route" } },
    { id: "a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Use the local route. Remote verification remains unavailable." }] } },
  ];
  const calls: any[] = [];
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let modal: any;
  let opened = false;
  let closed = true;
  let pending: Promise<void>;
  let session = "s";
  let rankImpl: ((args: any) => Promise<any>) | undefined;
  let chatImpl: (() => Promise<any>) | undefined;
  const response = (text = "Local route selected; remote verification is still unavailable.") => ({ stopReason: "stop", content: [{ type: "text", text }] });
  const ctx: any = {
    mode: "tui", hasUI: true, model: Object.freeze({ id: "main" }),
    sessionManager: { getBranch: () => { assert.ok(opened, "snapshot must follow modal opening"); return entries; }, getLeafId: () => entries.at(-1)?.id, getSessionId: () => session },
    ui: {
      notify: forbidden, setWidget: forbidden, setStatus: forbidden, setEditorText: forbidden,
      custom: (factory: Function, options: any) => {
        pending = new Promise<void>((done) => {
          modal = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, { fg: (_: string, text: string) => text }, { matches: () => false }, () => { closed = true; done(); });
          assert.equal(options.overlay, true);
          opened = true; closed = false;
          options.onHandle({});
        });
        return pending;
      },
    },
    modelRegistry: {
      getProviderAuthStatus: () => ({ configured: true }),
      getModelsOfType: (type: string) => type === "classifier"
        ? [{ type, provider: "typesafe", id: "jev-latest" }, { type, provider: "fixture", id: "other-rank" }]
        : [{ type, provider: "openai", id: "gpt-6-luna" }, { type, provider: "openai-codex", id: "gpt-6-luna" }, { type, provider: "fixture", id: "other-chat" }],
      findOfType: (_: string, provider: string, id: string) => id === "missing" ? undefined : { type: "classifier", provider, id },
      find: (provider: string, id: string) => id === "missing" ? undefined : { type: "chat", provider, id },
      classify: async (model: any, args: any, options: any) => {
        assert.ok(opened); calls.push({ kind: "rank", model, args, options });
        if (rankImpl) return rankImpl(args);
        return { stopReason: "stop", answers: Object.fromEntries(Object.keys(args.questions).map((key) => [key, { type: "score", score: 3 }])) };
      },
      streamSimple: (model: any, context: any, options: any) => {
        assert.ok(opened); assert.equal(context.tools, undefined); assert.equal(options.maxRetries, 0);
        calls.push({ kind: "chat", model, context, options });
        const result = chatImpl ? chatImpl() : Promise.resolve(response());
        return { async *[Symbol.asyncIterator]() { const value = await result; if (value.stopReason === "stop") yield { type: "text_delta", delta: value.content[0].text }; }, result: () => result };
      },
    },
  };
  const pi: any = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (name: string, value: any) => commands.set(name, value), appendEntry: forbidden, sendMessage: forbidden, sendUserMessage: forbidden, setModel: forbidden, setThinkingLevel: forbidden, setActiveTools: forbidden, registerTool: forbidden };
  extension(pi);
  const open = () => { const running = commands.get("ysk").handler("", ctx); assert.ok(opened); return running; };
  const text = () => { modal.scrollBy(-10_000); return modal.render(100).join("\n"); };
  const ready = () => waitFor(() => !text().includes("Working") && !text().includes("Reading recent"));
  const ask = (question: string) => { for (const char of question) modal.handleInput(char); modal.handleInput("\r"); };
  return { dir, ctx, entries, calls, handlers, open, text, ready, ask, response,
    invoke: () => commands.get("ysk").handler("", ctx),
    close: () => modal.handleInput("\x1b"),
    setRank: (fn: (args: any) => Promise<any>) => { rankImpl = fn; },
    setChat: (fn: () => Promise<any>) => { chatImpl = fn; },
    setSession: (id: string) => { session = id; },
    get closed() { return closed; },
    cleanup: async () => { modal?.close(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(dir, { recursive: true }); },
  };
}

test("actual Pi loader registers only on-demand command and cleanup", async () => {
  const result = await loadExtensions([resolve("src/index.ts")], process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const loaded = result.extensions[0];
  assert.ok(loaded.commands.has("ysk"));
  assert.deepEqual([...loaded.handlers.keys()].sort(), ["session_shutdown", "session_start", "session_tree"]);
});

test("no background calls; immediate native modal; reuse, private follow-up, fixed snapshot and replacement", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.entries);
    for (const fn of f.handlers.values()) await fn({}, f.ctx);
    assert.equal(f.calls.length, 0);
    assert.equal(f.handlers.has("context"), false);
    let opening = f.open(); await f.ready();
    assert.match(f.text(), /Local route/);
    assert.deepEqual(f.entries, original);
    const initialCalls = f.calls.length;
    f.entries.push({ id: "new", type: "message", message: { role: "assistant", content: "New output unseen by follow-up" } });
    f.ask("Why?"); f.ask("duplicate"); await f.ready();
    assert.equal(f.calls.length, initialCalls + 1);
    const follow = f.calls.at(-1);
    assert.equal(follow.model.id, "gpt-6-luna");
    assert.doesNotMatch(JSON.stringify(follow.context), /New output unseen/);
    assert.match(f.text(), /Why/);
    f.entries.pop(); f.close(); await opening;
    opening = f.open(); await f.ready();
    assert.equal(f.calls.length, initialCalls + 1);
    assert.match(f.text(), /Why/);
    f.close(); await opening;
    f.entries.push({ id: "new", type: "message", message: { role: "assistant", content: "New decision" } });
    opening = f.open(); await f.ready();
    assert.equal(f.calls.length, initialCalls + 3);
    assert.doesNotMatch(f.text(), /Why/);
    assert.match(JSON.stringify(f.calls.at(-1).context), /New decision/);
    assert.match(JSON.stringify(f.calls.at(-1).context), /previousBriefingNoveltyContext/);
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("two completed follow-ups retain private quoted context without reranking or session changes", async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.entries);
    const opening = f.open(); await f.ready();
    f.ask("Why?"); await f.ready();
    f.ask("What next?"); await f.ready();
    assert.equal(f.calls.filter((call) => call.kind === "rank").length, 1);
    assert.equal(f.calls.filter((call) => call.kind === "chat").length, 3);
    const context = JSON.parse(f.calls.at(-1).context.messages[0].content);
    assert.equal(context.question, "What next?");
    assert.deepEqual(context.privateDiscussion.map((turn: any) => turn.role), ["user", "assistant"]);
    assert.equal(context.privateDiscussion[0].text, "Why?");
    assert.deepEqual(f.entries, original);
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("first-run setup saves chosen models, calls nothing before confirmation, and does not repeat", async () => {
  const f = await fixture(false);
  try {
    const original = structuredClone(f.entries);
    let opening = f.open(); await f.ready();
    assert.match(f.text(), /1\/3/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(readFile(join(f.dir, "you-should-know.json")), { code: "ENOENT" });
    f.ask("jev-latest");
    assert.match(f.text(), /2\/3/);
    f.ask("openai-codex/gpt-6-luna");
    assert.match(f.text(), /3\/3/);
    assert.equal(f.calls.length, 0);
    f.ask(""); await f.ready();
    const stored = JSON.parse(await readFile(join(f.dir, "you-should-know.json"), "utf8"));
    assert.deepEqual(stored, { rankModel: "typesafe/jev-latest", chatModel: "openai-codex/gpt-6-luna" });
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls.at(-1).model.provider, "openai-codex");
    assert.deepEqual(f.entries, original);
    f.close(); await opening;
    opening = f.open(); await f.ready();
    assert.doesNotMatch(f.text(), /1\/3/);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, "you-should-know.json"), "utf8")), stored);
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("setup keeps concurrently created settings without making calls with unconfirmed models", async () => {
  const f = await fixture(false);
  try {
    const opening = f.open(); await f.ready();
    f.ask("jev-latest"); f.ask("openai-codex/gpt-6-luna");
    await writeFile(join(f.dir, "you-should-know.json"), JSON.stringify(DEFAULT_CONFIG));
    f.ask(""); await f.ready();
    assert.match(f.text(), /Another session/);
    assert.equal(f.calls.length, 0);
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, "you-should-know.json"), "utf8")), DEFAULT_CONFIG);
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("model-catalog setup errors do not reveal raw provider details", async () => {
  const f = await fixture(false);
  try {
    const opening = f.open(); await f.ready();
    f.ctx.modelRegistry.getModelsOfType = () => { throw new Error("secret-api-key and raw provider body"); };
    f.ask("jev-latest");
    assert.match(f.text(), /YSK request failed/);
    assert.doesNotMatch(f.text(), /secret-api-key|raw provider body/);
    assert.equal(f.calls.length, 0);
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("cancelling setup or switching session saves nothing and makes no model calls", async () => {
  for (const stage of [0, 1, 2]) {
    const f = await fixture(false);
    try {
      const opening = f.open(); await f.ready();
      if (stage >= 1) f.ask("jev-latest");
      if (stage >= 2) f.ask("openai-codex/gpt-6-luna");
      if (stage === 1) await f.handlers.get("session_tree")!({}, f.ctx);
      else f.close();
      await opening;
      assert.equal(f.calls.length, 0);
      await assert.rejects(readFile(join(f.dir, "you-should-know.json")), { code: "ENOENT" });
    } finally { await f.cleanup(); }
  }
});

test("setup works in an empty session and saved settings survive missing credentials", async () => {
  const f = await fixture(false);
  try {
    f.entries.length = 0;
    let opening = f.open(); await f.ready();
    assert.match(f.text(), /1\/3/);
    f.ask("jev-latest"); f.ask("openai-codex/gpt-6-luna"); f.ask(""); await f.ready();
    assert.match(f.text(), /No session output/);
    assert.equal(f.calls.length, 0);
    f.close(); await opening;
    f.entries.push({ id: "a", type: "message", message: { role: "assistant", content: "A decision" } });
    f.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: false });
    opening = f.open(); await f.ready();
    assert.match(f.text(), /credentials are missing/);
    assert.equal(f.calls.length, 0);
    f.close(); await opening;
    f.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true });
    opening = f.open(); await f.ready();
    assert.equal(f.calls.length, 2);
    assert.doesNotMatch(f.text(), /1\/3/);
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("empty and non-TUI contexts never call providers or notifications", async () => {
  const f = await fixture();
  try {
    f.ctx.mode = "rpc";
    await assert.rejects(f.invoke(), /interactive/);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
  const empty = await fixture();
  try { empty.entries.length = 0; const opening = empty.open(); await empty.ready(); assert.match(empty.text(), /No session output/); assert.equal(empty.calls.length, 0); empty.close(); await opening; }
  finally { await empty.cleanup(); }
});

test("config, missing model, malformed rank and authentication failures remain safe modal errors", async () => {
  const f = await fixture();
  try {
    for (const contents of ["not json", JSON.stringify({ chatModel: "test/missing" })]) {
      await writeFile(join(f.dir, "you-should-know.json"), contents);
      const opening = f.open(); await f.ready(); assert.match(f.text(), /YSK/); assert.equal(f.calls.length, 0); f.close(); await opening;
    }
    await writeFile(join(f.dir, "you-should-know.json"), JSON.stringify(DEFAULT_CONFIG));
    f.setRank(async () => ({ stopReason: "stop", answers: {} }));
    let opening = f.open(); await f.ready(); assert.match(f.text(), /invalid score/); f.close(); await opening;
    f.setRank(async () => { throw new Error("secret-api-key and raw provider body"); });
    opening = f.open(); await f.ready(); assert.match(f.text(), /ranking request failed/); assert.doesNotMatch(f.text(), /secret/); f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("failed follow-up commits no partial turn; failed replacement shows no stale briefing; model settings invalidate cache", async () => {
  const f = await fixture();
  try {
    let opening = f.open(); await f.ready();
    f.setChat(async () => ({ stopReason: "error", content: [] }));
    f.ask("Failed question"); await f.ready(); assert.doesNotMatch(f.text(), /Failed question/);
    f.close(); await opening;
    f.entries.push({ id: "new", type: "message", message: { role: "assistant", content: "Changed output" } });
    opening = f.open(); await f.ready(); assert.doesNotMatch(f.text(), /Local route/); assert.match(f.text(), /chat request failed/); f.close(); await opening;
    await writeFile(join(f.dir, "you-should-know.json"), JSON.stringify({ chatModel: "test/missing" }));
    const count = f.calls.length;
    opening = f.open(); await f.ready(); assert.equal(f.calls.length, count); assert.match(f.text(), /unavailable/); assert.doesNotMatch(f.text(), /Local route/); f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("changed valid model settings replace the cached briefing and use only the configured identities", async () => {
  const f = await fixture();
  try {
    let opening = f.open(); await f.ready(); f.close(); await opening;
    const count = f.calls.length;
    await writeFile(join(f.dir, "you-should-know.json"), JSON.stringify({ rankModel: "fixture/custom-rank", chatModel: "fixture/custom-chat" }));
    opening = f.open(); await f.ready();
    assert.equal(f.calls.length, count + 2);
    assert.equal(f.calls[count].model.id, "custom-rank");
    assert.equal(f.calls[count + 1].model.id, "custom-chat");
    f.close(); await opening;
  } finally { await f.cleanup(); }
});

test("40-second total deadline bounds an ignored-abort provider and invalidates late updates", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let release!: (value: any) => void;
    f.setChat(() => new Promise((done) => { release = done; }));
    const opening = f.open();
    await waitFor(() => !!release);
    t.mock.timers.tick(40_000);
    await tick();
    assert.match(f.text(), /timed out after 40 seconds/);
    assert.ok(f.calls.at(-1).options.signal.aborted);
    release(f.response("LATE AFTER DEADLINE"));
    await tick(); await tick();
    assert.doesNotMatch(f.text(), /LATE AFTER DEADLINE/);
    f.close(); await opening;
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test("session lifecycle clears completed caches without background calls", async () => {
  const f = await fixture();
  try {
    let opening = f.open(); await f.ready(); f.close(); await opening;
    for (const event of ["session_start", "session_tree", "session_shutdown"]) {
      const before = f.calls.length;
      await f.handlers.get(event)!({}, f.ctx);
      assert.equal(f.calls.length, before);
      opening = f.open(); await f.ready();
      assert.equal(f.calls.length, before + 2);
      f.close(); await opening;
    }
  } finally { await f.cleanup(); }
});

test("ignored-abort ranking and chat cannot update after close or branch/session switch", async () => {
  for (const phase of ["rank", "chat", "follow"] as const) {
    const f = await fixture();
    try {
      let release!: (value: any) => void;
      let args: any;
      if (phase === "rank") f.setRank((input) => { args = input; return new Promise((done) => { release = done; }); });
      if (phase === "chat") f.setChat(() => new Promise((done) => { release = done; }));
      const opening = f.open();
      if (phase === "follow") { await f.ready(); f.setChat(() => new Promise((done) => { release = done; })); f.ask("Delayed"); }
      await waitFor(() => !!release);
      const oldText = f.text();
      if (phase === "rank") f.close();
      else { f.setSession("another"); await f.handlers.get("session_tree")!({}, f.ctx); }
      await opening;
      assert.ok(f.closed);
      release(phase === "rank" ? { stopReason: "stop", answers: Object.fromEntries(Object.keys(args.questions).map((key) => [key, { type: "score", score: 2 }])) } : f.response("STALE"));
      await tick(); await tick();
      assert.equal(f.text(), "");
      assert.doesNotMatch(oldText, /STALE/);
      if (phase === "rank") assert.equal(f.calls.filter((call) => call.kind === "chat").length, 0);
    } finally { await f.cleanup(); }
  }
});
