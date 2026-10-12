import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseExecutionSuite, acceptTask, copySnapshot, snapshotFiles } from "../src/task-evaluation.js";

test("native admission execution verifiers reject original snapshots and accept independent reference repairs", async t => {
  const suiteDirectory = resolve("evals/native-routing/execution");
  const suite = parseExecutionSuite(JSON.parse(await readFile(join(suiteDirectory, "suite.json"), "utf8")));
  const directory = await mkdtemp(join(tmpdir(), "fenjue-native-verifiers-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const task of suite.tasks) {
    const source = join(suiteDirectory, task.snapshot), workspace = join(directory, task.id);
    await copySnapshot(source, workspace, await snapshotFiles(source));
    const original = await acceptTask(task, suiteDirectory, workspace, "unused");
    assert.equal(original.valid, true, original.output); assert.equal(original.passed, false, task.id);
    if (task.id === "cross-known") {
      await writeFile(join(workspace, "directory-service.mjs"), `export function page(records,after,size){
if(!Number.isInteger(size)||size<=0)throw new Error('size');
const start=after===null?0:records.findIndex(r=>r.id===after)+1;
if(after!==null&&start===0)throw new Error('cursor');
const items=records.slice(start,start+size);return {items,next:start+items.length<records.length?items.at(-1).id:null};
}`);
      await writeFile(join(workspace, "sync-service.mjs"), `export async function collect(fetchPage,size){
const items=[],seen=new Set();let cursor=null;
do{const page=await fetchPage(cursor,size);items.push(...page.items);cursor=page.next;
if(cursor!==null){if(seen.has(cursor))throw new Error('cycle');seen.add(cursor);}}while(cursor!==null);return items;
}`);
    } else if (task.id === "ledger-batch") {
      await writeFile(join(workspace, "ledger.mjs"), `export function createLedger(){
let history=new Map();
return {applyBatch(events){
if(!Array.isArray(events))throw new Error('array');
const next=new Map([...history].map(([id,versions])=>[id,new Map(versions)]));
for(const e of events){
if(!e||typeof e.id!=='string'||!e.id||!Number.isSafeInteger(e.version)||e.version<1||typeof e.value!=='string')throw new Error('event');
const versions=next.get(e.id)??new Map();
if(versions.has(e.version)&&versions.get(e.version)!==e.value)throw new Error('conflict');
versions.set(e.version,e.value);next.set(e.id,versions);}
history=next;
},get(id){const versions=history.get(id);let version=0;while(versions?.has(version+1))version++;
return version?{version,value:versions.get(version)}:undefined;}};
}`);
      await writeFile(join(workspace, "README.md"), "# Ledger\n\nIn-memory event ledger.\n");
    }
    const repaired = await acceptTask(task, suiteDirectory, workspace, "unused");
    assert.equal(repaired.valid, true, repaired.output); assert.equal(repaired.passed, true, repaired.output);
  }
});
