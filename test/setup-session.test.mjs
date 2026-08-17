import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_EXAMPLES,
  FileStateStore,
  MacOSDesktopVaultAdapter,
  MacOSObsidianAdapter,
  SETUP_STAGES,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  SimulatedObsidianAdapter,
  continueSetupSession,
  getSetupSessionStatus,
  startSetupSession
} from "../src/index.mjs";

async function withSessionFixture(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa138-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const environment = new SimulatedEnvironmentAdapter(options.environment);
  const obsidian = new SimulatedObsidianAdapter(options.obsidian);
  const vault = new SimulatedDesktopVaultAdapter(options.vault);
  const adapters = { environment, obsidian, vault };

  try {
    await run({ directory, stateStore, adapters, environment, obsidian, vault });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bootstrapInput(overrides = {}) {
  return {
    message: BOOTSTRAP_EXAMPLES.en,
    answers: {
      displayName: "Alex",
      focus: "prepare better for this week’s meetings"
    },
    decisions: {
      vaultName: "My Second Brain"
    },
    ...overrides
  };
}

test("a plain-language bootstrap completes through the public Setup Session boundary", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    const outcome = await startSetupSession(bootstrapInput({ stateStore, adapters }));

    assert.equal(outcome.setupSession.status, "complete");
    assert.equal(outcome.setupSession.stage, "complete");
    assert.match(outcome.transcript[0].message, /one step at a time/i);
    assert.equal(outcome.vault.desktopPath, "/simulated/Desktop/My Second Brain");
    assert.deepEqual(outcome.vault.files, ["Home.md", "System/Status.md"]);
    assert.equal(outcome.savedSetup.answers.focus, "prepare better for this week’s meetings");
    assert.equal(outcome.savedSetup.safeDecisions.vaultName, "My Second Brain");
    assert.equal(outcome.savedSetup.validation.vault.exists, true);
    assert.match(outcome.limitation, /simulated Desktop vault/i);
  });
});

test("an existing official Obsidian installation is detected without modifying existing vaults", async () => {
  await withSessionFixture(async ({ stateStore, adapters, obsidian }) => {
    const existingBefore = [
      { path: "/simulated/Desktop/Work Notes", files: ["Private.md"] },
      { path: "/simulated/Documents/Journal", files: ["2026-08-17.md"] }
    ];
    obsidian.existingVaults = structuredClone(existingBefore);

    const outcome = await startSetupSession(bootstrapInput({ stateStore, adapters }));

    assert.equal(outcome.setupSession.status, "complete");
    assert.equal(outcome.savedSetup.validation.obsidian.official, true);
    assert.equal(outcome.savedSetup.validation.obsidian.existingVaultCount, 2);
    assert.equal(outcome.savedSetup.validation.obsidian.existingVaultsReadOnly, true);
    assert.deepEqual(obsidian.getExistingVaults(), existingBefore);
    assert.equal(obsidian.officialInstallActionCalls, 0);
    assert.equal(obsidian.installCalls, 0);
    assert.deepEqual(obsidian.openedVaultPaths, ["/simulated/Desktop/My Second Brain"]);
  });
});

test("a missing Obsidian app produces one approved official action and waits for detection", async () => {
  await withSessionFixture(async ({ stateStore, adapters, obsidian }) => {
    const awaitingApproval = await startSetupSession(bootstrapInput({ stateStore, adapters }));

    assert.equal(awaitingApproval.setupSession.status, "waiting_for_approval");
    assert.equal(awaitingApproval.setupSession.pendingAction.kind, "approve-official-obsidian-install");
    assert.equal(awaitingApproval.setupSession.pendingAction.approvalRequired, true);
    assert.equal(obsidian.officialInstallActionCalls, 0);
    assert.equal(obsidian.installCalls, 0, "the setup never installs software itself");

    const awaitingCustomer = await continueSetupSession({
      message: "Continue setting up my second brain",
      action: { kind: "approve-official-obsidian-install", approved: true },
      stateStore,
      adapters
    });

    assert.equal(awaitingCustomer.setupSession.status, "waiting_for_customer_action");
    assert.equal(awaitingCustomer.setupSession.pendingAction.customerAction.url, "https://obsidian.md/download");
    assert.equal(obsidian.officialInstallActionCalls, 1);
    assert.equal(obsidian.installCalls, 0, "approval creates an official action, not an installation");

    await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters
    });
    assert.equal(obsidian.officialInstallActionCalls, 1, "resume does not duplicate the customer action");

    obsidian.simulateCustomerInstalledOfficialObsidian();
    const completed = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters
    });

    assert.equal(completed.setupSession.status, "complete");
    assert.equal(completed.savedSetup.validation.obsidian.openVerified, true);
    assert.equal(obsidian.installCalls, 0);
  }, { obsidian: { installed: false, official: false } });
});

