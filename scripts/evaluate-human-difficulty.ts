// Human difficulty is an ordinal reference, not a gold effort/model label.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { readConfig } from "../src/config.js";
import { createClassifier, QUESTIONS, CONSTRAINT_QUESTION } from "../src/classification.js";
import { nativeSelection, nativePolicy } from "../src/native-policy.js";
import { fingerprint, type TaskView } from "../src/task-state.js";
import { usage } from "./compare-sol-routing.js";

export function difficultyView(prompt: string): TaskView {
  return { currentTask: { messages: [], evidence: [], incomplete: false }, newMessages: [prompt], evidence: [], incomplete: false };
}
export async function main(args: string[]) {
  const live = args.includes('--live');
  args = args.filter(a => a !== '--live');
  const flags = new Map<string, string>();
  while (args.length) {
    const f = args.shift()!, v = args.shift();
    if (!['--input', '--out', '--config', '--env-file', '--repeats', '--max-calls'].includes(f) || !v || flags.has(f)) throw Error(`Invalid flag ${f}`);
    flags.set(f, v);
  }
  if (!flags.has('--input') || !flags.has('--out')) throw Error('--input and --out required');
  const raw = await readFile(flags.get('--input')!, 'utf8'), data = JSON.parse(raw);
  const config = await readConfig(resolve(flags.get('--config') ?? 'fenjue.config.json'));
  if (!config.semantic || !Array.isArray(data.tasks) || !data.tasks.length) throw Error('Missing semantic config/tasks');
  const repeats = Number(flags.get('--repeats') ?? 2), maxCalls = Number(flags.get('--max-calls') ?? 0);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw Error('Invalid repeats');
  const plannedCalls = repeats * data.tasks.length;
  if (live && (!Number.isSafeInteger(maxCalls) || maxCalls < plannedCalls)) throw Error(`--max-calls must cover ${plannedCalls}`);
  for (const t of data.tasks) if (typeof t.prompt !== 'string' || !t.prompt || !Number.isSafeInteger(t.rank) || t.rank < 0 || typeof t.dataset !== 'string' || !t.dataset || typeof t.id !== 'string' || !t.id || typeof t.level !== 'string') throw Error('Invalid task');
  const key = config.semantic.apiKeyEnv;
  if (live && key && flags.has('--env-file')) process.env[key] = parseEnv(await readFile(flags.get('--env-file')!, 'utf8'))[key];
  if (live && key && !process.env[key]) throw Error(`Missing ${key}`);
  const constraints = config.native?.expertPolicy === 'constraints';
  const manifest = { version: 1, mode: live ? 'live' : 'preflight', startedAt: new Date().toISOString(), inputDigest: fingerprint(raw),
    sources: data.sources, questionnaireDigest: fingerprint({ QUESTIONS, ...(constraints ? { CONSTRAINT_QUESTION } : {}) }),
    policy: nativePolicy(config), semantic: { ...config.semantic }, routes: config.routes, expertModel: config.native?.expertModel,
    repeats, plannedCalls, note: 'Single-turn classification + nativeSelection. No task execution, human effort mapping, expert review, capacity handling or history. Raw inputs remain local.' };
  const out = resolve(flags.get('--out')!);
  await mkdir(dirname(out), { recursive: true, mode: 0o700 });
  const rows: any[] = [];
  const save = () => writeFile(out, JSON.stringify({ ...manifest, rows }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(out, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  if (!live) { console.log(JSON.stringify({ plannedCalls, actualCalls: 0 })); return; }
  let captured = usage(null);
  const classify = createClassifier(config.semantic, undefined, async (input, init) => {
    const response = await fetch(input, init);
    if (response.ok) captured = usage((await response.clone().json()).usage);
    return response;
  }, constraints);
  for (let repeat = 0; repeat < repeats; repeat++) for (const t of data.tasks) {
    captured = usage(null);
    const start = performance.now(), row: any = { repeat, dataset: t.dataset, idDigest: fingerprint(t.id), level: t.level, rank: t.rank, promptDigest: fingerprint(t.prompt) };
    try {
      const classification = await classify(difficultyView(t.prompt), new AbortController().signal);
      Object.assign(row, { classification, selection: nativeSelection(config, classification) });
    } catch (e) { row.error = e instanceof Error ? e.message : String(e); }
    Object.assign(row, { elapsedMs: Math.round(performance.now() - start), usage: captured });
    rows.push(row); await save();
    console.log(`${rows.length}/${plannedCalls} ${t.dataset} ${t.level} ${row.selection?.route.effort ?? row.error}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(e => { console.error(e); process.exitCode = 1; });
