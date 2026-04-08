import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("healthz exposes workspace diagnostics", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const healthzIdx = src.indexOf('app.get("/healthz"');
  assert.ok(healthzIdx >= 0);
  const window = src.slice(healthzIdx, healthzIdx + 900);
  assert.match(src, /function workspaceDiagnostics\(/);
  assert.match(window, /workspaceReady:/);
  assert.doesNotMatch(window, /workspace:\s*workspaceDiagnostics\(\)/);
});

test("boot sync persists agents workspace config", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /await syncPersistentWorkspaceConfig\(\)/);
  assert.match(src, /syncPersistentWorkspaceConfig/);
});