test("the customer vault uses the visible Desktop default or an approved renamed path", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    const defaultVault = await startSetupSession(bootstrapInput({ stateStore, adapters }));
    assert.equal(defaultVault.vault.desktopPath, "/simulated/Desktop/My Second Brain");
  });

  await withSessionFixture(async ({ stateStore, adapters }) => {
    const renamedVault = await startSetupSession(bootstrapInput({
      stateStore,
      adapters,
      decisions: { vaultName: "Rob's Command Center" }
    }));
    assert.equal(renamedVault.vault.name, "Rob's Command Center");
    assert.equal(renamedVault.vault.desktopPath, "/simulated/Desktop/Rob's Command Center");
  });
});

test("an existing vault at the requested Desktop path is never changed and can be renamed on resume", async () => {
  await withSessionFixture(async ({ stateStore, adapters, obsidian, vault }) => {
    const existingBefore = [{ path: "/simulated/Desktop/My Second Brain", files: ["Do Not Touch.md"] }];
    obsidian.existingVaults = structuredClone(existingBefore);

    const blocked = await startSetupSession(bootstrapInput({ stateStore, adapters }));
    assert.equal(blocked.setupSession.status, "blocked");
    assert.match(blocked.setupSession.message, /existing vault/i);
    assert.equal(vault.ensureCalls, 0);
    assert.deepEqual(obsidian.getExistingVaults(), existingBefore);

    const resumed = await continueSetupSession({
      message: "Continue setting up my second brain",
      decisions: { vaultName: "My Safe Second Brain" },
      stateStore,
      adapters
    });

    assert.equal(resumed.setupSession.status, "complete");
    assert.equal(resumed.vault.desktopPath, "/simulated/Desktop/My Safe Second Brain");
    assert.deepEqual(obsidian.getExistingVaults(), existingBefore);
    assert.equal(vault.ensureCalls, 1);
  });
});

test("a shared macOS profile blocks safely before Obsidian or vault actions", async () => {
  await withSessionFixture(async ({ stateStore, adapters, obsidian, vault }) => {
    const blocked = await startSetupSession(bootstrapInput({ stateStore, adapters }));

    assert.equal(blocked.setupSession.status, "blocked");
    assert.match(blocked.setupSession.message, /shared/i);
    assert.equal(obsidian.inspectCalls, 0);
    assert.equal(vault.ensureCalls, 0);
  }, { environment: { sharedProfile: true } });
});

test("the injected Obsidian open verifier must pass, then retries through the same Setup Session", async () => {
  await withSessionFixture(async ({ stateStore, adapters, obsidian, vault }) => {
    const blocked = await startSetupSession(bootstrapInput({ stateStore, adapters }));

    assert.equal(blocked.setupSession.status, "blocked");
    assert.equal(blocked.setupSession.stage, "vault");
    assert.match(blocked.setupSession.message, /opened the new vault/i);
    assert.equal(vault.ensureCalls, 1);
    assert.equal(obsidian.openCalls, 1);

    const resumed = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters
    });

    assert.equal(resumed.setupSession.status, "complete");
    assert.equal(vault.ensureCalls, 1, "retry does not recreate the customer vault");
    assert.equal(obsidian.openCalls, 2);
    assert.equal(resumed.savedSetup.validation.obsidian.openedVaultPath, "/simulated/Desktop/My Second Brain");
  }, { obsidian: { openFailuresBeforeSuccess: 1 } });
});

