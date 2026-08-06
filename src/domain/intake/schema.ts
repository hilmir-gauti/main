/**
 * Intake questionnaires — the branching questions a customer answers while
 * booking.
 *
 * A garage needs a registration number and a symptom description; a nail salon
 * needs a shape, a finish and a reference photo. Rather than hard-coding a form
 * per trade, a flow is declared as data: a list of questions, each of which may
 * depend on earlier answers.
 *
 * That single declaration drives four consumers:
 *   - the booking widget on the generated website (serialised to JSON)
 *   - server-side validation of the submitted answers
 *   - the phone receptionist, which asks the same questions aloud
 *   - the admin console and the confirmation email, which render the answers
 *
 * Conditions are kept deliberately tiny — equals, one-of, answered — because
 * the widget re-implements the evaluator in plain JavaScript, and a language
 * small enough to fit in twenty lines cannot drift.
 */

export type QuestionType =
  | 'texti'        // single-line free text
  | 'langur_texti' // textarea
  | 'val'          // pick one
  | 'fjolval'      // pick several
  | 'ja_nei'       // yes/no
  | 'bilnumer'     // Icelandic vehicle registration, validated and normalised
  | 'mynd'         // reference image URL/upload
  | 'simi'
  | 'dagsetning';

export interface IntakeOption {
  value: string;
  label: string;
  /** Shown under the label in the widget. */
  description?: string;
  /**
   * Picking this option suggests a catalogue service by name. Used to
   * pre-select the right service and estimate duration.
   */
  serviceHint?: string;
  /** Adds to the estimated appointment length, in minutes. */
  addsMinutes?: number;
}

/**
 * Condition grammar. `all`/`any` nest, everything else is a leaf.
 * Kept flat enough that the browser evaluator is a single recursive function.
 */
export type IntakeCondition =
  | { key: string; equals: string }
  | { key: string; oneOf: string[] }
  | { key: string; answered: true }
  | { all: IntakeCondition[] }
  | { any: IntakeCondition[] };

export interface IntakeQuestion {
  key: string;
  label: string;
  type: QuestionType;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: IntakeOption[];
  maxLength?: number;
  /** Question is only shown (and only validated) when this holds. */
  showIf?: IntakeCondition;
  /**
   * Offers AI-generated suggestions based on a free-text answer — used when a
   * customer cannot name what they want but can describe it.
   */
  aiSuggest?: {
    /** The free-text question whose answer is used as the prompt. */
    fromKey: string;
    /** What kind of thing to suggest, e.g. "naglaútlit". */
    subject: string;
  };
}

export interface IntakeFlow {
  /** Industry key this flow belongs to. */
  industry: string;
  title: string;
  intro: string;
  questions: IntakeQuestion[];
}

export type IntakeAnswers = Record<string, string | string[]>;

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

function answerValues(answers: IntakeAnswers, key: string): string[] {
  const value = answers[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((v) => v !== '');
  return value === '' ? [] : [value];
}

export function evaluateCondition(condition: IntakeCondition | undefined, answers: IntakeAnswers): boolean {
  if (!condition) return true;

  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, answers));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, answers));

  const values = answerValues(answers, condition.key);
  if ('answered' in condition) return values.length > 0;
  if ('equals' in condition) return values.includes(condition.equals);
  return values.some((value) => condition.oneOf.includes(value));
}

/** Questions currently visible, given the answers so far. */
export function visibleQuestions(flow: IntakeFlow, answers: IntakeAnswers): IntakeQuestion[] {
  return flow.questions.filter((question) => evaluateCondition(question.showIf, answers));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface IntakeValidation {
  valid: boolean;
  /** Field-keyed Icelandic error messages. */
  errors: Record<string, string>;
  /** Answers with hidden branches stripped and values normalised. */
  cleaned: IntakeAnswers;
}

/**
 * Icelandic registration plates: two letters + three digits ("AB123"), or the
 * older/personalised forms. Normalised to uppercase without spaces or dashes.
 */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-ZÁÐÉÍÓÚÝÞÆÖ0-9]/g, '').slice(0, 8);
}

export function isValidPlate(raw: string): boolean {
  const plate = normalizePlate(raw);
  // Standard format is 2 letters + 3 digits; personalised plates are 2–6
  // alphanumerics. Both are accepted, but empty or absurd values are not.
  return /^[A-ZÁÐÉÍÓÚÝÞÆÖ0-9]{2,8}$/.test(plate);
}

/**
 * Validates answers against a flow.
 *
 * Answers to questions that are not currently visible are discarded rather
 * than rejected: a customer who selects "Other", types an explanation, then
 * switches back to "Oil change" should not have the stale explanation stored
 * or block submission.
 */
