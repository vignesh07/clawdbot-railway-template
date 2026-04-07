import fs from "node:fs";
import path from "node:path";

const MANAGED_START = "<!-- openclaw-preflight:start -->";
const MANAGED_END = "<!-- openclaw-preflight:end -->";

const AGENTS_BLOCK = `${MANAGED_START}
## Preflight Snapshot

For code, debugging, or terminal-heavy tasks in this workspace:

1. Run \`node ./bin/preflight-snapshot.mjs\` from the active project directory before substantial work.
2. Use that snapshot to ground the first plan in the real repo, runtimes, scripts, and constraints.
3. Do not waste early turns on basic discovery that the snapshot already covers.
4. Rerun only if the working directory, repo, or installed toolchain changed materially.
5. Never expose secret values; the snapshot reports environment context without dumping credentials.
${MANAGED_END}
`;

const SKILL_CONTENT = `---
name: preflight_snapshot
description: Run a compact environment snapshot before substantial coding or terminal work so planning uses the real repo, tools, and constraints.
---

# Preflight Snapshot

Use this skill for coding, debugging, refactoring, build, dependency, and terminal-heavy tasks.

Before substantial work:

1. Run \`node ./bin/preflight-snapshot.mjs\` from the active project directory.
2. Read the snapshot before forming the first concrete plan.
3. Reuse the snapshot instead of spending multiple turns on \`pwd\`, \`ls\`, \`git status\`, or runtime discovery.

Rerun the snapshot only when one of these is true:

- The user switches to a different repo or subproject
- You install or remove major tooling
- You change the working directory in a way that changes the task context

Use the snapshot to answer:

- What repo and branch am I in?
- Which runtimes and package managers are available?
- Which build/test entrypoints exist?
- What are the obvious top-level files and directories?
- What host and resource constraints should affect my plan?

Do not print or request secret values as part of preflight.
`;

