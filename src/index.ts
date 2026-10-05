import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { answerFollowUp, generateBriefing, loadConfig, resolveModels, snapshot, type EvidenceSnapshot, type FollowUpTurn, type ResolvedModels } from "./briefing.ts";
import { createBriefingModal, briefingModalOverlayOptions, type BriefingModal, type ModalState } from "./modal.ts";

interface Latest {
  key: string;
  evidence: EvidenceSnapshot;
  models: ResolvedModels;
  briefing: string;
  discussion: FollowUpTurn[];
}
const safeErrors = new Set([
  "YSK configuration could not be read.", "YSK configuration is not valid JSON.",
  "YSK configuration must be an object.", "YSK configuration contains an unknown setting.",
  "YSK model settings must use provider/model-id values.",
  "YSK ranking model is unavailable or is not a classifier.", "YSK chat model is unavailable or is not a chat model.",
  "YSK ranking request failed.", "YSK ranking returned an invalid score.",
  "YSK chat request failed.", "YSK response attempted to use tools.", "YSK chat returned no text.",
  "YSK request timed out after 40 seconds.",
]);

export default function youShouldKnow(pi: ExtensionAPI) {
  const path = join(getAgentDir(), "you-should-know.json");
  let latest: Latest | undefined;
  let modal: BriefingModal | undefined;
  let request: AbortController | undefined;
  let generation = 0;
  const cancel = () => { generation++; request?.abort(); request = undefined; };
  const clear = () => { cancel(); modal?.close(); modal = undefined; latest = undefined; };

  pi.registerCommand("ysk", {
    description: "Open a private recent-session briefing and follow-up chat",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") throw new Error("/ysk requires interactive Pi TUI mode.");
      modal?.close();
      cancel();
      const lifetime = generation;
      let view: BriefingModal | undefined;
      let current: Latest | undefined;
      let state: ModalState = { status: "Reading recent session...", busy: true };
      let busy = false;
      const alive = () => lifetime === generation;
      const update = (next: ModalState) => { if (alive()) { state = next; view?.update(state); } };
      const contextStatus = (evidence: EvidenceSnapshot) => evidence.truncated
        ? `Fixed snapshot: up to 12 groups / 24,000 characters; context omitted (${evidence.omittedGroups} groups, ${evidence.omittedCharacters} characters).`
        : "Fixed session snapshot; reopen to include new output.";
      const operate = async (work: (signal: AbortSignal) => Promise<void>) => {
        if (!alive() || busy) return;
        busy = true;
        const controller = new AbortController();
        request = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let interrupted!: () => void;
        const stopped = new Promise<never>((_resolve, reject) => {
          interrupted = () => reject(new Error("YSK request was cancelled."));
          controller.signal.addEventListener("abort", interrupted, { once: true });
          timer = setTimeout(() => {
            reject(new Error("YSK request timed out after 40 seconds."));
            controller.abort();
          }, 40_000);
        });
        try { await Promise.race([work(controller.signal), stopped]); }
        catch (error) {
          if (alive()) {
            const message = error instanceof Error && safeErrors.has(error.message) ? error.message : "YSK request failed. Check model availability and credentials.";
            update({ ...state, briefing: current?.briefing, discussion: current?.discussion ?? [], busy: false, error: message });
          }
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", interrupted);
          controller.abort();
          if (request === controller) request = undefined;
          busy = false;
        }
      };
      const start = () => void operate(async (signal) => {
        const evidence = snapshot(ctx);
        if (!evidence.groups.length) { update({ empty: true, busy: false }); return; }
        const config = await loadConfig(path);
        if (!alive() || signal.aborted) return;
        const models = resolveModels(ctx, config);
        const key = JSON.stringify({ evidence, config });
        if (latest?.evidence.sessionId !== evidence.sessionId) latest = undefined;
        if (latest?.key === key) {
          current = latest;
          update({ briefing: current.briefing, discussion: current.discussion, status: contextStatus(evidence), busy: false });
          return;
        }
        update({ busy: true, status: "Ranking and writing recent session..." });
        const result = await generateBriefing(ctx, models, evidence, signal, {
          previousBriefing: latest?.briefing,
          onText: (text) => { if (!signal.aborted) update({ briefing: text, busy: true, status: contextStatus(evidence) }); },
        });
        if (!alive() || signal.aborted) return;
        latest = current = { key, evidence, models, briefing: result.text, discussion: [] };
        update({ briefing: result.text, discussion: [], busy: false, status: contextStatus(evidence) });
      });
      const submit = (question: string) => {
        if (!question.trim() || !current || busy || !alive()) return;
        const captured = current;
        const pending: FollowUpTurn = { role: "user", text: question.trim().slice(0, 8_000) };
        void operate(async (signal) => {
          update({ briefing: captured.briefing, discussion: [...captured.discussion, pending], busy: true, status: "Answering from the fixed snapshot..." });
          const answer = await answerFollowUp(ctx, captured.models.chatModel, captured.evidence, captured.briefing, pending.text, captured.discussion, signal, (text) => {
            if (!signal.aborted) update({ ...state, discussion: [...captured.discussion, pending, { role: "assistant", text }] });
          });
          if (!alive() || signal.aborted) return;
          captured.discussion = [...captured.discussion, pending, { role: "assistant", text: answer.slice(0, 8_000) }].slice(-8) as FollowUpTurn[];
          update({ briefing: captured.briefing, discussion: captured.discussion, busy: false, status: contextStatus(captured.evidence) });
        });
      };
      try {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          view = createBriefingModal(tui, theme, keys, done, { onSubmit: submit, onCancel: () => { if (alive()) cancel(); } }, state);
          modal = view;
          return view;
        }, { overlay: true, overlayOptions: briefingModalOverlayOptions(), onHandle: start });
      } finally {
        if (alive()) cancel();
        view?.dispose();
        if (modal === view) modal = undefined;
      }
    },
  });
  pi.on("session_start", clear);
  pi.on("session_tree", clear);
  pi.on("session_shutdown", clear);
}
