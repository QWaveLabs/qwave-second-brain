import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readInstallerDiagnostic } from "../scripts/diagnose.mjs";
import { scanPublicTree } from "../scripts/public-scrub.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("the release package points customers to one ordinary-language prompt and records its limits", async () => {
  const [readme, prompt, license, notices] = await Promise.all([
    (await import("node:fs/promises")).readFile(path.join(root, "README.md"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(root, "CUSTOMER_PROMPT.md"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(root, "LICENSE"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8")
  ]);
  assert.match(readme, /CUSTOMER_PROMPT\.md/);
  assert.match(prompt, /I want to set up my QWave Second Brain\./);
  assert.match(readme, /public MIT bootstrap paired with a private\s+QWave runtime/i);
  assert.match(prompt, /one question at a time/i);
  assert.match(prompt, /do not ask me to use Terminal or run commands/i);
  assert.match(readme, /no configured Git remote/i);
  assert.match(license, /^MIT License/m);
  assert.match(notices, /Nate Herk/);
});

test("installer diagnostics expose version, supported environment, migration boundary, and honest release limitations", async () => {
  const diagnostic = await readInstallerDiagnostic();
  assert.equal(diagnostic.installerVersion, "0.1.0");
  assert.equal(diagnostic.setupStateSchemaVersion, 4);
  assert.equal(diagnostic.supportedEnvironment.platform, "macOS private user account");
  assert.deepEqual(diagnostic.supportedEnvironment.languages, ["English", "Spanish"]);
  assert.equal(diagnostic.customerOwnership.publicVaultRepository, false);
  assert.deepEqual(diagnostic.distribution, {
    bootstrap: "public MIT source",
    runtime: "private QWave Git repository",
    runtimeVisibilityReadbackRequiredBeforeClone: true,
    remotesConfigured: false
  });
  assert.equal(diagnostic.migration.backupBeforeChangeRequired, true);
  assert.match(diagnostic.releaseLimitations.join(" "), /No Git remote is configured/i);
});

test("the public scrub catches protected runtime artifacts and credential-like files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-public-scrub-"));
  try {
    await mkdir(path.join(directory, "customer-vaults"));
    await writeFile(path.join(directory, "customer-vaults", "Home.md"), "private customer note");
    await writeFile(path.join(directory, "credentials.json"), "{}");
    const findings = await scanPublicTree(directory);
    assert.deepEqual(findings, [
      { kind: "forbidden-file", path: "credentials.json" },
      { kind: "forbidden-directory", path: "customer-vaults" }
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
