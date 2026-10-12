import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const workspace = process.env.FENJUE_WORKSPACE;
const load = name => import(pathToFileURL(join(workspace, name)).href);
const task = process.argv[2];
try {
  if (task === 'mechanical-doc') {
    assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), '# Demo\n\nInstall with `npm ci`.\n\nRun `npm start`. Keep this command unchanged.\n');
  } else if (task === 'csv-feature') {
    const { parseCSV } = await load('csv.mjs');
    for (const [input, expected] of [
      ['', []], ['a,b\n', [['a', 'b']]], ['a,b\r\nx,y', [['a','b'],['x','y']]],
      ['"a,b","x""y"\n"multi\nline",', [['a,b','x"y'],['multi\nline','']]],
      [',,', [['','','']]], ['"",b\n', [['','b']]], ['a\n\n', [['a'],['']]],
    ]) assert.deepEqual(parseCSV(input), expected);
    for (const input of ['"open', '"a"x,b']) assert.throws(() => parseCSV(input));
  } else if (task === 'local-diagnosis') {
    const { runPool } = await load('pool.mjs');
    let active = 0, peak = 0;
    const jobs = [40, 5, 15, 2].map((ms, i) => async () => {
      active++; peak = Math.max(peak, active);
      try { await new Promise(resolve => setTimeout(resolve, ms)); if (i === 2) throw new Error('expected failure'); return i; }
      finally { active--; }
    });
    const results = await runPool(jobs, 2);
    assert.ok(peak <= 2); assert.deepEqual(results.map(r => r.status), ['fulfilled','fulfilled','rejected','fulfilled']);
    assert.deepEqual(results.map(r => r.value), [0,1,undefined,3]); assert.equal(results[2].reason.message, 'expected failure');
    assert.deepEqual(await runPool([], 1), []);
    for (const limit of [0,-1,1.5,NaN]) await assert.rejects(async () => runPool([], limit), RangeError);
  } else if (task === 'cross-known') {
    const { page } = await load('directory-service.mjs'), { collect } = await load('sync-service.mjs');
    const records = [1,2,3,4].map(id => ({id: String(id)}));
    assert.deepEqual(page(records, null, 2), {items:records.slice(0,2),next:'2'});
    assert.deepEqual(page(records, '2', 2), {items:records.slice(2),next:null});
    assert.deepEqual(page([], null, 2), {items:[],next:null});
    assert.throws(() => page(records, 'missing', 2)); assert.throws(() => page(records,null,0));
    assert.deepEqual(await collect(async after => page(records,after,2), 2), records);
    let calls = 0;
    assert.deepEqual(await collect(async () => ++calls === 1 ? {items:[],next:'later'} : {items:[records[0]],next:null},2), [records[0]]);
    await assert.rejects(() => collect(async () => ({items:[],next:'loop'}), 2));
    const failure = new Error('network'); await assert.rejects(() => collect(async () => {throw failure;},2), e => e === failure);
  } else if (task === 'cross-unknown') {
    const { Projection } = await load('projection-service.mjs');
    const projection = new Projection();
    for (const event of [{id:'a',version:2,value:'new'},{id:'a',version:1,value:'old'},
      {id:'a',version:2,value:'duplicate'},{id:'b',version:1,value:'other'}]) projection.apply(event);
    assert.equal(projection.get('a'),'new'); assert.equal(projection.get('b'),'other');
    for (const version of [0,-1,1.5,NaN,'3']) assert.throws(() => projection.apply({id:'a',version,value:'bad'}));
    assert.equal(projection.get('a'),'new'); projection.apply({id:'a',version:3,value:null}); assert.equal(projection.get('a'),null);
    assert.equal(await readFile(join(workspace,'source-service.mjs'),'utf8'), 'export async function publish(items, deliver) {\n  for (const item of items) { await deliver(item); await deliver(item); }\n}\n');
  } else if (task === 'multi-turn') {
    const { search } = await load('search.mjs');
    const items = Object.freeze([Object.freeze({label:'Cafe\u0301'}),Object.freeze({label:'OTHER'}),Object.freeze({label:'CAFÉ'})]);
    assert.deepEqual(search(items,'café'), [items[0],items[2]]);
    assert.equal(search(items,'CAFÉ')[0],items[0]); assert.deepEqual(search(items,''),items);
    assert.deepEqual(search(items,'other'),[items[1]]);
  } else throw new Error('Unknown task');
  console.log(JSON.stringify({passed:true}));
} catch (error) {
  console.log(JSON.stringify({passed:false,error:String(error)})); process.exitCode=1;
}
