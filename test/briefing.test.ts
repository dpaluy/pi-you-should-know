import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerFollowUp, DEFAULT_CONFIG, generateBriefing, loadConfig, saveConfig, resolveModels, snapshot, MAX_CHARS, type EvidenceSnapshot } from "../src/briefing.ts";
import { transformMessages } from "../node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js";
import { classifySystemOne } from "../node_modules/@earendil-works/pi-ai/dist/api/system-one-shared.js";

const entry = (id: string, role: string, content: any, extra: Record<string, unknown> = {}) => ({
  id, type: "message", message: { role, content, ...extra },
}) as any;
const ctxFrom = (entries: any[], overrides: Record<string, any> = {}) => ({
  sessionManager: { getBranch: () => entries, getSessionId: () => "session-a", getLeafId: () => "leaf-a" },
  ...overrides,
}) as any;
const evidence: EvidenceSnapshot = Object.freeze({
  sessionId: "s", branchId: "b", truncated: false, omittedGroups: 0, omittedCharacters: 0,
  groups: Object.freeze([{ id: "g1", truncated: false, text: "decision: use immutable snapshot", items: Object.freeze([]) }]),
});

 test("detects missing configuration for setup and validates existing settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-config-"));
  try {
    assert.equal(await loadConfig(join(dir, "absent.json")), undefined);
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ rankModel: "typesafe/jev-latest", chatModel: "openai/gpt-6-luna" }));
    assert.deepEqual(await loadConfig(path), DEFAULT_CONFIG);
    await writeFile(path, "{bad");
    await assert.rejects(loadConfig(path), /valid JSON/);
    await writeFile(path, JSON.stringify({ rankModel: "bad" }));
    await assert.rejects(loadConfig(path), /provider\/model-id/);
    await writeFile(path, JSON.stringify({ hidden: true }));
    await assert.rejects(loadConfig(path), /unknown setting/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("setup publishes complete private settings without overwriting an existing configuration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ysk-save-"));
  const file = join(dir, "agent", "you-should-know.json");
  const selected = { rankModel: "typesafe/jev-latest", chatModel: "openai-codex/gpt-6-luna" };
  try {
    assert.deepEqual(await saveConfig(file, selected, new AbortController().signal), selected);
    assert.deepEqual(await loadConfig(file), selected);
    const original = await readFile(file, "utf8");
    assert.deepEqual(await saveConfig(file, DEFAULT_CONFIG, new AbortController().signal), selected);
    assert.equal(await readFile(file, "utf8"), original);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, "agent")), ["you-should-know.json"]);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(saveConfig(join(dir, "cancelled.json"), selected, aborted.signal), /cancelled/);
    await assert.rejects(readFile(join(dir, "cancelled.json")), { code: "ENOENT" });
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "file");
    await assert.rejects(saveConfig(join(blocker, "settings.json"), selected, new AbortController().signal), /permissions/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("snapshot groups request roles, preserves source/status, excludes non-text and bounds with markers", () => {
  const entries = [
    entry("u1", "user", "what changed?"),
    entry("a1", "assistant", [{ type: "thinking", thinking: "private" }, { type: "text", text: "A decision" }], { stopReason: "stop" }),
    entry("t1", "toolResult", "failed output", { isError: true }),
    entry("x", "custom", "not evidence"),
    entry("u2", "user", "next request"),
    entry("a2", "assistant", "done"),
  ];
  const result = snapshot(ctxFrom(entries));
  assert.equal(result.groups.length, 2);
  assert.match(result.groups[0].text, /\[u1 user ok\]/);
  assert.match(result.groups[0].text, /\[t1 toolResult error\]/);
  assert.doesNotMatch(result.groups[0].text, /private|custom/);
  assert.deepEqual(Object.isFrozen(result.groups), true);
  const long = snapshot(ctxFrom([entry("u", "user", "x".repeat(36_000))]));
  assert.equal(long.truncated, true);
  assert.match(long.groups[0].text, /evidence truncated/);
  assert.ok(long.omittedCharacters > 0);
  const many = snapshot(ctxFrom(Array.from({ length: 14 }, (_, i) => entry(`u${i}`, "user", `request ${i}`))));
  assert.equal(many.groups.length, 12);
  assert.equal(many.omittedGroups, 2);
});

test("retains resolved earlier error and later discovery, decision, and limitation as evidence", () => {
  const result = snapshot(ctxFrom([
    entry("u1", "user", "investigate test failure"),
    entry("t1", "toolResult", "test failed: missing fixture", { isError: true }),
    entry("u2", "user", "fix and verify"),
    entry("a2", "assistant", "Decision: use a disposable local fixture. Discovery: focused tests pass. Limitation: live provider behavior is unverified.", { stopReason: "stop" }),
  ]));
  assert.match(result.groups[0].text, /t1 toolResult error/);
  assert.match(result.groups[1].text, /Decision: use a disposable local fixture/);
  assert.match(result.groups[1].text, /Discovery: focused tests pass/);
  assert.match(result.groups[1].text, /Limitation: live provider behavior is unverified/);
});

test("resolves both correctly typed models before provider calls", () => {
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => provider === "typesafe" && id === "jev-latest" ? { type: "classifier", provider, id } : undefined,
    find: (provider: string, id: string) => provider === "openai" && id === "gpt-6-luna" ? { type: "chat", provider, id } : undefined,
  };
  assert.deepEqual(resolveModels({ modelRegistry: registry } as any, DEFAULT_CONFIG), {
    rankModel: { type: "classifier", provider: "typesafe", id: "jev-latest" },
    chatModel: { type: "chat", provider: "openai", id: "gpt-6-luna" },
  });
  assert.throws(() => resolveModels({ modelRegistry: { ...registry, find: () => undefined } } as any, DEFAULT_CONFIG), /unavailable/);
  assert.throws(() => resolveModels({ modelRegistry: { ...registry, findOfType: () => undefined } } as any, DEFAULT_CONFIG), /classifier/);
});

