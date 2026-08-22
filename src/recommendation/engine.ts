// The recommendation engine (contracts §5): a PURE function `recommend(input) → output`,
// decoupled from transport and storage. No Prisma, no Express, no I/O — so it is testable
// on its own and the AR input can slot in later without touching routes or schema.
//
// ⚠️ PROVISIONAL RULES — the thresholds below are a working v1.0.0 derived from the seeded
// programme ladder, not client-signed-off business rules. See PENDING_LOG D-B.

import { QUESTIONS, QUESTIONNAIRE_VERSION, type Signal } from "./questionnaire";

export const ENGINE_VERSION = "1.0.0";

// The programme ladder is cumulative (contract D2: a tier unlocks its own + all lower),
// and the seeded programmes map 1:1 onto the pillars (seed.sql):
//   align  → ashta_foundations  (face-yoga foundations)
//   sculpt → ashta_sculpt       (+ subconscious reprogramming)
//   evolve → ashta_evolve       (+ quantum-identity, full library)
//   support→ ashta_signature    (+ Live Cohort and 1:1 coaching)
// So the recommendation is the HIGHEST rung the answers actually reach for — recommending
// below that under-serves, above it oversells.
export type ProgrammeCode =
  | "ashta_foundations"
  | "ashta_sculpt"
  | "ashta_evolve"
  | "ashta_signature";

// The ladder, lowest rung first. Exported so a caller can walk DOWN it when the
// recommended rung isn't purchasable (deactivated) — see routes.ts. Order mirrors
// programmes.tier_rank; it is the engine's, because the engine owns the mapping.
export const LADDER: ProgrammeCode[] = [
  "ashta_foundations",
  "ashta_sculpt",
  "ashta_evolve",
  "ashta_signature",
];

export type Answer = { questionId: string; value: string | string[] };

export type RecommendationInput =
  | { inputType: "questionnaire"; input: { answers: Answer[] } }
  // AR seam (contract §5): a future ar_face_scan carries a feature vector in the same
  // `input` jsonb. Declared here so the union — and every caller's exhaustiveness check —
  // already accounts for it. Not implemented; R1 is out of scope for AR.
  | { inputType: "ar_face_scan"; input: Record<string, unknown> };

export type Scores = Record<Signal, number>;

export type RecommendationOutput = {
  recommendedProgrammeCode: ProgrammeCode;
  rationale: string;
  engineVersion: string;
  // Returned for testing/inspection only — NOT persisted (no contract field exists, and
  // adding a column would be a contract gap) and never put on the wire (leaking scores
  // ≈ leaking weights, which lets a client game its own recommendation).
  scores: Scores;
};

// A signal must clear its bar AND lead, so a single stray answer can't jump a tier.
const THRESHOLD: Record<Exclude<Signal, "align">, number> = {
  support: 3,
  evolve: 3,
  sculpt: 3,
};

// The rationale explains THE MATCH (contract §5), so it is keyed off the programme the
// member is actually served — never off a pick that was later degraded. Exported so the
// route can re-key it after walking down the ladder: serving Evolve's price under
// Signature's copy ("Live Cohort sessions and 1:1 coaching") promises what the product
// won't honour, and takes money on it.
export const rationaleFor = (code: ProgrammeCode): string => RATIONALE[code];

const RATIONALE: Record<ProgrammeCode, string> = {
  ashta_foundations:
    "Your answers point to building a solid face-yoga practice first — a routine you can actually keep, without adding more than you need. Ashta Foundations gives you the Align pillar on its own, so you can establish the habit before layering anything else on top.",
  ashta_sculpt:
    "You told us that stress and long-held habits get in the way, which is exactly what the Sculpt pillar addresses — the technique works better when what's underneath is working with you. Ashta Sculpt pairs the face-yoga foundations with subconscious reprogramming, and it auto-renews so the practice stays continuous.",
  ashta_evolve:
    "Your answers reach past routine and mindset towards identity — becoming a different version of yourself, not just doing a different practice. Ashta Evolve adds the quantum-identity work to everything below it, giving you the full self-practice library.",
  ashta_signature:
    "You said live guidance is what keeps you going, and that changes which tier actually fits. Ashta Signature includes everything in the library plus the Live Cohort sessions and 1:1 coaching, so you are practising with support rather than alone.",
};

function scoreQuestionnaire(answers: Answer[]): Scores {
  const scores: Scores = { align: 0, sculpt: 0, evolve: 0, support: 0 };
  const byId = new Map(QUESTIONS.map((q) => [q.id, q]));

  for (const a of answers) {
    const q = byId.get(a.questionId);
    if (!q?.options) continue; // unknown/stale question id → ignore, never throw
    // Accept a single value or a multi-select array uniformly.
    const values = Array.isArray(a.value) ? a.value : [a.value];
    for (const v of values) {
      const weights = q.options.find((o) => o.value === v)?.weights;
      if (!weights) continue; // unknown option, or a deliberately neutral answer
      for (const [signal, w] of Object.entries(weights)) {
        scores[signal as Signal] += w;
      }
    }
  }
  return scores;
}

function pick(scores: Scores): ProgrammeCode {
  // Highest rung first: support (Signature) → evolve → sculpt → foundations.
  // Support is checked first because wanting live/1:1 is a tier decision on its own —
  // it is what Signature sells, regardless of which pillar they scored on.
  if (scores.support >= THRESHOLD.support) return "ashta_signature";
  if (scores.evolve >= THRESHOLD.evolve && scores.evolve >= scores.sculpt) return "ashta_evolve";
  if (scores.sculpt >= THRESHOLD.sculpt) return "ashta_sculpt";
  return "ashta_foundations"; // the floor: everyone gets the Align foundations
}

export function recommend(req: RecommendationInput): RecommendationOutput {
  if (req.inputType === "ar_face_scan") {
    // The seam exists in the type union and the persisted envelope; the adapter is R2+.
    throw new Error("ar_face_scan input is not implemented (R1 is questionnaire-only)");
  }
  const scores = scoreQuestionnaire(req.input.answers);
  const code = pick(scores);
  return {
    recommendedProgrammeCode: code,
    rationale: RATIONALE[code], // every rationale is >= 2 sentences (contract §5)
    engineVersion: `${ENGINE_VERSION}+q${QUESTIONNAIRE_VERSION}`,
    scores,
  };
}
