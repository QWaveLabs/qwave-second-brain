/**
 * QWA-141 recommendation-led bilingual foundation onboarding state machine.
 *
 * This is intentionally layered on top of the persisted QWA-138 Setup Session.
 * It does not discover sources, connect applications, install Obsidian, or
 * publish anything. It captures the customer's explicit foundation decisions
 * and writes only the corresponding local vault notes through an injected
 * adapter.
 */

const TOTAL_BATCHES = 4;
const DEFAULT_DISPLAY_NAME = "there";
const DEFAULT_FOCUS = "a calmer daily command center";

class OnboardingVisibleError extends Error {
  constructor(code, customerMessage) {
    super(customerMessage);
    this.name = "OnboardingVisibleError";
    this.code = code;
    this.customerMessage = customerMessage;
  }
}

const BATCH_DEFINITIONS = Object.freeze([
  {
    id: "identity",
    title: { en: "Identity", es: "Identidad" },
    introduction: {
      en: "First, let’s make sure this brain sounds like you and knows the roles it needs to support.",
      es: "Primero, hagamos que este segundo cerebro refleje quién eres y los roles que debe apoyar."
    },
    questions: [
      {
        id: "identity.name",
        label: { en: "Preferred name", es: "Nombre preferido" },
        prompt: {
          en: "What name should appear in your notes?",
          es: "¿Qué nombre debe aparecer en tus notas?"
        },
        confirmation: {
          en: "I have {value} as the name for your notes. Is that still right?",
          es: "Tengo {value} como el nombre para tus notas. ¿Sigue siendo correcto?"
        },
        defaultValue: "not-set-yet"
      },
      {
        id: "roles",
        label: { en: "Roles", es: "Roles" },
        prompt: {
          en: "Which roles should this brain support first?",
          es: "¿Qué roles debe apoyar primero este segundo cerebro?"
        },
        confirmation: {
          en: "I already have these roles: {value}. Are they still right?",
          es: "Ya tengo estos roles: {value}. ¿Siguen siendo correctos?"
        },
        defaultValue: ["personal", "professional"]
      },
      {
        id: "identity.organizations",
        label: { en: "Organizations", es: "Organizaciones" },
        prompt: {
          en: "Which organizations, if any, should be part of your foundation?",
          es: "¿Qué organizaciones, si corresponde, deben formar parte de tu base?"
        },
        confirmation: {
          en: "I already have these organizations: {value}. Keep them?",
          es: "Ya tengo estas organizaciones: {value}. ¿Las mantenemos?"
        },
        defaultValue: []
      },
      {
        id: "identity.primaryLanguage",
        label: { en: "Primary vault language", es: "Idioma principal de la bóveda" },
        prompt: {
          en: "Which language should your vault use most often?",
          es: "¿Qué idioma debe usar tu bóveda con mayor frecuencia?"
        },
        confirmation: {
          en: "I have {value} as your primary vault language. Is that right?",
          es: "Tengo {value} como tu idioma principal de la bóveda. ¿Es correcto?"
        },
        defaultValue: (language) => language
      },
      {
        id: "identity.workingStyle",
        label: { en: "Working style", es: "Estilo de trabajo" },
        prompt: {
          en: "How should this brain keep its guidance useful for you?",
          es: "¿Cómo debe mantener útil su guía este segundo cerebro?"
        },
        confirmation: {
          en: "I have {value} as your preferred working style. Keep it?",
          es: "Tengo {value} como tu estilo de trabajo preferido. ¿Lo mantenemos?"
        },
        defaultValue: "clear-direct"
      }
    ]
  },
  {
    id: "outcomes",
    title: { en: "Outcome and next 90 days", es: "Resultado y próximos 90 días" },
    introduction: {
      en: "Now we’ll set the outcome this brain should protect and the priorities it should keep visible.",
      es: "Ahora definiremos el resultado que este segundo cerebro debe proteger y las prioridades que debe mantener visibles."
    },
    questions: [
      {
        id: "desiredOutcome",
        label: { en: "Desired outcome", es: "Resultado deseado" },
        prompt: {
          en: "What would make this second brain genuinely useful to you?",
          es: "¿Qué haría que este segundo cerebro fuera realmente útil para ti?"
        },
        confirmation: {
          en: "I have {value} as the outcome you want. Is that still right?",
          es: "Tengo {value} como el resultado que deseas. ¿Sigue siendo correcto?"
        },
        defaultValue: "calmer-command-center"
      },
      {
        id: "next90DayPriorities",
        label: { en: "Next-90-day priorities", es: "Prioridades de los próximos 90 días" },
        prompt: {
          en: "What should stay at the top of your attention over the next 90 days?",
          es: "¿Qué debe mantenerse en la parte superior de tu atención durante los próximos 90 días?"
        },
        confirmation: {
          en: "I have these next-90-day priorities: {value}. Are they still right?",
          es: "Tengo estas prioridades para los próximos 90 días: {value}. ¿Siguen siendo correctas?"
        },
        defaultValue: ["clarify-priorities", "track-active-commitments", "build-weekly-review"]
      },
      {
        id: "currentProjects",
        label: { en: "Current projects", es: "Proyectos actuales" },
        prompt: {
          en: "Which current projects should this foundation recognize right away?",
          es: "¿Qué proyectos actuales debe reconocer esta base de inmediato?"
        },
        confirmation: {
          en: "I already have these current projects: {value}. Keep them?",
          es: "Ya tengo estos proyectos actuales: {value}. ¿Los mantenemos?"
        },
        defaultValue: []
      },
      {
        id: "reviewCadence",
        label: { en: "Review rhythm", es: "Ritmo de revisión" },
        prompt: {
          en: "How often should you review your priorities together?",
          es: "¿Con qué frecuencia debes revisar tus prioridades?"
        },
        confirmation: {
          en: "I have {value} as your review rhythm. Keep it?",
          es: "Tengo {value} como tu ritmo de revisión. ¿Lo mantenemos?"
        },
        defaultValue: "weekly"
      },
      {
        id: "first90DayMilestone",
        label: { en: "90-day milestone", es: "Hito de 90 días" },
        prompt: {
          en: "What should be true in 90 days if this is working well?",
          es: "¿Qué debería ser cierto en 90 días si esto está funcionando bien?"
        },
        confirmation: {
          en: "I have {value} as your 90-day milestone. Is that still right?",
          es: "Tengo {value} como tu hito de 90 días. ¿Sigue siendo correcto?"
        },
        defaultValue: "trusted-daily-command-center"
      }
    ]
  },
  {
    id: "scope",
    title: { en: "Scope", es: "Alcance" },
    introduction: {
      en: "Next, we’ll define what belongs in one command center before any source is connected.",
      es: "A continuación, definiremos qué pertenece a un solo centro de mando antes de conectar cualquier fuente."
    },
    questions: [
      {
        id: "includedAreas",
        label: { en: "Included areas", es: "Áreas incluidas" },
        prompt: {
          en: "Which areas of your life should this brain organize together?",
          es: "¿Qué áreas de tu vida debe organizar juntas este segundo cerebro?"
        },
        confirmation: {
          en: "I have these included areas: {value}. Are they still right?",
          es: "Tengo estas áreas incluidas: {value}. ¿Siguen siendo correctas?"
        },
        defaultValue: ["personal", "business"]
      },
      {
        id: "scope.businessAreas",
        label: { en: "Business areas", es: "Áreas de negocio" },
        prompt: {
          en: "Which business areas should be named now, if any?",
          es: "¿Qué áreas de negocio deben nombrarse ahora, si corresponde?"
        },
        confirmation: {
          en: "I already have these business areas: {value}. Keep them?",
          es: "Ya tengo estas áreas de negocio: {value}. ¿Las mantenemos?"
        },
        defaultValue: []
      },
      {
        id: "scope.personalAreas",
        label: { en: "Personal areas", es: "Áreas personales" },
        prompt: {
          en: "Which personal areas should be named now, if any?",
          es: "¿Qué áreas personales deben nombrarse ahora, si corresponde?"
        },
        confirmation: {
          en: "I already have these personal areas: {value}. Keep them?",
          es: "Ya tengo estas áreas personales: {value}. ¿Las mantenemos?"
        },
        defaultValue: []
      },
      {
        id: "scope.inclusionRule",
        label: { en: "Inclusion rule", es: "Regla de inclusión" },
        prompt: {
          en: "What is the simplest rule for deciding what belongs in this brain?",
          es: "¿Cuál es la regla más simple para decidir qué pertenece a este segundo cerebro?"
        },
        confirmation: {
          en: "I have {value} as your inclusion rule. Keep it?",
          es: "Tengo {value} como tu regla de inclusión. ¿La mantenemos?"
        },
        defaultValue: "approved-context-only"
      },
      {
        id: "scope.outOfScopeAreas",
        label: { en: "Out-of-scope areas", es: "Áreas fuera de alcance" },
        prompt: {
          en: "What should stay outside this foundation for now?",
          es: "¿Qué debe permanecer fuera de esta base por ahora?"
        },
        confirmation: {
          en: "I already have these out-of-scope areas: {value}. Keep them?",
          es: "Ya tengo estas áreas fuera de alcance: {value}. ¿Las mantenemos?"
        },
        defaultValue: []
      }
    ]
  },
  {
    id: "privacy-success",
    title: { en: "Privacy and success", es: "Privacidad y éxito" },
    introduction: {
      en: "Last, we’ll make the private boundaries explicit and agree on what success should look like.",
      es: "Por último, haremos explícitos los límites privados y acordaremos cómo debe verse el éxito."
    },
    questions: [
      {
        id: "privateAreas",
        label: { en: "Private areas", es: "Áreas privadas" },
        prompt: {
          en: "Which areas should remain private unless you explicitly approve them later?",
          es: "¿Qué áreas deben mantenerse privadas a menos que las apruebes explícitamente más adelante?"
        },
        confirmation: {
          en: "I have these private areas: {value}. Are they still right?",
          es: "Tengo estas áreas privadas: {value}. ¿Siguen siendo correctas?"
        },
        defaultValue: ["private-conversations", "financial-details", "health-details"]
      },
      {
        id: "privacy.peopleBoundary",
        label: { en: "People boundary", es: "Límite para personas" },
        prompt: {
          en: "How should sensitive people or conversations be handled by default?",
          es: "¿Cómo deben manejarse por defecto las personas o conversaciones sensibles?"
        },
        confirmation: {
          en: "I have {value} as your people boundary. Keep it?",
          es: "Tengo {value} como tu límite para personas. ¿Lo mantenemos?"
        },
        defaultValue: "review-sensitive-people-first"
      },
      {
        id: "privacy.defaultRule",
        label: { en: "Privacy default", es: "Regla predeterminada de privacidad" },
        prompt: {
          en: "What privacy rule should apply whenever something is unclear?",
          es: "¿Qué regla de privacidad debe aplicarse cuando algo no esté claro?"
        },
        confirmation: {
          en: "I have {value} as your privacy default. Keep it?",
          es: "Tengo {value} como tu regla predeterminada de privacidad. ¿La mantenemos?"
        },
        defaultValue: "private-by-default"
      },
      {
        id: "successDefinition",
        label: { en: "Success definition", es: "Definición de éxito" },
        prompt: {
          en: "What should this brain help you do reliably for it to feel successful?",
          es: "¿Qué debe ayudarte a hacer este segundo cerebro de forma confiable para que se sienta exitoso?"
        },
        confirmation: {
          en: "I have {value} as your definition of success. Is that still right?",
          es: "Tengo {value} como tu definición de éxito. ¿Sigue siendo correcta?"
        },
        defaultValue: "see-priorities-and-next-actions"
      },
      {
        id: "reviewPlan",
        label: { en: "First review", es: "Primera revisión" },
        prompt: {
          en: "When should we revisit these choices after you have used the foundation?",
          es: "¿Cuándo debemos revisar estas decisiones después de que hayas usado la base?"
        },
        confirmation: {
          en: "I have {value} as your first review plan. Keep it?",
          es: "Tengo {value} como tu plan para la primera revisión. ¿Lo mantenemos?"
        },
        defaultValue: "review-in-30-days"
      }
    ]
  }
]);

