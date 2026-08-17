import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_EXAMPLES,
  FileStateStore,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  continueSetupSession,
  getSetupSessionStatus,
  startSetupSession
} from "../src/index.mjs";

async function withSessionFixture(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa138-"));
  const stateStore = new FileStateStore(path.join(directory, "private-state", "setup-session.json"));
  const environment = new SimulatedEnvironmentAdapter(options.environment);
  const vault = new SimulatedDesktopVaultAdapter(options.vault);
  const adapters = { environment, vault };

  try {
    await run({ directory, stateStore, adapters, environment, vault });
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
  for (const stopAfterStage of ["environment", "foundation", "vault", "validation"]) {
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
