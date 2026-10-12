import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { gunzipSync, inflateSync } from "node:zlib";
import { AUTO_MODEL, PROXY_HEADER, record, upstreamURL, type Config } from "./config.js";
import type { Catalog } from "./catalog.js";
import { Router } from "./routing.js";
import type { Classification, Classify } from "./classification.js";

export interface Event {
  event: "request" | "completed" | "failed";
  request: number;
  model?: string;
  effort?: string;
  route?: string;
  reason?: string;
  status?: number;
  servedModel?: string;
  elapsedMs?: number;
  mode?: "shadow" | "auto";
  suggestedModel?: string;
  suggestedEffort?: string;
  classificationReason?: string;
  decisionConfidence?: number;
  classification?: Classification;
  boundaryClassification?: Classification;
}
const LIMIT = 16 * 1024 * 1024;
class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
function headers(input: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const blocked = new Set(["connection","keep-alive","proxy-authenticate","proxy-authorization","te","trailer","transfer-encoding","upgrade","host", PROXY_HEADER]);
  for (const field of String(input.connection ?? "").split(",")) blocked.add(field.trim().toLowerCase());
  return Object.fromEntries(Object.entries(input).filter(([k]) => !blocked.has(k.toLowerCase())));
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0, settled = false;
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > LIMIT) { settled = true; reject(new HttpError(413, "请求超过 16 MiB")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
    req.on("aborted", () => reject(new Error("Client aborted")));
  });
  const encoding = req.headers["content-encoding"];
  if (!encoding || encoding === "identity") return data;
  try {
    if (encoding === "gzip") return gunzipSync(data, { maxOutputLength: LIMIT });
    if (encoding === "deflate") return inflateSync(data, { maxOutputLength: LIMIT });
  } catch { throw new HttpError(400, "无法解压请求或解压后超过 16 MiB"); }
  throw new HttpError(415, "不支持该请求压缩格式；启动器应禁用请求压缩");
}
function fail(res: ServerResponse, status: number, message: string): void {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error: { type: "fenjue_error", message } }));
}
export async function startProxy(config: Config, catalog: Catalog, onEvent: (event: Event) => void = () => {}, classify?: Classify,
  onAccepted?: (body: Record<string, unknown>, request: number) => void) {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(token);
  const router = new Router(config, classify);
  const controllers = new Set<AbortController>();
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  const base = upstreamURL(config);
  let counter = 0;
  let authority = "";
  const server = http.createServer((req, res) => {
    const credential = Buffer.from(String(req.headers[PROXY_HEADER] ?? ""));
    if (req.headers.origin || req.headers.host !== authority || credential.length !== expected.length || !timingSafeEqual(credential, expected)) {
      fail(res, 403, "仅接受本次启动的本地 Codex 请求"); return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    req.once("aborted", () => controller.abort());
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    void handle(req, res, controller.signal).catch(error => {
      fail(res, error instanceof HttpError ? error.status : 502, error instanceof HttpError ? error.message : "上游连接失败或流中断");
    }).finally(() => controllers.delete(controller));
  });
  server.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"));
  async function handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const path = req.url ?? "/";
    if (req.method === "GET" && /^\/models(?:\?|$)/.test(path)) {
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(catalog)); return;
    }
    if (req.method !== "POST" || !/^\/responses(?:\/(?:compact|lite))?(?:\?[^#]*)?$/.test(path)) throw new HttpError(404, "不支持的 Codex 路径");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse((await readBody(req)).toString("utf8"));
      if (!record(parsed)) throw new Error("object required");
      body = parsed;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "请求必须为 JSON 对象");
    }
    if (signal.aborted) return;
    let prepared: Awaited<ReturnType<Router["prepare"]>>;
    try { prepared = await router.prepare(body, signal); }
    catch (e) { throw new HttpError(409, (e as Error).message); }
    if (signal.aborted) return;
    if (body.model === AUTO_MODEL) throw new HttpError(409, "auto 模型未解析");
    const out = Buffer.from(JSON.stringify(body));
    const forwarding = headers(req.headers);
    delete forwarding["content-encoding"];
    forwarding["content-length"] = out.length;
    const id = ++counter, started = Date.now();
    onEvent({ event: "request", request: id, model: String(body.model), effort: record(body.reasoning) ? String(body.reasoning.effort ?? "") : undefined,
      route: prepared.decision?.route, reason: prepared.decision?.reason ?? "manual",
      mode: prepared.decision?.mode, suggestedModel: prepared.decision?.suggestedModel, suggestedEffort: prepared.decision?.suggestedEffort,
      classificationReason: prepared.decision?.classificationReason, classification: prepared.decision?.classification,
      boundaryClassification: prepared.decision?.boundaryClassification,
      decisionConfidence: prepared.decision?.decisionConfidence });
    try {
      await new Promise<void>((resolve, reject) => {
        const transport = base.protocol === "https:" ? https : http;
        const upstream = transport.request({
          protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ""), port: base.port,
          path: base.pathname.replace(/\/$/, "") + path,
          method: "POST", headers: forwarding, signal,
          agent: base.protocol === "https:" ? httpsAgent : httpAgent,
        }, response => {
          const status = response.statusCode ?? 502;
          if (status >= 200 && status < 300) { prepared.accept(); onAccepted?.(body, id); }
          const responseHeaders = headers(response.headers);
          // The CLI interprets any reported model differing from its alias as an
          // upstream safety reroute. Normalize only the model WE selected. An
          // unexpected upstream fallback remains visible, with all safety events.
          if (prepared.decision) {
            for (const key of ["openai-model", "x-openai-model"]) {
              const reported = responseHeaders[key];
              if (typeof reported === "string" && reported.toLowerCase() === String(body.model).toLowerCase()) responseHeaders[key] = AUTO_MODEL;
            }
          }
          res.writeHead(status, responseHeaders);
          // pipeline preserves bytes, applies backpressure, and propagates cancellation/errors.
          void pipeline(response, res, { signal }).then(() => {
            const reportedModel = response.headers["openai-model"] ?? response.headers["x-openai-model"];
            onEvent({ event: "completed", request: id, status, elapsedMs: Date.now() - started,
              servedModel: typeof reportedModel === "string" ? reportedModel : undefined });
            resolve();
          }, reject);
        });
        upstream.setTimeout(300_000, () => upstream.destroy(new Error("Upstream idle timeout")));
        upstream.once("error", reject);
        upstream.end(out);
      });
    } catch (e) {
      onEvent({ event: "failed", request: id, reason: signal.aborted ? "cancelled" : "upstream-error", elapsedMs: Date.now() - started });
      throw e;
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法获得代理端口");
  authority = `127.0.0.1:${address.port}`;
  return {
    url: `http://${authority}`, token,
    async close(): Promise<void> {
      for (const controller of controllers) controller.abort();
      router.close();
      httpAgent.destroy(); httpsAgent.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