export const ONBOARDING_BATCHES = Object.freeze(
  BATCH_DEFINITIONS.map((batch, index) => Object.freeze({
    id: batch.id,
    index: index + 1,
    questionCount: batch.questions.length
  }))
);

const VALUE_LABELS = Object.freeze({
  "not-set-yet": { en: "Not set yet", es: "Aún por definir" },
  personal: { en: "Personal life", es: "Vida personal" },
  professional: { en: "Professional work", es: "Trabajo profesional" },
  business: { en: "Business", es: "Negocio" },
  "clear-direct": { en: "Clear and direct guidance", es: "Guía clara y directa" },
  "calmer-command-center": { en: "A calmer daily command center", es: "Un centro de mando diario más tranquilo" },
  "clarify-priorities": { en: "Clarify priorities", es: "Aclarar prioridades" },
  "track-active-commitments": { en: "Track active commitments", es: "Dar seguimiento a compromisos activos" },
  "build-weekly-review": { en: "Build a weekly review", es: "Crear una revisión semanal" },
  weekly: { en: "Weekly", es: "Semanal" },
  "trusted-daily-command-center": { en: "A trusted daily command center", es: "Un centro de mando diario confiable" },
  "approved-context-only": { en: "Only approved context that supports my priorities", es: "Solo contexto aprobado que apoye mis prioridades" },
  "private-conversations": { en: "Private conversations", es: "Conversaciones privadas" },
  "financial-details": { en: "Financial details", es: "Detalles financieros" },
  "health-details": { en: "Health details", es: "Detalles de salud" },
  "review-sensitive-people-first": { en: "Review sensitive people before including them", es: "Revisar a las personas sensibles antes de incluirlas" },
  "private-by-default": { en: "Keep it private until I explicitly approve it", es: "Mantenerlo privado hasta que lo apruebe explícitamente" },
  "see-priorities-and-next-actions": { en: "See priorities and next actions without hunting for them", es: "Ver prioridades y próximos pasos sin tener que buscarlos" },
  "review-in-30-days": { en: "Review these choices in 30 days", es: "Revisar estas decisiones en 30 días" },
  en: { en: "English", es: "Inglés" },
  es: { en: "Spanish", es: "Español" },
  bilingual: { en: "Bilingual", es: "Bilingüe" }
});

