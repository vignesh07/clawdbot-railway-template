import { spawnSync } from "node:child_process";

// Basic sanity: ensure the wrapper starts and the CLI exists.
const r = spawnSync("openclaw", ["--version"], { encoding: "utf8" });
if (r.status !== 0) {
  console.error(r.stdout || r.stderr);
  process.exit(r.status ?? 1);
}
console.log("openclaw ok:", r.stdout.trim());
