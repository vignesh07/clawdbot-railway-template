import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ensurePreflightWorkspaceAssets,
  preflightBootstrapInternals,
} from "../src/preflight-bootstrap.js";

test("upsertManagedBlock appends and replaces managed AGENTS block", () => {
  const { AGENTS_BLOCK, upsertManagedBlock } = preflightBootstrapInternals;

  const initial = "# Custom\n";
  const withBlock = upsertManagedBlock(initial, AGENTS_BLOCK);
  assert.match(withBlock, /# Custom/);
  assert.match(withBlock, /openclaw-preflight:start/);

  const replaced = upsertManagedBlock(`${withBlock}\nextra`, AGENTS_BLOCK.replace("substantial work", "real work"));
  assert.match(replaced, /real work/);
  assert.equal((replaced.match(/openclaw-preflight:start/g) || []).length, 1);
});

test("ensurePreflightWorkspaceAssets seeds AGENTS, skill, and script", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-preflight-"));

  ensurePreflightWorkspaceAssets(tempDir);

  const agentsPath = path.join(tempDir, "AGENTS.md");
  const skillPath = path.join(tempDir, "skills", "preflight_snapshot", "SKILL.md");
  const scriptPath = path.join(tempDir, "bin", "preflight-snapshot.mjs");

  assert.equal(fs.existsSync(agentsPath), true);
  assert.equal(fs.existsSync(skillPath), true);
  assert.equal(fs.existsSync(scriptPath), true);

  const agents = fs.readFileSync(agentsPath, "utf8");
  const skill = fs.readFileSync(skillPath, "utf8");
  const script = fs.readFileSync(scriptPath, "utf8");

  assert.match(agents, /node \.\/bin\/preflight-snapshot\.mjs/);
  assert.match(skill, /Run a compact environment snapshot/);
  assert.match(script, /# Preflight Snapshot/);
});
