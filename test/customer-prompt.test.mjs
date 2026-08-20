import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("the customer receives one direct prompt that clones the private repository and starts a guided setup", async () => {
  const [prompt, instructions] = await Promise.all([
    readFile(path.join(root, "CUSTOMER_PROMPT.md"), "utf8"),
    readFile(path.join(root, "AGENTS.md"), "utf8")
  ]);

  assert.match(prompt, /https:\/\/github\.com\/QWaveLabs\/qwave-second-brain/);
  assert.match(prompt, /do not ask me to use Terminal or run commands/i);
  assert.match(prompt, /Ask only one question at a time/i);
  assert.match(prompt, /protected setup to resume/i);
  assert.match(prompt, /private Obsidian Second Brain/i);
  assert.match(instructions, /take ownership of the\s+technical work/i);
  assert.match(instructions, /specific source permission/i);
  assert.match(instructions, /ready, imported, skipped,\s*beta-only, or blocked/i);
});