test("ranks all groups, orders priority with recency tie-break, and sends all evidence and novelty context to Luna", async () => {
  const groups = ["old", "middle", "new"].map((id) => Object.freeze({ id, text: `evidence ${id}`, truncated: false, items: Object.freeze([]) }));
  const snap = Object.freeze({ ...evidence, groups: Object.freeze(groups) });
  const calls: any[] = [];
  let chatPayload = "";
  const registry = {
    classify: async (_model: unknown, input: any, options: any) => {
      calls.push(input);
      assert.equal(options.maxRetries, 0);
      assert.deepEqual(input.state.evidence, snap);
      assert.equal(input.state.previousBriefingNoveltyContext, "Earlier result");
      return { stopReason: "stop", answers: Object.fromEntries(Object.entries(input.questions).map(([key, value]) => {
        const id = key.replace("importance_", "");
        assert.match((value as any).instructions, new RegExp(JSON.stringify(id)));
        return [key, { type: "score", score: id === "middle" ? 3 : 2, confidence: 0.9 }];
      })) };
    },
    streamSimple: (_model: unknown, input: any, options: any) => {
      chatPayload = input.messages[0].content;
      assert.ok(input.systemPrompt.includes("untrusted data"));
      assert.equal(input.tools, undefined);
      assert.equal(options.maxRetries, 0);
      const stream = {
        async *[Symbol.asyncIterator]() { yield { type: "text_delta", delta: "Brief" }; yield { type: "done", reason: "stop", message: {} }; },
        result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Brief" }] }),
      };
      return stream;
    },
  };
  const models = { rankModel: {} as any, chatModel: {} as any };
  const updates: string[] = [];
  const result = await generateBriefing({ modelRegistry: registry } as any, models, snap, new AbortController().signal, { previousBriefing: "Earlier result", onText: (s) => updates.push(s) });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions), ["importance_old", "importance_middle", "importance_new"]);
  assert.deepEqual(result.priorities.map((x) => x.groupId), ["middle", "new", "old"]);
  assert.equal(result.text, "Brief");
  assert.ok(chatPayload.includes("evidence old") && chatPayload.includes("evidence middle") && chatPayload.includes("evidence new"));
  assert.ok(chatPayload.includes("validatedPrioritySignals") && chatPayload.includes("Earlier result"));
  assert.deepEqual(updates, ["Brief"]);
});