test("the guarded macOS adapters use an approved temporary Desktop path and injected exact-open verifier", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa140-macos-adapter-"));
  const desktopRoot = path.join(directory, "Desktop");
  const approvedVaultPath = path.join(desktopRoot, "My Second Brain");
  const appPath = "/Applications/Obsidian.app";
  const registryPath = "/simulated/obsidian.json";
  const openedCommands = [];
  const verificationSleeps = [];
  let observedOpenPath = null;
  let openReadbacks = 0;
  let registryReadbacks = 0;
  const fakeObsidianFileSystem = {
    async stat(candidate) {
      if (candidate === appPath) return { isDirectory: () => true };
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    },
    async readFile(candidate) {
      if (candidate === path.join(appPath, "Contents", "Info.plist")) {
        return "<plist><dict><key>CFBundleIdentifier</key><string>md.obsidian</string></dict></plist>";
      }
      if (candidate === registryPath) {
        registryReadbacks += 1;
        return JSON.stringify({
          vaults: {
            existing: { path: "/simulated/Desktop/Existing", open: false },
            ...(registryReadbacks > 1 ? { generated: { path: approvedVaultPath, open: true } } : {})
          }
        });
      }
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    }
  };
  const vault = new MacOSDesktopVaultAdapter({
    desktopRoot,
    approvedVaultPath,
    allowCreate: true,
    simulated: true
  });
  const obsidian = new MacOSObsidianAdapter({
    appPath,
    vaultRegistryPath: registryPath,
    approvedVaultPath,
    allowVaultOpen: true,
    fileSystem: fakeObsidianFileSystem,
    runOpenCommand: async (command) => {
      openedCommands.push(command);
      observedOpenPath = command.vaultPath;
      return { started: true };
    },
    readOpenVaultPath: async () => {
      openReadbacks += 1;
      return openReadbacks < 3 ? null : observedOpenPath;
    },
    openVerificationAttempts: 3,
    openVerificationDelayMs: 0,
    sleep: async (delay) => verificationSleeps.push(delay),
    simulated: true
  });
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));

  try {
    await mkdir(desktopRoot, { recursive: true });
    const outcome = await startSetupSession({
      ...bootstrapInput(),
      stateStore,
      adapters: {
        environment: new SimulatedEnvironmentAdapter(),
        obsidian,
        vault
      }
    });

    assert.equal(outcome.setupSession.status, "complete");
    assert.equal(outcome.vault.desktopPath, approvedVaultPath);
    assert.equal(outcome.savedSetup.validation.obsidian.openVerified, true);
    assert.match(outcome.limitation, /simulated Desktop vault and Obsidian adapters/i);
    assert.deepEqual(openedCommands, [{ appPath, vaultPath: approvedVaultPath, vaultId: "generated" }]);
    assert.deepEqual(verificationSleeps, [0, 0], "open is read back until the active-window probe confirms the exact path");
    assert.match(await readFile(path.join(approvedVaultPath, "Home.md"), "utf8"), /Current focus/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a generated vault waits for the one official Obsidian registration action and resumes without rebuilding it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa140-registration-"));
  const desktopRoot = path.join(directory, "Desktop");
  const approvedVaultPath = path.join(desktopRoot, "My Second Brain");
  const appPath = "/Applications/Obsidian.app";
  const registryPath = "/simulated/obsidian-registration.json";
  let registered = false;
  let uriCommands = 0;
  const fakeObsidianFileSystem = {
    async stat(candidate) {
      if (candidate === appPath) return { isDirectory: () => true };
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    },
    async readFile(candidate) {
      if (candidate === path.join(appPath, "Contents", "Info.plist")) {
        return "<plist><dict><key>CFBundleIdentifier</key><string>md.obsidian</string></dict></plist>";
      }
      if (candidate === registryPath) {
        return JSON.stringify({
          vaults: registered
            ? { generated: { path: approvedVaultPath, open: true } }
            : {}
        });
      }
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    }
  };
  const vault = new MacOSDesktopVaultAdapter({
    desktopRoot,
    approvedVaultPath,
    allowCreate: true,
    simulated: true
  });
  const obsidian = new MacOSObsidianAdapter({
    appPath,
    vaultRegistryPath: registryPath,
    approvedVaultPath,
    allowVaultOpen: true,
    fileSystem: fakeObsidianFileSystem,
    runOpenCommand: async ({ vaultId }) => {
      assert.equal(vaultId, "generated");
      uriCommands += 1;
      return { started: true };
    },
    readOpenVaultPath: async () => registered ? approvedVaultPath : null,
    simulated: true
  });
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));

  try {
    await mkdir(desktopRoot, { recursive: true });
    const paused = await startSetupSession({
      ...bootstrapInput(),
      stateStore,
      adapters: { environment: new SimulatedEnvironmentAdapter(), obsidian, vault }
    });

    assert.equal(paused.setupSession.status, "waiting_for_customer_action");
    assert.equal(paused.setupSession.stage, "vault");
    assert.equal(paused.setupSession.pendingAction.kind, "open-generated-vault-in-obsidian");
    assert.equal(paused.setupSession.pendingAction.customerAction.desktopPath, approvedVaultPath);
    assert.equal(uriCommands, 0, "the vault is not treated as registered before the customer uses Obsidian's official picker");
    assert.match(await readFile(path.join(approvedVaultPath, "Home.md"), "utf8"), /Current focus/);

    registered = true;
    const completed = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters: { environment: new SimulatedEnvironmentAdapter(), obsidian, vault }
    });

    assert.equal(completed.setupSession.status, "complete");
    assert.equal(uriCommands, 1);
    assert.equal(completed.savedSetup.validation.obsidian.openedVaultPath, approvedVaultPath);
    assert.equal((await readdir(desktopRoot)).filter((name) => name === "My Second Brain").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple registry open flags never substitute for a trusted active-window probe", async () => {
  const appPath = "/Applications/Obsidian.app";
  const registryPath = "/simulated/ambiguous-obsidian.json";
  const approvedVaultPath = "/simulated/Desktop/My Second Brain";
  let openCommands = 0;
  const fakeObsidianFileSystem = {
    async stat(candidate) {
      if (candidate === appPath) return { isDirectory: () => true };
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    },
    async readFile(candidate) {
      if (candidate === path.join(appPath, "Contents", "Info.plist")) {
        return "<plist><dict><key>CFBundleIdentifier</key><string>md.obsidian</string></dict></plist>";
      }
      if (candidate === registryPath) {
        return JSON.stringify({
          vaults: {
            existing: { path: "/simulated/Desktop/Existing", open: true },
            generated: { path: approvedVaultPath, open: true }
          }
        });
      }
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    }
  };
  const obsidian = new MacOSObsidianAdapter({
    appPath,
    vaultRegistryPath: registryPath,
    approvedVaultPath,
    allowVaultOpen: true,
    fileSystem: fakeObsidianFileSystem,
    runOpenCommand: async () => {
      openCommands += 1;
      return { started: true };
    },
    simulated: true
  });

  const result = await obsidian.verifyVaultOpen({ path: approvedVaultPath });
  assert.deepEqual(result, {
    opened: false,
    path: null,
    code: "ACTIVE_VAULT_READBACK_REQUIRED",
    simulated: true
  });
  assert.equal(openCommands, 0, "a URI launch is not attempted when the active-window evidence cannot be read safely");
});

