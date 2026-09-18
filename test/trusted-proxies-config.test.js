import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("setup writes gateway.trustedProxies with both IPv4 and IPv6 loopback", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /gateway\.trustedProxies/);
  // The wrapper sits on loopback and forwards requests to the gateway with
  // X-Forwarded-* headers. Both IPv4 and IPv6 loopback must be trusted so
  // OpenClaw 2026.9.4's strict proxy attribution accepts the wrapper.
  assert.match(src, /127\.0\.0\.1/);
  assert.match(src, /::1/);
});

test("boot path migrates gateway.trustedProxies for pre-existing configs", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  // The migration runs alongside the existing "syncing gateway tokens" boot block.
  const idx = src.indexOf("[wrapper] syncing gateway tokens in config...");
  assert.ok(idx >= 0, "expected the token-sync boot block");
  const window = src.slice(idx, idx + 4000);
  assert.match(
    window,
    /migrating: setting gateway\.trustedProxies/,
    "expected migration log message",
  );
  assert.match(
    window,
    /JSON\.stringify\(\[\s*"127\.0\.0\.1"\s*,\s*"::1"\s*\]\)/,
    "expected migration to set both IPv4 and IPv6 loopback",
  );
});
