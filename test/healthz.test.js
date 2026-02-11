import test from "node:test";
import assert from "node:assert/strict";

// Minimal regression guard: ensure the server source contains the public /healthz endpoint.
// (This repo doesn't have an easy way to import the express app without starting a server.)
import fs from "node:fs";

test("server exposes /healthz endpoint", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /app\.get\("\/healthz"/);
});
