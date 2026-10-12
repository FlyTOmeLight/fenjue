import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { EvaluationClient } from "../scripts/native-evaluation-client.js";

async function fixture(t: any, handle: (message: any, reply: (message: any) => void, close: () => void) => void) {
  const root = await mkdtemp(join(tmpdir(), "fenjue-eval-client-")), socket = join(root, "app.sock");
  const http = createServer(), ws = new WebSocketServer({ server: http });
  ws.on("connection", client => client.on("message", data => handle(JSON.parse(data.toString()),
    message => client.send(JSON.stringify(message)), () => client.close())));
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(socket, resolve); });
  const client = new EvaluationClient(socket, () => {});
  t.after(async () => {
    client.close(); for (const connection of ws.clients) connection.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve())); await rm(root, { recursive: true, force: true });
  });
  return client;
}

test("evaluation completion sent before the start response is still observable", async t => {
  const client = await fixture(t, (message, reply) => {
    if (message.method === "initialize") reply({ id: message.id, result: {} });
    if (message.method === "turn/start") {
      reply({ method: "turn/completed", params: { turn: { id: "early", status: "completed" } } });
      reply({ id: message.id, result: { turn: { id: "early" } } });
    }
  });
  await client.open(); const response = await client.request("turn/start", {});
  assert.equal((await client.completed(response.turn.id, 1000)).params.turn.status, "completed");
});

test("native disconnect rejects pending evaluation requests without waiting for the task deadline", async t => {
  const client = await fixture(t, (message, reply, close) => {
    if (message.method === "initialize") reply({ id: message.id, result: {} });
    if (message.method === "thread/start") close();
  });
  await client.open(); await assert.rejects(() => client.request("thread/start", {}, 1000), /closed/);
});
