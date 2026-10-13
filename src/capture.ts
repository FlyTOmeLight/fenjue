import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "./config.js";
import { fingerprint, readTaskInput, type TaskState } from "./task-state.js";

export interface CaptureItem { kind: "user" | "evidence"; text: string; incomplete?: boolean }
export interface CaptureFrame {
  version: 1; time: string; thread: string; identity: "provided" | "history";
  request: number; change: "append" | "reset"; items: CaptureItem[];
  context?: TaskState;
}

// Redaction applies only to the private corpus, never to the live model input.
// Arbitrary secrets in natural language still require review before sharing.
export function redactCapture(text: string, secrets: string[] = []): string {
  for (const secret of secrets.filter(s => s.length >= 8).sort((a, b) => b.length - a.length)) text = text.replaceAll(secret, "[REDACTED]");
  return text
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[REDACTED]")
    .replace(/(\b(?:[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|password)\s*["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      (_match, prefix: string, value: string) => prefix + (value.startsWith('"') ? '"[REDACTED]"' : value.startsWith("'") ? "'[REDACTED]'" : "[REDACTED]"));
}

interface History { timeline: string[]; seen: Set<string> }
export function createCapture(directory: string, run: string, secrets: string[], warn: () => void) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `capture-${run}.jsonl`);
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  const histories = new Map<string, History>();
  let disabled = false;
  return { path, observe(body: Record<string, unknown>, request: number): void {
    if (disabled) return;
    try {
      const parsed = readTaskInput(body), metadata = record(body.client_metadata) ? body.client_metadata : {};
      const identity = metadata.thread_id ?? body.prompt_cache_key;
      // Without an explicit identity, only complete history can join requests.
      // A tool-only request cannot be assigned to a guessed conversation.
      if (identity === undefined && !parsed.users.length) return;
      const thread = fingerprint(identity ?? ["history", parsed.users[0]!.fingerprint]);
      const ordered = [
        ...parsed.users.map(u => ({ position: u.position, item: { kind: "user", text: u.text, incomplete: u.incomplete } as CaptureItem })),
        ...parsed.evidence.map(e => ({ position: e.position, item: { kind: "evidence", text: e.text } as CaptureItem })),
      ].sort((a, b) => a.position - b.position).map(e => e.item);
      if (!ordered.length) return;
      const hashes = ordered.map(fingerprint), signature = fingerprint(hashes), previous = histories.get(thread);
      if (previous?.seen.has(signature)) return;
      let change: CaptureFrame["change"] = "append", added = ordered, timeline = hashes;
      if (previous) {
        if (previous.timeline.every((h, i) => hashes[i] === h)) {
          added = ordered.slice(previous.timeline.length);
        } else if (hashes.every((h, i) => previous.timeline[i] === h)) {
          return; // A late retry of an earlier full-history request.
        } else if (parsed.users.length > 1 || hashes[0] === previous.timeline[0]) {
          change = "reset"; // Changed/compacted history must be visible to review.
        } else {
          timeline = [...previous.timeline, ...hashes]; // Incremental user/tool input.
        }
      }
      if (!added.length) return;
      const frame: CaptureFrame = { version: 1, time: new Date().toISOString(), thread,
        identity: identity === undefined ? "history" : "provided", request, change,
        items: added.map(item => ({ ...item, text: redactCapture(item.text, secrets) })) };
      appendFileSync(path, JSON.stringify(frame) + "\n", { mode: 0o600 });
      const seen = previous?.seen ?? new Set<string>(); seen.add(signature);
      histories.set(thread, { timeline, seen });
    } catch {
      // Recording failure must not interrupt a working Codex response stream.
      disabled = true; warn();
    }
  } };
}
