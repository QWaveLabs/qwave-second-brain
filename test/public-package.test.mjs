import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readInstallerDiagnostic } from "../scripts/diagnose.mjs";
import { scanPublicTree } from "../scripts/public-scrub.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("the public package explains the customer journey, privacy boundary, and release limits", async () => {
  const [readme, prompt, license, notices] = await Promise.all([
    (await import("node:fs/promises")).readFile(path.join(root, "README.md"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(root, "CUSTOMER_PROMPT.md"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(root, "LICENSE"), "utf8"),
    (await import("node:fs/promises")).readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8")
  ]);
  assert.match(readme, /CUSTOMER_PROMPT\.md/);
  assert.match(prompt, /I want to set up my QWave Second Brain\./);
  assert.match(readme, /public setup repository is live/i);
  assert.match(readme, /## Why this exists/);
  assert.match(readme, /## How the system behaves/);
  assert.match(readme, /## Privacy model/);
  assert.match(readme, /## Sources and connectors: current truth/);
  assert.match(readme, /## Vault ownership, history, and backups/);
  assert.match(readme, /## Current release boundary/);
  assert.match(readme, /does \*\*not\*\* yet prove a finished backup, restore, or\s+clean-Mac recovery journey/i);
  assert.match(readme, /production-ready testing candidate, not a proven production customer rollout/i);
  assert.match(prompt, /one question at a time/i);
  assert.match(prompt, /do not ask me to use Terminal or run commands/i);
  assert.match(readme, /one normal-language prompt/i);
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
    repository: "public QWave Git repository",
    visibilityReadbackRequiredBeforeClone: true,
    remotesConfigured: true
  });
  assert.equal(diagnostic.migration.backupBeforeChangeRequired, true);
  assert.match(diagnostic.releaseLimitations.join(" "), /clean-Mac, live connector, provider delivery/i);
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
