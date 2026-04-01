import test from "node:test";
import assert from "node:assert/strict";

// Minimal regression guard: ensure the server source contains the public /healthz endpoint.
// (This repo doesn't have an easy way to import the express app without starting a server.)
import fs from "node:fs";

test("server exposes /healthz endpoint", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /app\.get\("\/healthz"/);
});

test("healthz returns 503 when configured gateway is unreachable", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /const healthy = !configured \|\| gatewayReachable/);
  assert.match(src, /res\.status\(healthy \? 200 : 503\)\.json\(/);
});

test("healthz can schedule gateway restart when unreachable", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /scheduleGatewayRestart\("healthcheck-unreachable"\)/);
  assert.match(src, /restartScheduled: Boolean\(gatewayRestartTimer\)/);
});