test("rejects malformed ranks, provider errors, tool attempts, non-stop chat, and aborts", async () => {
  const model = {} as any;
  const base = { findOfType: () => model };
  const invalidRank = { modelRegistry: { ...base, classify: async () => ({ stopReason: "stop", answers: { importance_g1: { type: "score", score: 8 } } }) } };
  await assert.rejects(generateBriefing(invalidRank as any, { rankModel: model, chatModel: model }, evidence, new AbortController().signal), /invalid score/);
  const brokenRank = { modelRegistry: { ...base, classify: async () => ({ stopReason: "error", answers: {} }) } };
  await assert.rejects(generateBriefing(brokenRank as any, { rankModel: model, chatModel: model }, evidence, new AbortController().signal), /ranking request failed/);
  const makeChat = (stopReason: string, tool = false) => ({ modelRegistry: {
    classify: async (_m: unknown, input: any) => ({ stopReason: "stop", answers: { [Object.keys(input.questions)[0]]: { type: "score", score: 1 } } }),
    streamSimple: () => ({ async *[Symbol.asyncIterator]() { if (tool) yield { type: "toolcall_start" }; yield { type: "done", reason: "stop", message: {} }; }, result: async () => ({ stopReason, content: [{ type: "text", text: "x" }] }) }),
  } });
  await assert.rejects(generateBriefing(makeChat("stop", true) as any, { rankModel: model, chatModel: model }, evidence, new AbortController().signal), /tools/);
  await assert.rejects(generateBriefing(makeChat("length") as any, { rankModel: model, chatModel: model }, evidence, new AbortController().signal), /chat request failed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(answerFollowUp({ modelRegistry: {} } as any, model, evidence, "brief", "why?", [], controller.signal), /cancelled/);
});

test("repeated follow-ups use valid native messages and bounded quoted private discussion", async () => {
  const messages: any[] = [];
  const model = { provider: "fixture", id: "chat", api: "openai-responses", input: ["text"] } as any;
  const ctx = { modelRegistry: { streamSimple: (_m: unknown, input: any) => {
    const converted = transformMessages(input.messages, model);
    messages.push(converted);
    assert.equal(input.tools, undefined);
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message: {} }; }, result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Grounded answer" }] }) };
  } } };
  const discussion: any[] = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `turn${i}` }));
  const signal = new AbortController().signal;
  const answer = await answerFollowUp(ctx as any, model, evidence, "briefing", "why?", discussion, signal);
  discussion.push({ role: "user", text: "why?" }, { role: "assistant", text: answer });
  await answerFollowUp(ctx as any, model, evidence, "briefing", "what next?", discussion, signal);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].length, 1);
  const first = JSON.parse(messages[0][0].content);
  const second = JSON.parse(messages[1][0].content);
  assert.equal(first.privateDiscussion.length, 8);
  assert.equal(first.privateDiscussion.at(-1).text, "turn9");
  assert.equal(second.privateDiscussion.at(-1).text, answer);
  assert.equal(second.question, "what next?");
  assert.match(JSON.stringify(first.fixedEvidence), /decision: use immutable snapshot/);
});

test("many oversized tool results and escaped text stay within retained and transmitted evidence limits", async () => {
  const entries = [entry("u", "user", "Review the result"),
    ...Array.from({ length: 100 }, (_, i) => entry(`t${i}`, "toolResult", ('\\"\n\\\\').repeat(2_000), { isError: i === 99 })),
    entry("a", "assistant", "Latest outcome: verification failed", { stopReason: "stop" }),
  ];
  const snap = snapshot(ctxFrom(entries));
  assert.ok(JSON.stringify(snap).length <= MAX_CHARS);
  assert.ok(snap.groups[0].items.length < entries.length);
  assert.ok(snap.omittedCharacters > 0);
  assert.match(snap.groups[0].text, /u user ok/);
  assert.match(snap.groups[0].text, /Latest outcome: verification failed/);
  assert.match(snap.groups[0].text, /t99 toolResult error/);
  assert.match(snap.groups[0].text, /evidence truncated/);
  const ctx = { modelRegistry: {
    classify: async (_model: unknown, input: any) => {
      assert.ok(JSON.stringify(input.state.evidence).length <= MAX_CHARS);
      return { stopReason: "stop", answers: Object.fromEntries(Object.keys(input.questions).map((id) => [id, { type: "score", score: 3 }])) };
    },
    streamSimple: (_model: unknown, input: any) => {
      assert.ok(JSON.stringify(JSON.parse(input.messages[0].content).evidence).length <= MAX_CHARS);
      return { async *[Symbol.asyncIterator]() {}, result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Verification remains incomplete." }] }) };
    },
  } };
  await generateBriefing(ctx as any, { rankModel: {} as any, chatModel: {} as any }, snap, new AbortController().signal);
  const allGroups = snapshot(ctxFrom(Array.from({ length: 20 }, (_, i) => entry(`u${i}`, "user", '\\"\n'.repeat(20_000)))));
  assert.ok(JSON.stringify(allGroups).length <= MAX_CHARS);
  assert.ok(allGroups.omittedGroups > 0);
});

test("native classifier transport makes one attempt on a transient failure", async () => {
  let attempts = 0;
  const model = { type: "classifier", api: "typesafe-system-one", provider: "fixture", id: "fixture-jev" } as any;
  const ctx = { modelRegistry: { classify: (_model: unknown, input: any, options: any) => classifySystemOne({
    api: "typesafe-system-one", label: "Local fixture",
    url: () => new URL("https://fixture.invalid/systemone"),
    payload: (_m, request) => request,
    output: (body) => body as Record<string, unknown>,
  }, model, input, { ...options, apiKey: "disposable-fixture-key", fetch: async () => {
    attempts++;
    return new Response("transient local fixture error", { status: 429, headers: { "retry-after": "0" } });
  } }) } };
  await assert.rejects(generateBriefing(ctx as any, { rankModel: model, chatModel: {} as any }, evidence, new AbortController().signal), /ranking request failed/);
  assert.equal(attempts, 1);
});
