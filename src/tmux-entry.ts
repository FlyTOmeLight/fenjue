// Enter the normal CLI in the pane without passing user text through tmux's
// command parser or adding a second supervising process inside the pane.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const argv: string[] = JSON.parse(await readFile(process.argv[2]!, "utf8"));
process.argv = [process.execPath, ...argv];
await import(pathToFileURL(argv[0]!).href);
