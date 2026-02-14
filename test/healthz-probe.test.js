import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("healthz implements probeGateway (TCP connect)", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /async function probeGateway\(/);
  assert.match(src, /node:net/);
});
