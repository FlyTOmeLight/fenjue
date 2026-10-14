// Enter the normal CLI in the pane without passing user text through tmux's
// command parser or adding a second supervising process inside the pane.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const argv: string[] = JSON.parse(await readFile(process.argv[2]!, "utf8"));
// tmux retains a wait-for signal sent before the waiter starts. No timing
// delay is needed, and Codex keeps the pane process once the barrier opens.
await promisify(execFile)("tmux", ["-S", process.env.FENJUE_TMUX_SOCKET!, "wait-for", "fenjue-pane-ready"], { timeout: 5000 });
process.argv = [process.execPath, ...argv];
await import(pathToFileURL(argv[0]!).href);
