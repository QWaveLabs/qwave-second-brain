import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_EXAMPLES,
  FileStateStore,
  ONBOARDING_BATCHES,
  SimulatedDesktopVaultAdapter,
  SimulatedEnvironmentAdapter,
  continueOnboardingSession,
  continueSetupSession,
  getOnboardingSessionStatus,
  startOnboardingSession,
  startSetupSession
} from "../src/index.mjs";

async function withSessionFixture(run, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qwave-second-brain-qwa141-"));
  const statePath = path.join(directory, "private-state", "setup-session.json");
  const stateStore = new FileStateStore(statePath);
  const environment = new SimulatedEnvironmentAdapter(options.environment);
  const vault = new SimulatedDesktopVaultAdapter(options.vault);
  const adapters = { environment, vault };

  try {
    await run({ directory, statePath, stateStore, adapters, environment, vault });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function bootstrapInput({ language = "en", answers = {}, decisions = {}, stateStore, adapters, clock } = {}) {
  return {
    message: language === "es" ? BOOTSTRAP_EXAMPLES.es : BOOTSTRAP_EXAMPLES.en,
    answers: {
      displayName: "Alex Rivera",
      focus: "prepare calmly for the week",
      ...answers
    },
    decisions: {
      vaultName: language === "es" ? "Mi Segundo Cerebro" : "My Second Brain",
      ...decisions
    },
    stateStore,
    adapters,
    clock
  };
}

async function completeBootstrap(input) {
  return startSetupSession(bootstrapInput(input));
}

test("four bilingual recommendation-led batches persist all accepted decisions and write a safe vault proof", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    await completeBootstrap({ stateStore, adapters });

    let outcome = await startOnboardingSession({
      message: "I am ready to define my foundation.",
      stateStore,
      adapters
    });

    assert.equal(ONBOARDING_BATCHES.length, 4);
    for (const batch of ONBOARDING_BATCHES) {
      assert.equal(outcome.onboarding.status, "active");
      assert.equal(outcome.currentBatch.id, batch.id);
      assert.equal(outcome.currentBatch.questions.length, 5);
      assert.equal(outcome.currentBatch.recommendations.length, 5);
      assert.match(outcome.currentBatch.progress, /Batch \d of 4/);

      outcome = await continueOnboardingSession({
        message: "I accept the visible recommendations.",
        stateStore,
        adapters
      });
    }

    assert.equal(outcome.onboarding.status, "complete");
    assert.equal(outcome.onboarding.progress.completedBatches, 4);
    assert.equal(outcome.foundation.identity.name, "Alex Rivera");
    assert.deepEqual(outcome.foundation.roles, ["personal", "professional"]);
    assert.deepEqual(outcome.foundation.includedAreas, ["personal", "business"]);
    assert.deepEqual(outcome.foundation.privateAreas, ["private-conversations", "financial-details", "health-details"]);
    assert.equal(outcome.foundation.successDefinition, "see-priorities-and-next-actions");
    assert.deepEqual(outcome.vault.files, ["Home.md", "Identity.md", "Priorities.md", "Scope.md", "System/Privacy.md"]);
    assert.equal(outcome.vault.readBack, true);
    assert.match(outcome.vault.verifiedContents["Identity.md"], /Alex Rivera/);
    assert.match(outcome.vault.verifiedContents["Priorities.md"], /prepare calmly for the week/);
    assert.match(outcome.vault.verifiedContents["System/Privacy.md"], /Financial details/);

    const completedBatches = outcome.transcript.filter((entry) => entry.type === "batch_completed");
    assert.equal(completedBatches.length, 4);
    assert.equal(completedBatches.flatMap((entry) => entry.decisions).length, 20);
    assert.ok(completedBatches.flatMap((entry) => entry.decisions).every((decision) => decision.source === "accepted_recommendation"));
    assert.match(outcome.limitation, /simulated local vault adapter/i);
  });
});