test("a guarded macOS vault resumes an injected write failure without touching a pre-existing vault", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa140-vault-retry-"));
  const desktopRoot = path.join(directory, "Desktop");
  const approvedVaultPath = path.join(desktopRoot, "My Second Brain");
  const existingVaultPath = path.join(desktopRoot, "Existing Vault");
  const appPath = "/Applications/Obsidian.app";
  const registryPath = "/simulated/obsidian.json";
  let failTargetHomeOnce = true;
  let registryReadbacks = 0;
  const flakyFileSystem = {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile: async (candidate, content, options) => {
      if (candidate === path.join(approvedVaultPath, "Home.md") && failTargetHomeOnce) {
        failTargetHomeOnce = false;
        throw new Error("Injected target Home write failure");
      }
      return writeFile(candidate, content, options);
    }
  };
  const fakeObsidianFileSystem = {
    async stat(candidate) {
      if (candidate === appPath) return { isDirectory: () => true };
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    },
    async readFile(candidate) {
      if (candidate === path.join(appPath, "Contents", "Info.plist")) {
        return "<plist><dict><key>CFBundleIdentifier</key><string>md.obsidian</string></dict></plist>";
      }
      if (candidate === registryPath) {
        registryReadbacks += 1;
        return JSON.stringify({
          vaults: registryReadbacks > 1
            ? { generated: { path: approvedVaultPath, open: true } }
            : {}
        });
      }
      throw Object.assign(new Error("Not found"), { code: "ENOENT" });
    }
  };
  const vault = new MacOSDesktopVaultAdapter({
    desktopRoot,
    approvedVaultPath,
    allowCreate: true,
    fileSystem: flakyFileSystem,
    simulated: true
  });
  const obsidian = new MacOSObsidianAdapter({
    appPath,
    vaultRegistryPath: registryPath,
    approvedVaultPath,
    allowVaultOpen: true,
    fileSystem: fakeObsidianFileSystem,
    runOpenCommand: async () => ({ started: true }),
    readOpenVaultPath: async () => approvedVaultPath,
    simulated: true
  });
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));

  try {
    await mkdir(existingVaultPath, { recursive: true });
    await writeFile(path.join(existingVaultPath, "Do Not Touch.md"), "customer content\n", "utf8");

    const blocked = await startSetupSession({
      ...bootstrapInput(),
      stateStore,
      adapters: {
        environment: new SimulatedEnvironmentAdapter(),
        obsidian,
        vault
      }
    });
    assert.equal(blocked.setupSession.status, "blocked");
    assert.equal(blocked.setupSession.stage, "foundation");
    assert.equal(await readFile(path.join(existingVaultPath, "Do Not Touch.md"), "utf8"), "customer content\n");
    assert.equal(
      (await readdir(desktopRoot)).some((name) => name.startsWith("My Second Brain.qwave-second-brain-staging-")),
      false,
      "the installer cleans only its verified staging folder after the failed write"
    );

    const resumed = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters: {
        environment: new SimulatedEnvironmentAdapter(),
        obsidian,
        vault
      }
    });
    assert.equal(resumed.setupSession.status, "complete");
    assert.match(await readFile(path.join(approvedVaultPath, "Home.md"), "utf8"), /Current focus/);
    assert.equal(await readFile(path.join(existingVaultPath, "Do Not Touch.md"), "utf8"), "customer content\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("slash commands are rejected in favor of the ordinary-language entry point", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    await assert.rejects(
      () => startSetupSession({ ...bootstrapInput({ stateStore, adapters }), message: "/setup-second-brain" }),
      /do not need a command/i
    );
  });
});

