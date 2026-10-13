import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { difficultyView } from '../scripts/evaluate-human-difficulty.js';

test('classifier input contains only the prompt, no human label or solution', () => {
  assert.deepEqual(difficultyView('issue text'), { currentTask: { messages: [], evidence: [], incomplete: false }, newMessages: ['issue text'], evidence: [], incomplete: false });
});
test('public summary preserves ordering, ties and failure cost without exposing individual tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fenjue-human-summary-'));
  try {
    const input = join(dir, 'input.json'), out = join(dir, 'summary.json');
    const rows = [
      { rank: 0, level: 'easy', selection: { route: { model: 'main', effort: 'low' }, held: [] }, classification: { features: {} } },
      { rank: 1, level: 'middle', selection: { route: { model: 'main', effort: 'low' }, held: [] }, classification: { features: {} } },
      { rank: 2, level: 'hard', selection: { route: { model: 'main', effort: 'high' }, held: [] }, classification: { features: {} } },
      { rank: 2, level: 'hard', error: 'invalid-response' },
    ].map((r, i) => ({ ...r, idDigest: `PRIVATE-${i}`, prompt: 'PRIVATE-QUESTION', dataset: 'fixture', repeat: 0, elapsedMs: 10,
      usage: { input: 10, output: 2, total: 12, cachedInput: null, reasoning: null } }));
    await writeFile(input, JSON.stringify({ repeats: 1, plannedCalls: 4, sources: [], policy: 'fixture', questionnaireDigest: 'fixture-q', inputDigest: 'fixture-input', rows }));
    execFileSync('python3', ['scripts/summarize-human-difficulty.py', input, '--out', out]);
    const raw = await readFile(out, 'utf8'), data = JSON.parse(raw).datasets[0];
    assert.equal(raw.includes('PRIVATE-'), false);
    assert.deepEqual(data.pairs, { concordant: 2, discordant: 0, tied: 1 });
    assert.equal(data.httpAttempts, 4);
    assert.equal(data.successful, 3);
    assert.equal(data.usage.total.total, 48);
    assert.equal(data.usage.cachedInput.total, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