const SCRIPT_CONTENT = `#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import childProcess from "node:child_process";

const argv = new Set(process.argv.slice(2));
const asJson = argv.has("--json");

function run(cmd, args, options = {}) {
  const result = childProcess.spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 2500,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
  });

  if (result.error) {
    return { ok: false, stdout: "", stderr: String(result.error.message || result.error) };
  }

  return {
    ok: result.status === 0,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    status: result.status,
  };
}

function which(bin) {
  const result = run("bash", ["-lc", \`command -v \${JSON.stringify(bin)}\`], { timeoutMs: 1500 });
  return result.ok ? result.stdout : "";
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listDirSafe(dirPath, limit = 30) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, limit)
      .map((entry) => entry.isDirectory() ? entry.name + "/" : entry.name);
  } catch {
    return [];
  }
}

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return \`\${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} \${units[unitIndex]}\`;
}

function collectGit(cwd) {
  const root = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (!root.ok || !root.stdout) {
    return null;
  }

  const branch = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).stdout || "unknown";
  const statusShort = run("git", ["status", "--short"], { cwd }).stdout;
  const head = run("git", ["rev-parse", "--short", "HEAD"], { cwd }).stdout || "unknown";

  return {
    root: root.stdout,
    branch,
    head,
    dirty: Boolean(statusShort),
    statusShort: statusShort ? statusShort.split("\\n").slice(0, 20) : [],
  };
}

function collectDisk(cwd) {
  const result = run("df", ["-h", cwd], { timeoutMs: 1500 });
  if (!result.ok || !result.stdout) return [];
  return result.stdout.split("\\n").filter(Boolean).slice(0, 2);
}

function collectPackageScripts(cwd) {
  const pkg = readJson(path.join(cwd, "package.json"));
  if (!pkg || !pkg.scripts || typeof pkg.scripts !== "object") return {};
  const keep = ["dev", "start", "build", "test", "lint", "smoke"];
  const out = {};
  for (const key of keep) {
    if (typeof pkg.scripts[key] === "string") out[key] = pkg.scripts[key];
  }
  return out;
}

function collectImportantFiles(cwd) {
  const candidates = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "Dockerfile",
    "docker-compose.yml",
    "Makefile",
    "README.md",
    "AGENTS.md",
  ];
  return candidates.filter((name) => fileExists(path.join(cwd, name)));
}

function collectRuntimes() {
  const bins = [
    "node",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "python3",
    "pip",
    "uv",
    "git",
    "rg",
    "cargo",
    "rustc",
    "go",
    "java",
    "javac",
    "docker",
  ];
  const out = {};
  for (const bin of bins) {
    const resolved = which(bin);
    if (resolved) out[bin] = resolved;
  }
  return out;
}

function collectWorkspaceContext() {
  const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || "";
  const stateDir = process.env.OPENCLAW_STATE_DIR || "";
  const workspaceSkillsDir = workspaceDir ? path.join(workspaceDir, "skills") : "";
  const workspaceBinDir = workspaceDir ? path.join(workspaceDir, "bin") : "";

  let skillCount = 0;
  if (workspaceSkillsDir && fileExists(workspaceSkillsDir)) {
    try {
      skillCount = fs.readdirSync(workspaceSkillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
    } catch {
      skillCount = 0;
    }
  }

  return {
    stateDir,
    workspaceDir,
    workspaceBinDir,
    workspaceSkillsDir,
    bootstrapScript: workspaceDir ? fileExists(path.join(workspaceDir, "bootstrap.sh")) : false,
    agentsMd: workspaceDir ? fileExists(path.join(workspaceDir, "AGENTS.md")) : false,
    skillCount,
  };
}

const cwd = process.cwd();
const git = collectGit(cwd);
const workspace = collectWorkspaceContext();
const snapshot = {
  cwd,
  host: {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    user: os.userInfo().username,
    cpus: os.cpus().length,
    totalMemory: formatBytes(os.totalmem()),
    freeMemory: formatBytes(os.freemem()),
  },
  git,
  repoTopLevel: listDirSafe(git?.root || cwd, 30),
  cwdTopLevel: listDirSafe(cwd, 30),
  importantFiles: collectImportantFiles(cwd),
  packageScripts: collectPackageScripts(cwd),
  runtimes: collectRuntimes(),
  disk: collectDisk(cwd),
  workspace,
};

if (asJson) {
  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\\n");
  process.exit(0);
}

const lines = [];
lines.push("# Preflight Snapshot");
lines.push("");
lines.push("## Environment");
lines.push(\`- cwd: \${snapshot.cwd}\`);
lines.push(\`- host: \${snapshot.host.platform} \${snapshot.host.arch} (\${snapshot.host.release}) on \${snapshot.host.hostname}\`);
lines.push(\`- user: \${snapshot.host.user}\`);
lines.push(\`- cpu: \${snapshot.host.cpus} cores\`);
lines.push(\`- memory: \${snapshot.host.freeMemory} free / \${snapshot.host.totalMemory} total\`);
if (snapshot.disk.length > 0) {
  lines.push(\`- disk: \${snapshot.disk.join(" | ")}\`);
}
lines.push("");
lines.push("## Repo");
if (snapshot.git) {
  lines.push(\`- root: \${snapshot.git.root}\`);
  lines.push(\`- branch: \${snapshot.git.branch}\`);
  lines.push(\`- head: \${snapshot.git.head}\`);
  lines.push(\`- dirty: \${snapshot.git.dirty ? "yes" : "no"}\`);
  if (snapshot.git.statusShort.length > 0) {
    lines.push("- status:");
    for (const entry of snapshot.git.statusShort) {
      lines.push(\`  - \${entry}\`);
    }
  }
} else {
  lines.push("- git: not a repository");
}
lines.push("");
lines.push("## Files");
lines.push(\`- repo top level: \${snapshot.repoTopLevel.join(", ") || "(none)"}\`);
if (snapshot.cwd !== snapshot.git?.root) {
  lines.push(\`- cwd top level: \${snapshot.cwdTopLevel.join(", ") || "(none)"}\`);
}
lines.push(\`- important files: \${snapshot.importantFiles.join(", ") || "(none)"}\`);
lines.push("");
lines.push("## Tooling");
lines.push(\`- runtimes: \${Object.keys(snapshot.runtimes).length ? Object.entries(snapshot.runtimes).map(([name, resolved]) => \`\${name}=\${resolved}\`).join(", ") : "(none detected)"}\`);
const scriptEntries = Object.entries(snapshot.packageScripts);
lines.push(\`- package scripts: \${scriptEntries.length ? scriptEntries.map(([name, script]) => \`\${name}: \${script}\`).join(" | ") : "(none)"}\`);
lines.push("");
lines.push("## OpenClaw Workspace");
lines.push(\`- state dir: \${snapshot.workspace.stateDir || "(unset)"}\`);
lines.push(\`- workspace dir: \${snapshot.workspace.workspaceDir || "(unset)"}\`);
lines.push(\`- workspace bin dir: \${snapshot.workspace.workspaceBinDir || "(unset)"}\`);
lines.push(\`- skills dir: \${snapshot.workspace.workspaceSkillsDir || "(unset)"}\`);
lines.push(\`- workspace AGENTS.md present: \${snapshot.workspace.agentsMd ? "yes" : "no"}\`);
lines.push(\`- workspace bootstrap.sh present: \${snapshot.workspace.bootstrapScript ? "yes" : "no"}\`);
lines.push(\`- workspace skill count: \${snapshot.workspace.skillCount}\`);
lines.push("");
lines.push("## Planning Guidance");
lines.push("- Use this snapshot instead of spending early turns on basic environment discovery.");
lines.push("- Respect the current repo state before editing or resetting anything.");
lines.push("- If the task changes repos, subprojects, or toolchains, rerun the snapshot.");

process.stdout.write(lines.join("\\n") + "\\n");
`;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // best-effort
  }
}

