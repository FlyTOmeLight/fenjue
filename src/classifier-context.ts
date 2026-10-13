import { record, type SemanticConfig } from "./config.js";
import { ClassificationError, classificationPayload } from "./classification.js";
import type { TaskView } from "./task-state.js";

export const CLASSIFIER_CONTEXT_POLICY = "goal-and-recent-evidence-v1";

function toolEvidence(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return record(value) && (Object.hasOwn(value, "command") || Object.hasOwn(value, "tool") || value.type === "fileChange");
  } catch { return false; }
}

// Preserve verbatim beginnings and conclusions, with an explicit omission marker.
// Measure JSON bytes because escaped tool output also consumes request budget.
function excerpt(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text);
  const candidate = (characters: number) => {
    const headLength = Math.floor(characters / 3), tailLength = characters - headLength;
    let head = text.slice(0, headLength), tail = tailLength ? text.slice(-tailLength) : "";
    // A slice must not split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    if (/^[\uDC00-\uDFFF]/.test(tail)) tail = tail.slice(1);
    return head + `\n[Fenjue: omitted ${bytes - Buffer.byteLength(head) - Buffer.byteLength(tail)} UTF-8 bytes]\n` + tail;
  };
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(candidate(middle))) <= maxBytes) low = middle; else high = middle - 1;
  }
  return candidate(low);
}

// Only the classifier projection changes. Execution input and saved history stay whole.
export function classifierContext(view: TaskView, config: SemanticConfig, constraints = false, context: "task" | "latest-message" = "task"): TaskView {
  const selected = context === "latest-message" ? {
    currentTask: { messages: [], evidence: [], incomplete: false },
    newMessages: view.newMessages.slice(-1), evidence: [], incomplete: view.incomplete,
  } : structuredClone(view);
  const fits = () => {
    try { classificationPayload(selected, config, constraints); return true; }
    catch (error) { if (error instanceof ClassificationError && error.code === "input-budget") return false; throw error; }
  };
  if (fits()) return selected;
  selected.currentTask.incomplete = true;
  const tools = selected.currentTask.evidence.map(toolEvidence);
  selected.currentTask.evidence = selected.currentTask.evidence.map(text =>
    Buffer.byteLength(JSON.stringify(text)) > 4096 ? excerpt(text, 4096) : text);
  while (!fits()) {
    if (selected.currentTask.evidence.length > 1) {
      // Drop older tool bulk before assistant conclusions; always keep newest evidence.
      const tool = tools.findIndex((isTool, i) => isTool && i < tools.length - 1);
      const index = tool < 0 ? 0 : tool;
      selected.currentTask.evidence.splice(index, 1); tools.splice(index, 1);
    } else if (selected.currentTask.messages.length > 2) {
      // Keep the original goal and newest user constraints; mark omitted middle history.
      selected.currentTask.messages.splice(1, 1);
    } else {
      const fields = [selected.currentTask.messages, selected.currentTask.evidence];
      let largest: { field: string[]; index: number; bytes: number } | undefined;
      for (const field of fields) for (const [index, text] of field.entries()) {
        const bytes = Buffer.byteLength(JSON.stringify(text));
        if (bytes > 512 && (!largest || bytes > largest.bytes)) largest = { field, index, bytes };
      }
      if (!largest) throw new ClassificationError("input-budget");
      largest.field[largest.index] = excerpt(largest.field[largest.index]!, Math.floor(largest.bytes / 2));
    }
  }
  return selected;
}
