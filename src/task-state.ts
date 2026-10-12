import { createHash } from "node:crypto";
import { record } from "./config.js";

export interface UserTurn { text: string; position: number; fingerprint: string; incomplete: boolean }
export interface TaskState {
  // Original messages preserve the goal and constraints without a lossy summary.
  messages: string[];
  evidence: string[];
  incomplete: boolean;
}
export interface TaskView {
  currentTask: TaskState;
  newMessages: string[];
  evidence: string[];
  incomplete: boolean;
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function environment(text: string): boolean {
  return /^\s*(?:<environment_context>|<permissions instructions>|<INSTRUCTIONS>|# AGENTS\.md instructions|<system_reminder>)/.test(text);
}
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter(record).filter(c => ["input_text", "output_text", "text"].includes(String(c.type)))
    .map(c => typeof c.text === "string" ? c.text : "").filter(t => !environment(t)).join("\n");
}
export function readTaskInput(body: Record<string, unknown>) {
  const input: unknown[] = typeof body.input === "string" ? [{ role: "user", content: body.input }] :
    Array.isArray(body.input) ? body.input : [];
  const users: UserTurn[] = [];
  const evidence: { position: number; text: string }[] = [];
  input.forEach((item, position) => {
    if (!record(item)) return;
    if (item.type === "configuration_update") throw new Error("auto 使用请求级 effort，请通过焚诀启动器禁用 reasoning_effort_override");
    if (item.role === "user") {
      const text = content(item.content);
      const incomplete = Array.isArray(item.content) && item.content.some(c => !record(c) || !["input_text", "text"].includes(String(c.type)));
      if ((!text && !incomplete) || environment(text)) return;
      users.push({ text, position, fingerprint: fingerprint(input.slice(0, position + 1)), incomplete });
    } else if (item.role === "assistant" || ["function_call_output", "custom_tool_call_output"].includes(String(item.type))) {
      const text = item.role === "assistant" ? content(item.content) :
        typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      if (text) evidence.push({ position, text });
    }
  });
  return { input, users, evidence };
}

export const isContinuation = (text: string): boolean => /^(继续|继续吧|接着|继续执行|continue|go on)[。.!！\s]*$/i.test(text.trim());

export function taskView(parsed: ReturnType<typeof readTaskInput>, previous?: {
  task: TaskState; history: string[]; lastPosition: number;
}): TaskView {
  const history = parsed.users.map(u => u.fingerprint);
  const extendsHistory = previous && previous.history.length <= history.length && previous.history.every((h, i) => h === history[i]);
  const added = extendsHistory ? parsed.users.slice(previous.history.length) : parsed.users;
  const lastUser = parsed.users.at(-1)?.position ?? Infinity;
  const knownEvidence = new Set(previous?.task.evidence);
  const evidence = parsed.evidence.filter(e => e.position < lastUser && (!extendsHistory || e.position > previous!.lastPosition) && !knownEvidence.has(e.text)).map(e => e.text);
  return {
    currentTask: previous?.task ?? { messages: [], evidence: [], incomplete: false },
    newMessages: added.map(u => u.text), evidence,
    // A changed multi-message history may have been compacted. Preserve the goal
    // and prohibit downgrading rather than assuming the new summary is complete.
    incomplete: added.some(u => u.incomplete) || Boolean(previous && !extendsHistory && parsed.users.length > 1),
  };
}

export function advanceTask(view: TaskView, newTask: boolean): TaskState {
  return newTask ? { messages: view.newMessages.slice(-1), evidence: [], incomplete: view.incomplete } : {
    messages: [...view.currentTask.messages, ...view.newMessages],
    evidence: [...new Set([...view.currentTask.evidence, ...view.evidence])],
    incomplete: view.currentTask.incomplete || view.incomplete,
  };
}
