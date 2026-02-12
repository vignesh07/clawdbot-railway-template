import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("setup auth advanced toggle insertion uses a valid sibling reference", () => {
  const src = fs.readFileSync(new URL("../src/setup-app.js", import.meta.url), "utf8");

  // Regression guard for DOM NotFoundError:
  // insertBefore(newNode, authChoiceEl.parentNode) is invalid because
  // authChoiceEl.parentNode is the container itself, not its child.
  assert.doesNotMatch(src, /insertBefore\(advancedToggle,\s*authChoiceEl\.parentNode\)/);
});