test("previously captured facts are shown once as confirmations and mixed-language names and quotations remain byte-for-byte intact", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    const exactName = "María \"Lola\" O’Neill";
    const exactOutcome = "Keep the promise: “No traduzcas esta frase.”";
    await completeBootstrap({
      language: "es",
      stateStore,
      adapters,
      answers: {
        displayName: exactName,
        focus: exactOutcome
      }
    });

    let outcome = await startOnboardingSession({
      message: "Quiero completar las preguntas de base.",
      stateStore,
      adapters,
      knownFacts: {
        roles: {
          value: ["Fundadora", "Mamá"],
          source: "perfil aprobado"
        }
      }
    });

    const nameQuestion = outcome.currentBatch.questions.find((question) => question.id === "identity.name");
    const rolesQuestion = outcome.currentBatch.questions.find((question) => question.id === "roles");
    assert.equal(nameQuestion.mode, "confirm");
    assert.equal(nameQuestion.knownFact.value, exactName);
    assert.equal(rolesQuestion.mode, "confirm");
    assert.deepEqual(rolesQuestion.knownFact, {
      value: ["Fundadora", "Mamá"],
      source: "perfil aprobado"
    });
    assert.equal(outcome.currentBatch.questions.filter((question) => question.id === "identity.name").length, 1);
    assert.equal(outcome.currentBatch.questions.filter((question) => question.id === "roles").length, 1);

    outcome = await continueOnboardingSession({
      message: "Acepto las recomendaciones.",
      stateStore,
      adapters,
      stopAfterBatch: "identity"
    });
    const identityCompletion = outcome.transcript.find((entry) => entry.type === "batch_completed");
    const acceptedName = identityCompletion.decisions.find((decision) => decision.id === "identity.name");
    assert.equal(acceptedName.value, exactName);
    assert.equal(acceptedName.confirmedKnownFact, true);

    outcome = await continueOnboardingSession({
      message: "Continuemos.",
      stateStore,
      adapters
    });
    assert.equal(outcome.currentBatch.id, "outcomes");

    while (outcome.onboarding.status !== "complete") {
      outcome = await continueOnboardingSession({
        message: "Acepto las recomendaciones visibles.",
        stateStore,
        adapters
      });
    }

    assert.equal(outcome.foundation.identity.name, exactName);
    assert.equal(outcome.foundation.desiredOutcome, exactOutcome);
    assert.ok(outcome.vault.verifiedContents["Identity.md"].includes(exactName));
    assert.ok(outcome.vault.verifiedContents["Priorities.md"].includes(exactOutcome));

    await assert.rejects(
      () => continueOnboardingSession({
        message: "/accept-recommendations",
        stateStore,
        adapters
      }),
      /do not need a command/i
    );
  });
});