const FIELD_ALIASES = Object.freeze({
  displayName: "identity.name",
  preferredName: "identity.name",
  name: "identity.name",
  focus: "desiredOutcome",
  priorities: "next90DayPriorities",
  next90Priorities: "next90DayPriorities",
  organizations: "identity.organizations",
  primaryLanguage: "identity.primaryLanguage",
  workingStyle: "identity.workingStyle",
  businessAreas: "scope.businessAreas",
  personalAreas: "scope.personalAreas",
  inclusionRule: "scope.inclusionRule",
  outOfScopeAreas: "scope.outOfScopeAreas",
  peopleBoundary: "privacy.peopleBoundary",
  privacyRule: "privacy.defaultRule"
});

function deepClone(value) {
  return structuredClone(value);
}

function languageFor(state) {
  return state.safeDecisions?.language === "es" ? "es" : "en";
}

function now(clock) {
  const value = clock?.now ? clock.now() : new Date();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function translate(language, english, spanish) {
  return language === "es" ? spanish : english;
}

function interpolate(template, replacements) {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => String(replacements[key] ?? ""));
}

function displayAtom(value, language, localize) {
  if (localize && typeof value === "string" && VALUE_LABELS[value]) {
    return VALUE_LABELS[value][language];
  }
  return String(value);
}

