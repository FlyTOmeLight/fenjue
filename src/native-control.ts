import { request } from "node:http";
import type { NativeMode } from "./native-records.js";

export async function nativeControl(socket: string, mode: NativeMode): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, method: "POST", path: `/mode/${mode}`, timeout: 3000 }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.once("end", () => res.statusCode === 200 ? resolve(text) : reject(new Error(text.trim())));
    });
    req.once("error", reject); req.once("timeout", () => req.destroy(new Error("路由控制超时"))); req.end();
  });
}