export function validateIntake(flow: IntakeFlow | null, answers: IntakeAnswers): IntakeValidation {
  if (!flow) return { valid: true, errors: {}, cleaned: {} };

  const errors: Record<string, string> = {};
  const cleaned: IntakeAnswers = {};

  for (const question of flow.questions) {
    if (!evaluateCondition(question.showIf, answers)) continue;

    const values = answerValues(answers, question.key);

    if (values.length === 0) {
      if (question.required) errors[question.key] = 'Þessu þarf að svara.';
      continue;
    }

    switch (question.type) {
      case 'val':
      case 'ja_nei': {
        const allowed = new Set((question.options ?? yesNoOptions()).map((o) => o.value));
        const value = values[0]!;
        if (!allowed.has(value)) {
          errors[question.key] = 'Veldu einn af valkostunum.';
        } else {
          cleaned[question.key] = value;
        }
        break;
      }

      case 'fjolval': {
        const allowed = new Set((question.options ?? []).map((o) => o.value));
        const picked = values.filter((value) => allowed.has(value));
        if (picked.length === 0) {
          errors[question.key] = 'Veldu að minnsta kosti einn valkost.';
        } else {
          cleaned[question.key] = picked;
        }
        break;
      }

      case 'bilnumer': {
        const plate = normalizePlate(values[0]!);
        if (!isValidPlate(plate)) {
          errors[question.key] = 'Bílnúmerið lítur ekki rétt út. Dæmi: AB123.';
        } else {
          cleaned[question.key] = plate;
        }
        break;
      }

      case 'mynd': {
        const url = values[0]!.trim();
        // Accept a link or an uploaded reference id; reject anything that
        // could be interpreted as a script URL.
        if (!/^(https?:\/\/|mynd:)/i.test(url)) {
          errors[question.key] = 'Sláðu inn gilda vefslóð að mynd (https://…).';
        } else {
          cleaned[question.key] = url.slice(0, 500);
        }
        break;
      }

      case 'simi':
      case 'texti':
      case 'langur_texti':
      case 'dagsetning':
      default: {
        const max = question.maxLength ?? (question.type === 'langur_texti' ? 2000 : 200);
        const value = values[0]!.trim().slice(0, max);
        if (value === '' && question.required) {
          errors[question.key] = 'Þessu þarf að svara.';
        } else if (value !== '') {
          cleaned[question.key] = value;
        }
        break;
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors, cleaned };
}

export function yesNoOptions(): IntakeOption[] {
  return [
    { value: 'ja', label: 'Já' },
    { value: 'nei', label: 'Nei' },
  ];
}

// ---------------------------------------------------------------------------
// Rendering answers for humans
// ---------------------------------------------------------------------------

export interface RenderedAnswer {
  label: string;
  value: string;
}

/**
 * Turns stored answers into label/value pairs for the admin console, the
 * calendar event description and the confirmation email. Option values are
 * mapped back to their human labels.
 */
export function renderAnswers(flow: IntakeFlow | null, answers: IntakeAnswers): RenderedAnswer[] {
  if (!flow) return [];
  const out: RenderedAnswer[] = [];

  for (const question of flow.questions) {
    if (!evaluateCondition(question.showIf, answers)) continue;

    const values = answerValues(answers, question.key);
    if (values.length === 0) continue;

    const options = question.type === 'ja_nei' ? yesNoOptions() : question.options ?? [];
    const labelFor = (value: string) => options.find((o) => o.value === value)?.label ?? value;

    out.push({
      label: question.label,
      value: values.map(labelFor).join(', '),
    });
  }

  return out;
}

/** Estimated extra minutes implied by the answers, for duration adjustment. */
export function estimatedExtraMinutes(flow: IntakeFlow | null, answers: IntakeAnswers): number {
  if (!flow) return 0;
  let extra = 0;

  for (const question of flow.questions) {
    if (!evaluateCondition(question.showIf, answers)) continue;
    const values = answerValues(answers, question.key);
    for (const value of values) {
      const option = question.options?.find((o) => o.value === value);
      if (option?.addsMinutes) extra += option.addsMinutes;
    }
  }
  return extra;
}

/** The service name an answer points at, so the right service is preselected. */
export function suggestedServiceName(flow: IntakeFlow | null, answers: IntakeAnswers): string | null {
  if (!flow) return null;

  for (const question of flow.questions) {
    if (!evaluateCondition(question.showIf, answers)) continue;
    for (const value of answerValues(answers, question.key)) {
      const hint = question.options?.find((o) => o.value === value)?.serviceHint;
      if (hint) return hint;
    }
  }
  return null;
}
