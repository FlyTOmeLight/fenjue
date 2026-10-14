import test from "node:test";
import assert from "node:assert/strict";
import { desktopServerIndex } from "../src/desktop.js";

test("desktop wrapper only intercepts stdio app-server service invocations", () => {
  const cases: [string[], number][] = [
    [["app-server"], 0],
    [["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled", "-c", "key='has spaces'"], 2],
    [["app-server", "--listen", "stdio://"], 0],
    [["--config=a=1", "app-server", "--disable", "memories"], 1],
    [["--version"], -1],
    [["debug", "models", "--bundled"], -1],
    [["exec", "app-server"], -1],
    [["app-server", "daemon", "version"], -1],
    [["app-server", "generate-json-schema"], -1],
    [["app-server", "proxy"], -1],
    [["app-server", "--help"], -1],
    [["app-server", "--listen=ws://127.0.0.1:1234"], -1],
    [["--unknown", "app-server"], -1],
    [["-c", "app-server"], -1],
    [["--", "app-server"], -1],
  ];
  for (const [args, expected] of cases) assert.equal(desktopServerIndex(args), expected, JSON.stringify(args));
});