function upsertManagedBlock(existing, block) {
  const hasStart = existing.includes(MANAGED_START);
  const hasEnd = existing.includes(MANAGED_END);

  if (hasStart && hasEnd) {
    return existing.replace(
      new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, "m"),
      block,
    );
  }

  if (!existing.trim()) return block;
  return `${existing.replace(/\s*$/, "")}\n\n${block}`;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function ensurePreflightWorkspaceAssets(workspaceDir) {
  if (!workspaceDir) return;

  ensureDir(workspaceDir);

  const binDir = path.join(workspaceDir, "bin");
  const skillsDir = path.join(workspaceDir, "skills", "preflight_snapshot");
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  const scriptPath = path.join(binDir, "preflight-snapshot.mjs");
  const skillPath = path.join(skillsDir, "SKILL.md");

  ensureDir(binDir);
  ensureDir(skillsDir);

  const existingAgents = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, "utf8") : "";
  const nextAgents = upsertManagedBlock(existingAgents, AGENTS_BLOCK);
  if (nextAgents !== existingAgents) {
    fs.writeFileSync(agentsPath, nextAgents, "utf8");
  }

  if (!fs.existsSync(scriptPath) || fs.readFileSync(scriptPath, "utf8") !== SCRIPT_CONTENT) {
    fs.writeFileSync(scriptPath, SCRIPT_CONTENT, "utf8");
  }
  ensureExecutable(scriptPath);

  if (!fs.existsSync(skillPath) || fs.readFileSync(skillPath, "utf8") !== SKILL_CONTENT) {
    fs.writeFileSync(skillPath, SKILL_CONTENT, "utf8");
  }
}

export const preflightBootstrapInternals = {
  AGENTS_BLOCK,
  SKILL_CONTENT,
  SCRIPT_CONTENT,
  upsertManagedBlock,
};