function displayValue(value, language, { localize = false } = {}) {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return translate(language, "Nothing to add yet", "Nada que agregar todavía");
    }
    return value.map((item) => displayAtom(item, language, localize)).join(", ");
  }
  if (value === null || value === undefined || value === "") {
    return translate(language, "Not set yet", "Aún por definir");
  }
  return displayAtom(value, language, localize);
}

function assertNaturalLanguage(message) {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new OnboardingVisibleError(
      "ONBOARDING_MESSAGE_REQUIRED",
      "Tell me in ordinary language that you are ready for the next onboarding questions."
    );
  }
  if (message.trim().startsWith("/")) {
    throw new OnboardingVisibleError(
      "NO_SLASH_COMMANDS",
      "You do not need a command. Reply in ordinary language, and I will keep the onboarding moving."
    );
  }
}

function assertDependencies({ stateStore, adapters }) {
  if (!stateStore || typeof stateStore.load !== "function" || typeof stateStore.save !== "function") {
    throw new TypeError("A persistent stateStore with load() and save() is required.");
  }
  if (!adapters?.vault || typeof adapters.vault.inspect !== "function" || typeof adapters.vault.writeFiles !== "function") {
    throw new TypeError("A vault adapter with inspect() and writeFiles() is required for onboarding.");
  }
}

function allQuestionIds() {
  return new Set(BATCH_DEFINITIONS.flatMap((batch) => batch.questions.map((question) => question.id)));
}

function fieldFor(value) {
  return FIELD_ALIASES[value] ?? value;
}

function toKnownFact(value, source) {
  if (value && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "value")) {
    return {
      value: deepClone(value.value),
      source: value.source ?? source
    };
  }
  return {
    value: deepClone(value),
    source
  };
}

function collectKnownFacts(state, supplied = {}) {
  const known = {};
  const add = (field, value, source) => {
    if (value === undefined || value === null) return;
    known[field] = toKnownFact(value, source);
  };

  if (state.answers?.displayName && state.answers.displayName !== DEFAULT_DISPLAY_NAME) {
    add("identity.name", state.answers.displayName, "saved setup");
  }
  if (state.answers?.focus && state.answers.focus !== DEFAULT_FOCUS) {
    add("desiredOutcome", state.answers.focus, "saved setup");
  }
  if (state.safeDecisions?.language) {
    add("identity.primaryLanguage", state.safeDecisions.language, "saved setup");
  }

  for (const [inputField, value] of Object.entries(supplied ?? {})) {
    const field = fieldFor(inputField);
    if (allQuestionIds().has(field)) {
      add(field, value, "previously discovered");
    }
  }

  return known;
}

function recommendedValue(question, language) {
  return typeof question.defaultValue === "function"
    ? question.defaultValue(language)
    : deepClone(question.defaultValue);
}

function buildQuestion(question, language, knownFact, answerRecord) {
  const knownValue = knownFact?.value;
  const hasKnownValue = knownFact !== undefined;
  const value = hasKnownValue ? deepClone(knownValue) : recommendedValue(question, language);
  const localize = !hasKnownValue;
  const mode = hasKnownValue ? "confirm" : "answer";
  const prompt = hasKnownValue
    ? interpolate(question.confirmation[language], { value: displayValue(knownValue, language, { localize: true }) })
    : question.prompt[language];

  return {
    id: question.id,
    label: question.label[language],
    mode,
    prompt,
    knownFact: hasKnownValue
      ? {
          value: deepClone(knownValue),
          source: knownFact.source
        }
      : null,
    recommendation: {
      value,
      display: displayValue(value, language, { localize }),
      rationale: hasKnownValue
        ? translate(language, "This confirms information already captured for your setup.", "Esto confirma información ya capturada para tu configuración.")
        : translate(language, "This is a starting recommendation that you can replace in ordinary language.", "Esta es una recomendación inicial que puedes reemplazar en lenguaje normal.")
    },
    answer: answerRecord
      ? {
          value: deepClone(answerRecord.value),
          source: answerRecord.source,
          confirmedKnownFact: Boolean(answerRecord.confirmedKnownFact)
        }
      : null
  };
}

function batchAt(index) {
  return BATCH_DEFINITIONS[index - 1] ?? null;
}

function currentBatch(state) {
  return batchAt(state.onboarding?.currentBatch);
}

