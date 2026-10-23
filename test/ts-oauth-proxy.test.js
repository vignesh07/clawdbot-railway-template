import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("/ts-callback is proxied to the local OAuth server", () => {
  assert.match(src, /app\.use\(\["\/ts-callback"\]/);
  assert.match(src, /const tsOauthProxy = httpProxy\.createProxyServer\(\{ target: `http:\/\/127\.0\.0\.1:\$\{TS_OAUTH_PORT\}` \}\)/);
  assert.match(src, /\[ts-oauth-proxy\]/);
  assert.match(src, /TS OAuth server unavailable/);
});

test("/ts-callback bypasses dashboard auth (mounted before requireDashboardAuth)", () => {
  const tsIdx = src.indexOf('app.use(["/ts-callback"]');
  const authIdx = src.indexOf("app.use(requireDashboardAuth");
  assert.ok(tsIdx > 0 && authIdx > 0);
  assert.ok(tsIdx < authIdx, "ts-callback proxy must be registered before the auth-gated catch-all");
});

test("/ts-callback restores the original URL before proxying", () => {
  const block = src.slice(src.indexOf('app.use(["/ts-callback"]'), src.indexOf("app.use(requireDashboardAuth"));
  assert.match(block, /req\.url = req\.originalUrl/);
});
