import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentOverview } from "../src/workstudio/gateway-client.js";

test("buildAgentOverview combines agents.list roster with session activity", () => {
  const roster = [
    {
      id: "main",
      name: "Main",
      effectiveModel: { id: "openai/gpt-5.6-sol" },
      effectiveRuntime: { id: "codex" },
      isDefault: true,
    },
    {
      id: "market-scout",
      name: "Market Scout",
      model: "openai/gpt-5.6-sol",
    },
    {
      id: "designer",
      name: "Designer",
      model: "openai/gpt-5.6-sol",
    },
  ];

  const sessions = [
    {
      key: "agent:main:direct",
      agentId: "main",
      running: true,
      updatedAt: "2026-11-03T02:00:00.000Z",
    },
    {
      key: "agent:market-scout:weekly",
      agentId: "market-scout",
      status: "failed",
      updatedAt: "2026-11-03T01:00:00.000Z",
    },
  ];

  const overview = buildAgentOverview(roster, sessions);

  assert.equal(overview.length, 3);

  const main = overview.find((agent) => agent.agentId === "main");
  assert.deepEqual(main, {
    agentId: "main",
    name: "Main",
    team: null,
    status: "working",
    model: "openai/gpt-5.6-sol",
    runtime: "codex",
    kind: null,
    isDefault: true,
    lastActivityAt: "2026-11-03T02:00:00.000Z",
    activeSession: "agent:main:direct",
    sessionCount: 1,
  });

  const scout = overview.find((agent) => agent.agentId === "market-scout");
  assert.equal(scout.status, "error");
  assert.equal(scout.activeSession, null);
  assert.equal(scout.model, "openai/gpt-5.6-sol");

  const designer = overview.find((agent) => agent.agentId === "designer");
  assert.equal(designer.status, "idle");
  assert.equal(designer.lastActivityAt, null);
  assert.equal(designer.sessionCount, 0);
});
