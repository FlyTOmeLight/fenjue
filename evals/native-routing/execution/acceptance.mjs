import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.FENJUE_WORKSPACE;
const task = process.argv[2];
const load = name => import(pathToFileURL(join(workspace, name)).href);
try {
  if (task === 'cross-known') {
    const { page } = await load('directory-service.mjs'), { collect } = await load('sync-service.mjs');
    const records = [1, 2, 3, 4].map(id => ({ id: String(id) }));
    assert.deepEqual(page(records, null, 2), { items: records.slice(0, 2), next: '2' });
    assert.deepEqual(page(records, '2', 2), { items: records.slice(2), next: null });
    assert.deepEqual(page([], null, 2), { items: [], next: null });
    assert.throws(() => page(records, 'missing', 2));
    for (const size of [0, -1, 1.5]) assert.throws(() => page(records, null, size));
    assert.deepEqual(await collect(async after => page(records, after, 2), 2), records);
    let calls = 0;
    assert.deepEqual(await collect(async () => ++calls === 1 ? { items: [], next: 'later' } : { items: [records[0]], next: null }, 2), [records[0]]);
    await assert.rejects(() => collect(async () => ({ items: [], next: 'loop' }), 2));
    const error = new Error('network');
    await assert.rejects(() => collect(async () => { throw error; }, 2), e => e === error);
  } else if (task === 'ledger-batch') {
    const { createLedger } = await load('ledger.mjs');
    const ledger = createLedger();
    const event = (id, version, value) => Object.freeze({ id, version, value });
    ledger.applyBatch(Object.freeze([event('a', 3, 'third'), event('b', 1, 'other')]));
    assert.equal(ledger.get('a'), undefined);
    assert.deepEqual(ledger.get('b'), { version: 1, value: 'other' });
    ledger.applyBatch([event('a', 1, 'first')]);
    assert.deepEqual(ledger.get('a'), { version: 1, value: 'first' });
    assert.throws(() => ledger.applyBatch([event('a', 2, 'second'), event('b', 1, 'conflict')]));
    assert.deepEqual(ledger.get('a'), { version: 1, value: 'first' });
    assert.deepEqual(ledger.get('b'), { version: 1, value: 'other' });
    ledger.applyBatch([event('a', 2, 'second')]);
    assert.deepEqual(ledger.get('a'), { version: 3, value: 'third' });
    ledger.applyBatch([event('a', 1, 'first'), event('a', 3, 'third')]);
    assert.throws(() => ledger.applyBatch([event('a', 1, 'changed')]));
    const read = ledger.get('a'); read.value = 'caller mutation';
    assert.equal(ledger.get('a').value, 'third');
    for (const bad of [null, {}, event('', 1, 'x'), event('x', 0, 'x'), event('x', 1.5, 'x'),
      event('x', Number.MAX_SAFE_INTEGER + 1, 'x'), event('x', 1, null)]) {
      assert.throws(() => ledger.applyBatch([event('a', 4, 'fourth'), bad]));
      assert.equal(ledger.get('a').version, 3);
    }
    for (const bad of [null, {}, 'events']) assert.throws(() => ledger.applyBatch(bad));
    ledger.applyBatch([]);
    assert.throws(() => ledger.applyBatch([event('c', 2, 'buffered'), event('c', 2, 'conflict')]));
    ledger.applyBatch([event('c', 1, 'first')]);
    assert.deepEqual(ledger.get('c'), { version: 1, value: 'first' });
    ledger.applyBatch([event('c', 2, 'second')]);
    assert.deepEqual(ledger.get('c'), { version: 2, value: 'second' });
    assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# Ledger\n\nIn-memory event ledger.\n');
  } else throw new Error('Unknown task');
  console.log(JSON.stringify({ passed: true }));
} catch (error) {
  console.log(JSON.stringify({ passed: false, error: String(error) })); process.exitCode = 1;
}
