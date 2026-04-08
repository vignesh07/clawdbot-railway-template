import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("healthz exposes workspace diagnostics", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /function workspaceDiagnostics\(/);
  assert.match(src, /preflightScriptPresent/);
  assert.match(src, /memoryPresent/);
  assert.match(src, /wrapper:\s*\{[\s\S]*workspace:\s*workspaceDiagnostics\(\)/);
});

test("boot sync persists agents workspace config", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /config", "set", "agents\.defaults\.workspace"/);
  assert.match(src, /syncPersistentWorkspaceConfig/);
});
