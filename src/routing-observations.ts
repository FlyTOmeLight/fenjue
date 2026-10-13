import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { classifierUsage, type ClassifierUsage } from "./classification.js";

export interface RoutingCall {
  time: string; threadId: string; taskId?: string; callId: string; decisionId: string; phase: string;
  elapsedMs: number | null; pending?: true; httpAttempted: boolean | null; usage: ClassifierUsage; error?: string;
}
// Read completed records only; a crash may leave an unfinished final line.
export async function routingCalls(directory: string): Promise<RoutingCall[]> {
  const names = await readdir(directory).catch(e => { if (e.code === "ENOENT") return []; throw e; });
  const calls = new Map<string, RoutingCall>();
  for (const name of names.filter(n => /^native-\d+-\d+\.jsonl$/.test(n)).sort()) {
    const text = await readFile(join(directory, name), "utf8");
    for (const line of text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.type === "classification-started" && !calls.has(row.callId)) {
        calls.set(row.callId, { ...row, elapsedMs: null, pending: true, httpAttempted: null, usage: classifierUsage(null) });
      }
      if (row.type === "classification-call") calls.set(row.callId, row);
    }
  }
  return [...calls.values()];
}
export function routingCost(calls: RoutingCall[]) {
  const counted = calls.filter(c => c.httpAttempted !== false);
  const sum = (key: keyof ClassifierUsage) => counted.length && counted.every(c => c.usage[key] !== null) ?
    counted.reduce((n, c) => n + c.usage[key]!, 0) : counted.length ? null : 0;
  return { calls: calls.length, httpAttempts: calls.filter(c => c.httpAttempted === true).length,
    pending: calls.filter(c => c.pending).length, timedCalls: calls.filter(c => c.elapsedMs !== null).length,
    unknownAttempts: calls.filter(c => c.httpAttempted === null).length, errors: calls.filter(c => c.error).length,
    elapsedMs: calls.reduce((n, c) => n + (c.elapsedMs ?? 0), 0), usage: { input: sum("input"), output: sum("output"),
      total: sum("total"), cachedInput: sum("cachedInput"), reasoning: sum("reasoning") } };
}