test("a resume request also remains an ordinary-language chat request", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    await startSetupSession({
      ...bootstrapInput({ stateStore, adapters }),
      stopAfterStage: "environment"
    });
    await assert.rejects(
      () => continueSetupSession({ stateStore, adapters }),
      /tell me you would like to set up your second brain/i
    );
  });
});

test("a vault name cannot escape the customer Desktop boundary", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    await assert.rejects(
      () => startSetupSession({
        ...bootstrapInput({ stateStore, adapters }),
        decisions: { vaultName: "../not-a-vault" }
      }),
      /without slashes/i
    );
  });
});

test("every completed stage survives interruption and resumes without a duplicate vault", async () => {
  for (const stopAfterStage of SETUP_STAGES) {
    await withSessionFixture(async ({ directory, adapters, vault }) => {
      const firstStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
      const paused = await startSetupSession({
        ...bootstrapInput({ stateStore: firstStore, adapters }),
        stopAfterStage
      });

      assert.equal(paused.setupSession.status, "paused");
      assert.equal(paused.setupSession.stage, stopAfterStage);

      // A new setup object simulates a new Codex context, process, or interruption.
      const resumedStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
      const resumed = await continueSetupSession({
        message: "Continue setting up my second brain",
        stateStore: resumedStore,
        adapters
      });

      assert.equal(resumed.setupSession.status, "complete");
      assert.equal(resumed.transcript.filter((entry) => entry.stage === stopAfterStage).length, 1);
      assert.equal(vault.createdVaults, 1, `no duplicate vault after ${stopAfterStage}`);
      assert.deepEqual(resumed.vault.files, ["Home.md", "System/Status.md"]);
    });
  }
});

test("rerunning a completed Setup Session is idempotent through the public boundary", async () => {
  await withSessionFixture(async ({ stateStore, adapters, vault }) => {
    const first = await startSetupSession(bootstrapInput({ stateStore, adapters }));
    const second = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters
    });

    assert.equal(second.setupSession.status, "complete");
    assert.equal(vault.ensureCalls, 1);
    assert.equal(vault.createdVaults, 1);
    assert.deepEqual(second.transcript, first.transcript);
    assert.deepEqual(second.vault, first.vault);
  });
});

test("a failed simulated vault stage records a safe retry point and resumes from it", async () => {
  await withSessionFixture(async ({ directory, adapters, vault }) => {
    const statePath = path.join(directory, "private-state", "setup-session.json");
    const blocked = await startSetupSession({
      ...bootstrapInput({ stateStore: new FileStateStore(statePath), adapters })
    });

    assert.equal(blocked.setupSession.status, "blocked");
    assert.equal(blocked.setupSession.stage, "foundation");
    assert.match(blocked.setupSession.message, /did not finish/i);

    const resumed = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore: new FileStateStore(statePath),
      adapters
    });

    assert.equal(resumed.setupSession.status, "complete");
    assert.equal(vault.ensureCalls, 2);
    assert.equal(vault.createdVaults, 1);
    assert.equal(resumed.transcript.filter((entry) => entry.stage === "foundation").length, 1);
  }, { vault: { failuresBeforeSuccess: 1 } });
});

test("the persisted setup remains visible through the public read-only status boundary", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    await startSetupSession({
      message: BOOTSTRAP_EXAMPLES.es,
      answers: { displayName: "Lucía", focus: "prepararme para reuniones" },
      decisions: { vaultName: "Mi Segundo Cerebro" },
      stateStore,
      adapters,
      stopAfterStage: "foundation"
    });

    const status = await getSetupSessionStatus({ stateStore });
    assert.equal(status.setupSession.stage, "foundation");
    assert.equal(status.savedSetup.safeDecisions.language, "es");
    assert.equal(status.savedSetup.answers.displayName, "Lucía");
    assert.equal(status.savedSetup.validation.foundation.hasFocus, true);
  });
});
