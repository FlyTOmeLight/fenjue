import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { startNativeGateway } from "../src/native-gateway.js";
import { NativeRecords } from "../src/native-records.js";
import { semanticConfig } from "./fixtures.js";

test("gateway accepts resume after picker disconnects and still rejects simultaneous clients", { timeout: 5000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "fenjue-gateway-test-"));
  const executable = join(root, "backend.mjs"), socket = join(root, "app.sock");
  await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: message.id, result: { pid: process.pid } }) + '\\n');
});
// Keep the old backend alive long enough to overlap the new connection.
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150));
`);
  await chmod(executable, 0o700);
  const failures: Error[] = [], clients: WebSocket[] = [];
  const gateway = await startNativeGateway({ socket, executable, serverArgs: [], env: process.env,
    config: semanticConfig(), records: new NativeRecords(root, undefined, [], message => assert.fail(message)),
    onFailure: error => failures.push(error) });
  t.after(async () => {
    for (const client of clients) client.terminate();
    await gateway.close(); await rm(root, { recursive: true, force: true });
  });
  async function connect() {
    const client = new WebSocket(`ws+unix://${socket}:/`); clients.push(client);
    await once(client, "open"); return client;
  }
  async function request(client: WebSocket, method = "initialize") {
    const response = Promise.race([
      once(client, "message").then(([data]) => JSON.parse(data.toString())),
      once(client, "close").then(([code, reason]) => { throw new Error(`${code}: ${reason}`); }),
    ]);
    client.send(JSON.stringify({ id: 1, method, params: { clientInfo: { name: "test", version: "1" } } }));
    return response;
  }
  const picker = await connect(), first = await request(picker);
  const duplicate = await connect();
  const [code, reason] = await once(duplicate, "close");
  assert.equal(code, 1008); assert.equal(reason.toString(), "One Codex client per gateway");
  const disconnected = once(picker, "close"); picker.close(); await disconnected;
  const resumed = await connect(), second = await request(resumed);
  assert.notEqual(first.result.pid, second.result.pid);
  const deadline = Date.now() + 2000;
  while (true) {
    try { process.kill(first.result.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") break; throw error; }
    assert.ok(Date.now() < deadline, "picker backend must exit after disconnect");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await request(resumed, "thread/list")).result.pid, second.result.pid, "old backend exit must not close resumed session");
  assert.deepEqual(failures, []);
});