test("English and Spanish paths produce equivalent structured foundations when the same decisions are supplied", async () => {
  const clock = { now: () => new Date("2026-08-17T15:00:00.000Z") };
  const answersByBatch = {
    identity: {
      "identity.name": "Jordan “Rio” Lee",
      roles: ["Founder", "Padre"],
      "identity.organizations": ["Café Río Azul"],
      "identity.primaryLanguage": "bilingual",
      "identity.workingStyle": "brief and practical"
    },
    outcomes: {
      desiredOutcome: "Know the right next move every morning.",
      next90DayPriorities: ["Launch “Proyecto Río”", "Protect family time"],
      currentProjects: ["Proyecto Río"],
      reviewCadence: "Friday afternoon",
      first90DayMilestone: "A trusted weekly review"
    },
    scope: {
      includedAreas: ["personal", "business"],
      "scope.businessAreas": ["QWave"],
      "scope.personalAreas": ["Familia"],
      "scope.inclusionRule": "Only what supports active priorities",
      "scope.outOfScopeAreas": ["Old archives"]
    },
    "privacy-success": {
      privateAreas: ["Conversaciones con “Mamá”"],
      "privacy.peopleBoundary": "Ask before including relatives",
      "privacy.defaultRule": "Keep private unless I approve it",
      successDefinition: "I can see priorities, commitments, and next actions.",
      reviewPlan: "Review on October 1"
    }
  };

  async function completeIn(language) {
    let finalOutcome;
    await withSessionFixture(async ({ stateStore, adapters }) => {
      await completeBootstrap({
        language,
        stateStore,
        adapters,
        clock,
        answers: {
          displayName: "Jordan “Rio” Lee",
          focus: "Know the right next move every morning."
        }
      });

      let outcome = await startOnboardingSession({
        message: language === "es" ? "Empecemos la base." : "Let’s start the foundation.",
        stateStore,
        adapters,
        clock
      });
      for (const batch of ONBOARDING_BATCHES) {
        assert.equal(outcome.currentBatch.id, batch.id);
        outcome = await continueOnboardingSession({
          message: language === "es" ? "Estas son mis decisiones." : "Here are my decisions.",
          responses: answersByBatch[batch.id],
          stateStore,
          adapters,
          clock
        });
      }
      finalOutcome = outcome;
    });
    return finalOutcome;
  }

  const english = await completeIn("en");
  const spanish = await completeIn("es");
  const { language: englishLanguage, ...englishFoundation } = english.foundation;
  const { language: spanishLanguage, ...spanishFoundation } = spanish.foundation;

  assert.equal(englishLanguage, "en");
  assert.equal(spanishLanguage, "es");
  assert.deepEqual(spanishFoundation, englishFoundation);
  assert.match(spanish.vault.verifiedContents["Identity.md"], /Jordan “Rio” Lee/);
  assert.match(spanish.vault.verifiedContents["Priorities.md"], /Launch “Proyecto Río”/);
});

test("every completed batch can pause and resume through a new state-store object, and a completed onboarding never rewrites the vault", async () => {
  await withSessionFixture(async ({ statePath, stateStore, adapters, vault }) => {
    await completeBootstrap({ stateStore, adapters });

    let outcome = await startOnboardingSession({
      message: "I am ready to begin.",
      stateStore,
      adapters
    });

    for (const batch of ONBOARDING_BATCHES) {
      outcome = await continueOnboardingSession({
        message: "I accept the recommendations.",
        stateStore,
        adapters,
        stopAfterBatch: batch.id
      });

      assert.equal(outcome.onboarding.status, "paused");
      assert.equal(outcome.transcript.filter((entry) => entry.type === "batch_completed" && entry.batchId === batch.id).length, 1);

      const persisted = await getOnboardingSessionStatus({
        stateStore: new FileStateStore(statePath)
      });
      assert.equal(persisted.onboarding.status, "paused");

      outcome = await continueOnboardingSession({
        message: "Continue the foundation in this conversation.",
        stateStore: new FileStateStore(statePath),
        adapters
      });

      if (batch.id !== "privacy-success") {
        assert.equal(outcome.onboarding.status, "active");
        assert.equal(outcome.currentBatch.id, ONBOARDING_BATCHES[batch.index].id);
      }
    }

    assert.equal(outcome.onboarding.status, "complete");
    assert.equal(vault.writeCalls, 1);
    const completedTranscript = outcome.transcript;

    const rerun = await continueOnboardingSession({
      message: "Continue my foundation.",
      stateStore: new FileStateStore(statePath),
      adapters
    });
    assert.equal(rerun.onboarding.status, "complete");
    assert.equal(vault.writeCalls, 1);
    assert.deepEqual(rerun.transcript, completedTranscript);
  });
});

test("onboarding requires the completed public Setup Session rather than creating a separate path", async () => {
  await withSessionFixture(async ({ stateStore, adapters }) => {
    await assert.rejects(
      () => startOnboardingSession({
        message: "I am ready for onboarding.",
        stateStore,
        adapters
      }),
      /finish the saved second-brain setup first/i
    );

    await completeBootstrap({ stateStore, adapters });
    const resumedSetup = await continueSetupSession({
      message: "Continue setting up my second brain",
      stateStore,
      adapters
    });
    assert.equal(resumedSetup.setupSession.status, "complete");
  });
});