function buildBatchView(state, batch) {
  if (!batch) return null;
  const onboarding = state.onboarding;
  const language = onboarding.language;
  const index = BATCH_DEFINITIONS.indexOf(batch) + 1;
  const questions = batch.questions.map((question) => buildQuestion(
    question,
    language,
    onboarding.knownFacts[question.id],
    onboarding.answers[question.id]
  ));

  return {
    id: batch.id,
    index,
    totalBatches: TOTAL_BATCHES,
    title: batch.title[language],
    introduction: batch.introduction[language],
    progress: translate(
      language,
      "Batch " + index + " of " + TOTAL_BATCHES + " · " + onboarding.completedBatches.length + " complete",
      "Lote " + index + " de " + TOTAL_BATCHES + " · " + onboarding.completedBatches.length + " completados"
    ),
    questions,
    recommendations: questions.map((question) => ({
      id: question.id,
      label: question.label,
      value: deepClone(question.recommendation.value),
      display: question.recommendation.display,
      rationale: question.recommendation.rationale
    }))
  };
}

function buildInitialOnboardingState(state, knownFacts, clock) {
  const language = languageFor(state);
  const timestamp = now(clock);
  return {
    version: 1,
    status: "active",
    language,
    currentBatch: 1,
    completedBatches: [],
    knownFacts: collectKnownFacts(state, knownFacts),
    answers: {},
    decisions: {},
    decisionLog: [],
    transcript: [
      {
        type: "onboarding_started",
        at: timestamp,
        message: translate(
          language,
          "We will complete four short batches. Each recommendation stays visible before you accept it.",
          "Completaremos cuatro lotes cortos. Cada recomendación permanecerá visible antes de que la aceptes."
        )
      }
    ],
    foundation: null,
    vault: null,
    blocker: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function acceptsRecommendations(message, explicitChoice) {
  if (explicitChoice === true) return true;
  if (explicitChoice === false || typeof message !== "string") return false;
  return /\baccept(?:ed|ing)?\b[\s\S]*\brecommendations?\b/i.test(message)
    || /\bacept(?:o|a|amos|ar)?\b[\s\S]*\brecomendaciones?\b/i.test(message);
}

function normalizeResponses(responses, answers) {
  const provided = responses ?? answers ?? {};
  if (provided === null || provided === undefined) return {};
  if (typeof provided !== "object" || Array.isArray(provided)) {
    throw new OnboardingVisibleError(
      "ONBOARDING_RESPONSES_INVALID",
      "I could not match that response to this short batch. Please answer in ordinary language and I will keep the choices visible."
    );
  }
  return provided;
}

function recordAnswer(state, batch, question, value, source, clock) {
  const onboarding = state.onboarding;
  const timestamp = now(clock);
  const knownFact = onboarding.knownFacts[question.id];
  const decision = {
    id: question.id,
    batchId: batch.id,
    value: deepClone(value),
    source,
    confirmedKnownFact: Boolean(knownFact),
    knownFactSource: knownFact?.source ?? null,
    acceptedAt: timestamp
  };
  onboarding.answers[question.id] = decision;
  onboarding.decisions[question.id] = deepClone(decision);
  onboarding.decisionLog.push(deepClone(decision));
  onboarding.updatedAt = timestamp;
  return decision;
}

function allQuestionsAnswered(onboarding, batch) {
  return batch.questions.every((question) => Object.hasOwn(onboarding.answers, question.id));
}

function decisionFor(state, questionId) {
  return state.onboarding.answers[questionId];
}

function foundationFromAnswers(state) {
  const value = (id) => deepClone(decisionFor(state, id).value);
  const decision = (id) => {
    const record = decisionFor(state, id);
    return {
      source: record.source,
      confirmedKnownFact: record.confirmedKnownFact,
      acceptedAt: record.acceptedAt
    };
  };

  return {
    schemaVersion: 1,
    language: state.onboarding.language,
    identity: {
      name: value("identity.name"),
      organizations: value("identity.organizations"),
      primaryLanguage: value("identity.primaryLanguage"),
      workingStyle: value("identity.workingStyle")
    },
    roles: value("roles"),
    desiredOutcome: value("desiredOutcome"),
    next90DayPriorities: value("next90DayPriorities"),
    currentProjects: value("currentProjects"),
    reviewCadence: value("reviewCadence"),
    first90DayMilestone: value("first90DayMilestone"),
    includedAreas: value("includedAreas"),
    privateAreas: value("privateAreas"),
    successDefinition: value("successDefinition"),
    scope: {
      businessAreas: value("scope.businessAreas"),
      personalAreas: value("scope.personalAreas"),
      inclusionRule: value("scope.inclusionRule"),
      outOfScopeAreas: value("scope.outOfScopeAreas")
    },
    privacyBoundaries: {
      peopleBoundary: value("privacy.peopleBoundary"),
      defaultRule: value("privacy.defaultRule")
    },
    reviewPlan: value("reviewPlan"),
    decisions: Object.fromEntries(
      Object.keys(state.onboarding.answers).map((id) => [id, decision(id)])
    )
  };
}

function renderAnswer(record, language) {
  const localize = record.source === "accepted_recommendation" && !record.confirmedKnownFact;
  if (Array.isArray(record.value)) {
    if (record.value.length === 0) {
      return "- " + translate(language, "Nothing to add yet", "Nada que agregar todavía");
    }
    return record.value.map((value) => "- " + displayAtom(value, language, localize)).join("\n");
  }
  return displayValue(record.value, language, { localize });
}

function renderField(state, id) {
  return renderAnswer(decisionFor(state, id), state.onboarding.language);
}

function vaultHeadings(language) {
  if (language === "es") {
    return {
      home: "Inicio",
      identity: "Identidad",
      priorities: "Prioridades",
      scope: "Alcance",
      privacy: "Límites de privacidad",
      name: "Nombre",
      roles: "Roles",
      organizations: "Organizaciones",
      language: "Idioma principal",
      workingStyle: "Estilo de trabajo",
      desiredOutcome: "Resultado deseado",
      next90: "Prioridades de los próximos 90 días",
      projects: "Proyectos actuales",
      cadence: "Ritmo de revisión",
      milestone: "Hito de 90 días",
      included: "Áreas incluidas",
      business: "Áreas de negocio",
      personal: "Áreas personales",
      inclusion: "Regla de inclusión",
      excluded: "Áreas fuera de alcance",
      privateAreas: "Áreas privadas",
      people: "Límite para personas",
      privacyDefault: "Regla predeterminada",
      success: "Definición de éxito",
      review: "Primera revisión",
      nextStep: "Próximo paso",
      homeIntro: "Esta es una base de onboarding local. No hay fuentes conectadas todavía."
    };
  }
  return {
    home: "Home",
    identity: "Identity",
    priorities: "Priorities",
    scope: "Scope",
    privacy: "Privacy boundaries",
    name: "Name",
    roles: "Roles",
    organizations: "Organizations",
    language: "Primary language",
    workingStyle: "Working style",
    desiredOutcome: "Desired outcome",
    next90: "Next-90-day priorities",
    projects: "Current projects",
    cadence: "Review rhythm",
    milestone: "90-day milestone",
    included: "Included areas",
    business: "Business areas",
    personal: "Personal areas",
    inclusion: "Inclusion rule",
    excluded: "Out-of-scope areas",
    privateAreas: "Private areas",
    people: "People boundary",
    privacyDefault: "Privacy default",
    success: "Success definition",
    review: "First review",
    nextStep: "Next step",
    homeIntro: "This is a local onboarding foundation. No sources are connected yet."
  };
}

function buildVaultFiles(state) {
  const language = state.onboarding.language;
  const heading = vaultHeadings(language);
  const section = (label, value) => "## " + label + "\n\n" + value + "\n\n";

  const identity = "# " + heading.identity + "\n\n"
    + section(heading.name, renderField(state, "identity.name"))
    + section(heading.roles, renderField(state, "roles"))
    + section(heading.organizations, renderField(state, "identity.organizations"))
    + section(heading.language, renderField(state, "identity.primaryLanguage"))
    + section(heading.workingStyle, renderField(state, "identity.workingStyle"));

  const priorities = "# " + heading.priorities + "\n\n"
    + section(heading.desiredOutcome, renderField(state, "desiredOutcome"))
    + section(heading.next90, renderField(state, "next90DayPriorities"))
    + section(heading.projects, renderField(state, "currentProjects"))
    + section(heading.cadence, renderField(state, "reviewCadence"))
    + section(heading.milestone, renderField(state, "first90DayMilestone"))
    + section(heading.success, renderField(state, "successDefinition"))
    + section(heading.review, renderField(state, "reviewPlan"));

  const scope = "# " + heading.scope + "\n\n"
    + section(heading.included, renderField(state, "includedAreas"))
    + section(heading.business, renderField(state, "scope.businessAreas"))
    + section(heading.personal, renderField(state, "scope.personalAreas"))
    + section(heading.inclusion, renderField(state, "scope.inclusionRule"))
    + section(heading.excluded, renderField(state, "scope.outOfScopeAreas"));

  const privacy = "# " + heading.privacy + "\n\n"
    + section(heading.privateAreas, renderField(state, "privateAreas"))
    + section(heading.people, renderField(state, "privacy.peopleBoundary"))
    + section(heading.privacyDefault, renderField(state, "privacy.defaultRule"));

  const home = "# " + heading.home + "\n\n"
    + heading.homeIntro + "\n\n"
    + section(heading.desiredOutcome, renderField(state, "desiredOutcome"))
    + section(heading.next90, renderField(state, "next90DayPriorities"))
    + section(heading.nextStep, translate(
      language,
      "Return to this same conversation whenever you want to continue.",
      "Vuelve a esta misma conversación cuando quieras continuar."
    ));

  return {
    "Home.md": home,
    "Identity.md": identity,
    "Priorities.md": priorities,
    "Scope.md": scope,
    "System/Privacy.md": privacy
  };
}

async function writeFoundationToVault(state, adapters, clock) {
  const files = buildVaultFiles(state);
  const expectedFiles = Object.keys(files).sort();
  const path = state.vault?.desktopPath;
  if (!path) {
    throw new OnboardingVisibleError(
      "BASE_VAULT_MISSING",
      "I could not find the setup vault, so I stopped before writing your foundation."
    );
  }

  await adapters.vault.writeFiles({ path, files });
  const inspection = await adapters.vault.inspect({ path, includeContents: true });
  const missing = expectedFiles.filter((file) => !inspection?.files?.includes(file));
  if (!inspection?.exists || missing.length > 0) {
    throw new OnboardingVisibleError(
      "FOUNDATION_VAULT_VALIDATION_FAILED",
      "I could not verify every foundation note in your vault, so this step is safely paused."
    );
  }

  const readBack = inspection.contents && typeof inspection.contents === "object"
    ? Object.fromEntries(expectedFiles.map((file) => [file, inspection.contents[file]]))
    : null;
  if (readBack && expectedFiles.some((file) => readBack[file] !== files[file])) {
    throw new OnboardingVisibleError(
      "FOUNDATION_VAULT_READBACK_FAILED",
      "I could not read back the same foundation content I wrote, so this step is safely paused."
    );
  }

  state.onboarding.foundation = foundationFromAnswers(state);
  state.onboarding.vault = {
    path,
    files: expectedFiles,
    verifiedAt: now(clock),
    simulated: Boolean(inspection.simulated),
    readBack: Boolean(readBack),
    verifiedContents: readBack ? deepClone(readBack) : null
  };
  state.validation.foundation = {
    ...(state.validation.foundation ?? {}),
    capturedAt: now(clock),
    intakeBatches: TOTAL_BATCHES,
    foundationFiles: expectedFiles,
    vaultVerified: true
  };
}

async function completeCurrentBatch(state, batch, { adapters, clock, stopAfterBatch }) {
  const onboarding = state.onboarding;
  const completedDecisions = batch.questions.map((question) => deepClone(onboarding.decisions[question.id]));
  onboarding.completedBatches.push(batch.id);
  onboarding.transcript.push({
    type: "batch_completed",
    batchId: batch.id,
    completedBatches: onboarding.completedBatches.length,
    totalBatches: TOTAL_BATCHES,
    decisions: completedDecisions,
    at: now(clock)
  });
  onboarding.currentBatch += 1;

  if (onboarding.currentBatch > TOTAL_BATCHES) {
    const shouldPause = stopAfterBatch === batch.id || stopAfterBatch === BATCH_DEFINITIONS.indexOf(batch) + 1;
    if (shouldPause) {
      onboarding.status = "paused";
      onboarding.updatedAt = now(clock);
      return;
    }
    await finalizeOnboarding(state, { adapters, clock });
    return;
  }

  const shouldPause = stopAfterBatch === batch.id || stopAfterBatch === BATCH_DEFINITIONS.indexOf(batch) + 1;
  onboarding.status = shouldPause ? "paused" : "active";
  onboarding.updatedAt = now(clock);
}

async function finalizeOnboarding(state, { adapters, clock }) {
  const onboarding = state.onboarding;
  if (onboarding.foundation && onboarding.vault) {
    onboarding.status = "complete";
    return;
  }

  await writeFoundationToVault(state, adapters, clock);
  onboarding.status = "complete";
  onboarding.transcript.push({
    type: "onboarding_completed",
    completedBatches: TOTAL_BATCHES,
    totalBatches: TOTAL_BATCHES,
    foundationFiles: [...onboarding.vault.files],
    at: now(clock),
    message: translate(
      onboarding.language,
      "Your identity, scope, privacy boundaries, and priorities are now in the local vault.",
      "Tu identidad, alcance, límites de privacidad y prioridades ya están en la bóveda local."
    )
  });
}

async function applyBatchInput(state, { message, responses, answers, acceptRecommendations, adapters, clock, stopAfterBatch }) {
  const onboarding = state.onboarding;
  const batch = currentBatch(state);
  if (!batch) {
    if (onboarding.completedBatches.length === TOTAL_BATCHES) {
      await finalizeOnboarding(state, { adapters, clock });
    }
    return;
  }

  const provided = normalizeResponses(responses, answers);
  const allowed = new Set(batch.questions.map((question) => question.id));
  for (const [id, value] of Object.entries(provided)) {
    if (!allowed.has(id)) {
      throw new OnboardingVisibleError(
        "ONBOARDING_RESPONSE_OUT_OF_BATCH",
        "I only need the choices from this short batch before we move on."
      );
    }
    recordAnswer(state, batch, batch.questions.find((question) => question.id === id), value, "customer_response", clock);
  }

  if (acceptsRecommendations(message, acceptRecommendations)) {
    for (const question of batch.questions) {
      if (Object.hasOwn(onboarding.answers, question.id)) continue;
      const knownFact = onboarding.knownFacts[question.id];
      const value = knownFact ? deepClone(knownFact.value) : recommendedValue(question, onboarding.language);
      recordAnswer(state, batch, question, value, "accepted_recommendation", clock);
    }
  }

  if (!allQuestionsAnswered(onboarding, batch)) {
    onboarding.status = "active";
    onboarding.updatedAt = now(clock);
    return;
  }

  await completeCurrentBatch(state, batch, { adapters, clock, stopAfterBatch });
}

function onboardingProgress(onboarding) {
  return {
    completedBatches: onboarding.completedBatches.length,
    totalBatches: TOTAL_BATCHES,
    label: translate(
      onboarding.language,
      onboarding.completedBatches.length + " of " + TOTAL_BATCHES + " onboarding batches complete",
      onboarding.completedBatches.length + " de " + TOTAL_BATCHES + " lotes de onboarding completados"
    )
  };
}

function onboardingMessage(onboarding) {
  if (onboarding.status === "blocked") return onboarding.blocker.message;
  if (onboarding.status === "complete") {
    return translate(
      onboarding.language,
      "Your foundation is saved in the local vault.",
      "Tu base está guardada en la bóveda local."
    );
  }
  const batch = batchAt(onboarding.currentBatch);
  return batch?.introduction[onboarding.language]
    ?? translate(onboarding.language, "Your progress is saved.", "Tu progreso está guardado.");
}

function toPublicView(state) {
  const onboarding = state.onboarding;
  const batch = currentBatch(state);
  const status = onboarding.status;
  const nextAction = status === "complete"
    ? translate(
      onboarding.language,
      "Ask a normal question in this same conversation whenever you want to continue.",
      "Haz una pregunta normal en esta misma conversación cuando quieras continuar."
    )
    : status === "blocked"
      ? translate(
        onboarding.language,
        "Your completed decisions are saved. Resolve the one issue above, then tell me to continue in ordinary language.",
        "Tus decisiones completadas están guardadas. Resuelve el único problema anterior y luego dime en lenguaje normal que continuemos."
      )
      : translate(
        onboarding.language,
        "Reply in ordinary language with your choices, or say that you accept the visible recommendations.",
        "Responde en lenguaje normal con tus decisiones, o di que aceptas las recomendaciones visibles."
      );

  return {
    onboarding: {
      installationId: state.installationId,
      status,
      language: onboarding.language,
      progress: onboardingProgress(onboarding),
      message: onboardingMessage(onboarding),
      nextAction
    },
    currentBatch: status === "complete" ? null : buildBatchView(state, batch),
    foundation: onboarding.foundation ? deepClone(onboarding.foundation) : null,
    vault: onboarding.vault ? deepClone(onboarding.vault) : null,
    transcript: deepClone(onboarding.transcript),
    limitation: onboarding.vault?.simulated
      ? "This QWA-141 proof uses a simulated local vault adapter. It does not claim a real Obsidian installation, source connection, or external publication."
      : "This slice only captures the local onboarding foundation. It does not connect sources or publish customer data."
  };
}

async function execute(input, { allowCreate }) {
  const { message, stateStore, adapters, knownFacts, clock } = input ?? {};
  assertNaturalLanguage(message);
  assertDependencies({ stateStore, adapters });

  const state = await stateStore.load();
  if (!state?.vault?.desktopPath || state.status !== "complete") {
    throw new OnboardingVisibleError(
      "SETUP_SESSION_REQUIRED",
      "Finish the saved second-brain setup first, then continue here for the four short onboarding batches."
    );
  }

  if (!state.onboarding) {
    if (!allowCreate) {
      throw new OnboardingVisibleError(
        "ONBOARDING_NOT_FOUND",
        "I could not find a saved onboarding yet. Tell me you are ready to begin the foundation questions."
      );
    }
    state.onboarding = buildInitialOnboardingState(state, knownFacts, clock);
    await stateStore.save(state);
  }

  if (state.onboarding.status === "complete") {
    return toPublicView(state);
  }

  state.onboarding.status = "active";
  state.onboarding.blocker = null;
  try {
    await applyBatchInput(state, {
      message,
      responses: input.responses,
      answers: input.answers,
      acceptRecommendations: input.acceptRecommendations,
      adapters,
      clock,
      stopAfterBatch: input.stopAfterBatch
    });
  } catch (error) {
    const customerError = error instanceof OnboardingVisibleError
      ? error
      : new OnboardingVisibleError(
        "ONBOARDING_SAFE_RETRY_REQUIRED",
        "That onboarding step did not finish. Your completed choices are saved, and you can safely continue here."
      );
    state.onboarding.status = "blocked";
    state.onboarding.blocker = {
      code: customerError.code,
      message: customerError.customerMessage,
      recordedAt: now(clock)
    };
  }
  state.onboarding.updatedAt = now(clock);
  await stateStore.save(state);
  return toPublicView(state);
}

/**
 * Begin the four short onboarding batches after QWA-138 has created the
 * resumable Setup Session and local vault.
 */
export async function startOnboardingSession(input) {
  return execute(input, { allowCreate: true });
}

/**
 * Resume a persisted onboarding in the same ordinary-language conversation.
 */
export async function continueOnboardingSession(input) {
  return execute(input, { allowCreate: false });
}

/**
 * Read the persisted onboarding state without making another vault write.
 */
export async function getOnboardingSessionStatus({ stateStore }) {
  if (!stateStore || typeof stateStore.load !== "function") {
    throw new TypeError("A persistent stateStore with load() is required.");
  }
  const state = await stateStore.load();
  return state?.onboarding ? toPublicView(state) : null;
}
