// Questionnaire definition (contracts §5). Served by GET /recommendation/questionnaire
// and consumed by the engine's questionnaire adapter.
//
// ⚠️ PROVISIONAL CONTENT — the question *wording* and the category weights below are a
// working v1.0.0 drafted from the seeded programme definitions (seed.sql). They are NOT
// client-signed-off copy. This file is deliberately pure data so the client's real
// questions can replace it with **no code change** — bump QUESTIONNAIRE_VERSION when they
// do. See PENDING_LOG D-B.
//
// There is no questionnaire table in the frozen contract, and inventing one would be a
// contract gap — so the definition lives here, versioned in code, which is exactly what
// `GET /recommendation/questionnaire → {version, questions}` implies.

export const QUESTIONNAIRE_VERSION = "1.0.0";

// The 3 categories are the brand's pillars and map 1:1 to the programme ladder
// (align → Foundations, sculpt → Sculpt, evolve → Evolve). `support` is not a pillar:
// it captures demand for Live Cohort / 1:1, which is what Signature adds.
export type Category = "align" | "sculpt" | "evolve";
export type Signal = Category | "support";

export type Option = {
  value: string;
  label: string;
  // Optional option artwork (G-9): an emoji glyph (e.g. "✨") OR a bundled app asset key
  // the client maps to a local icon — the client decides which by its shape. Purely
  // presentational; the engine ignores it. Absent on every provisional option today, so
  // `publicQuestionnaire` omits it and the response is unchanged until the client's real
  // questionnaire copy (D-B) supplies values. See contracts §7 (G-9, 2026-07-26).
  image?: string;
  // What choosing this option contributes. Absent = a neutral/'no' answer.
  weights?: Partial<Record<Signal, number>>;
};

export type Question = {
  id: string;
  category: Category;
  type: "single_choice" | "multi_choice" | "scale";
  prompt: string;
  options?: Option[];
  // Branching: only ask this if the named question holds one of these values.
  // Kept declarative so the client app renders branching without hard-coded logic.
  branchOn?: { questionId: string; valueIn: string[] };
};

export const QUESTIONS: Question[] = [
  {
    id: "q1",
    category: "align",
    type: "single_choice",
    prompt: "What would you most like to change right now?",
    options: [
      { value: "lift_tone", label: "Lift and tone my face naturally", weights: { align: 2 } },
      { value: "tension", label: "Release tension and puffiness", weights: { align: 2 } },
      { value: "confidence", label: "Feel more confident in my own skin", weights: { align: 1, sculpt: 1 } },
      { value: "deeper", label: "Something deeper than how I look", weights: { sculpt: 1, evolve: 2 } },
    ],
  },
  {
    id: "q2",
    category: "align",
    type: "single_choice",
    prompt: "How much face-yoga experience do you have?",
    options: [
      { value: "none", label: "None at all", weights: { align: 2 } },
      { value: "some", label: "I've tried a few things", weights: { align: 1 } },
      { value: "regular", label: "I practise regularly", weights: { sculpt: 1 } },
    ],
  },
  {
    id: "q3",
    category: "align",
    type: "single_choice",
    prompt: "Realistically, how long can you practise most days?",
    options: [
      { value: "lt5", label: "Under 5 minutes", weights: { align: 1 } },
      { value: "5_15", label: "5–15 minutes", weights: { align: 1, sculpt: 1 } },
      { value: "gt15", label: "More than 15 minutes", weights: { sculpt: 1, evolve: 1 } },
    ],
  },
  {
    id: "q4",
    category: "sculpt",
    type: "single_choice",
    prompt: "Do stress or long-held habits get in the way of looking after yourself?",
    options: [
      { value: "often", label: "Often", weights: { sculpt: 3 } },
      { value: "sometimes", label: "Sometimes", weights: { sculpt: 1 } },
      { value: "rarely", label: "Rarely" },
    ],
  },
  {
    id: "q5",
    category: "sculpt",
    type: "single_choice",
    // Only worth asking if q4 said stress/habits are a factor.
    branchOn: { questionId: "q4", valueIn: ["often", "sometimes"] },
    prompt: "How drawn are you to working on the beliefs underneath those habits?",
    options: [
      { value: "very", label: "Very — that's the real work", weights: { sculpt: 3 } },
      { value: "curious", label: "Curious, but new to it", weights: { sculpt: 2 } },
      { value: "not", label: "Not for me right now" },
    ],
  },
  {
    id: "q6",
    category: "evolve",
    type: "single_choice",
    prompt: "Which sounds more like what you're after?",
    options: [
      { value: "practical", label: "A practical routine that works", weights: { align: 2 } },
      { value: "mindset", label: "Changing how I think about myself", weights: { sculpt: 2 } },
      { value: "identity", label: "Becoming a different version of myself", weights: { evolve: 3 } },
    ],
  },
  {
    id: "q7",
    category: "evolve",
    type: "single_choice",
    branchOn: { questionId: "q6", valueIn: ["identity", "mindset"] },
    prompt: "Have you done identity or visualisation work before?",
    options: [
      { value: "yes_deep", label: "Yes, and I want to go further", weights: { evolve: 3 } },
      { value: "yes_little", label: "A little", weights: { evolve: 2 } },
      { value: "no", label: "No, but I'm open to it", weights: { evolve: 1 } },
    ],
  },
  {
    id: "q8",
    category: "evolve",
    type: "single_choice",
    prompt: "How do you prefer to practise?",
    options: [
      { value: "alone", label: "On my own, in my own time" },
      { value: "group", label: "With a group, live", weights: { support: 2 } },
      { value: "guided", label: "Guided one-to-one", weights: { support: 3 } },
    ],
  },
  {
    id: "q9",
    category: "evolve",
    type: "single_choice",
    prompt: "Would live sessions with a coach make you more likely to keep going?",
    options: [
      { value: "definitely", label: "Definitely", weights: { support: 3 } },
      { value: "maybe", label: "Maybe", weights: { support: 1 } },
      { value: "no", label: "I'd rather go at my own pace" },
    ],
  },
  {
    id: "q10",
    category: "align",
    type: "single_choice",
    prompt: "Where are you in your journey?",
    options: [
      { value: "starting", label: "Just starting out", weights: { align: 2 } },
      { value: "building", label: "Building a habit", weights: { sculpt: 1 } },
      { value: "committed", label: "Ready to commit fully", weights: { evolve: 1, support: 1 } },
    ],
  },
];

// Wire shape for GET /recommendation/questionnaire. Weights are engine internals and are
// deliberately NOT exposed — a client that can see them can game its own recommendation.
export function publicQuestionnaire() {
  return {
    version: QUESTIONNAIRE_VERSION,
    questions: QUESTIONS.map((q) => ({
      id: q.id,
      category: q.category,
      type: q.type,
      prompt: q.prompt,
      options: q.options?.map((o) => ({ value: o.value, label: o.label, image: o.image })),
      branchOn: q.branchOn,
    })),
  };
}
