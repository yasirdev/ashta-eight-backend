// Engine self-check. No framework: `npx tsx src/recommendation/engine.test.ts`.
// The engine is pure, so this needs no DB, no server and no fixtures.
import assert from "node:assert/strict";
import { LADDER, rationaleFor, recommend, type Answer, type ProgrammeCode } from "./engine";
import { QUESTIONS, publicQuestionnaire } from "./questionnaire";

const ask = (...pairs: [string, string][]): Answer[] =>
  pairs.map(([questionId, value]) => ({ questionId, value }));

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n")[0]}`);
  }
}

// ── the ladder ───────────────────────────────────────────────────────────────
check("beginner wanting a routine → Foundations (the floor)", () => {
  const r = recommend({
    inputType: "questionnaire",
    input: { answers: ask(["q1", "lift_tone"], ["q2", "none"], ["q6", "practical"], ["q10", "starting"]) },
  });
  assert.equal(r.recommendedProgrammeCode, "ashta_foundations");
});

check("stress + belief work → Sculpt", () => {
  const r = recommend({
    inputType: "questionnaire",
    input: { answers: ask(["q4", "often"], ["q5", "very"], ["q6", "mindset"], ["q8", "alone"]) },
  });
  assert.equal(r.recommendedProgrammeCode, "ashta_sculpt");
});

check("identity work → Evolve", () => {
  const r = recommend({
    inputType: "questionnaire",
    input: { answers: ask(["q1", "deeper"], ["q6", "identity"], ["q7", "yes_deep"], ["q8", "alone"]) },
  });
  assert.equal(r.recommendedProgrammeCode, "ashta_evolve");
});

check("wants live/1:1 → Signature, regardless of pillar", () => {
  const r = recommend({
    inputType: "questionnaire",
    input: { answers: ask(["q1", "lift_tone"], ["q2", "none"], ["q8", "guided"], ["q9", "definitely"]) },
  });
  assert.equal(r.recommendedProgrammeCode, "ashta_signature");
});

// ── the guards ───────────────────────────────────────────────────────────────
check("a single stray answer cannot jump a tier (threshold holds)", () => {
  // evolve:1 from q7 'no' alone must NOT reach Evolve (threshold 3).
  const r = recommend({ inputType: "questionnaire", input: { answers: ask(["q7", "no"]) } });
  assert.equal(r.recommendedProgrammeCode, "ashta_foundations");
});

check("unknown question id / option is ignored, never throws", () => {
  const r = recommend({
    inputType: "questionnaire",
    input: { answers: ask(["q999", "bogus"], ["q1", "not_an_option"]) },
  });
  assert.equal(r.recommendedProgrammeCode, "ashta_foundations");
});

check("empty answers → the floor, not a crash", () => {
  const r = recommend({ inputType: "questionnaire", input: { answers: [] } });
  assert.equal(r.recommendedProgrammeCode, "ashta_foundations");
});

check("multi-select values are all scored", () => {
  const r = recommend({
    inputType: "questionnaire",
    input: { answers: [{ questionId: "q9", value: ["definitely"] }] },
  });
  assert.equal(r.recommendedProgrammeCode, "ashta_signature");
});

check("ar_face_scan seam exists but is not implemented", () => {
  assert.throws(() => recommend({ inputType: "ar_face_scan", input: {} }), /not implemented/);
});

// ── contract obligations ─────────────────────────────────────────────────────
check("every rationale is >= 2 sentences (contract §5)", () => {
  for (const answers of [
    ask(["q1", "lift_tone"]),
    ask(["q4", "often"], ["q5", "very"]),
    ask(["q6", "identity"], ["q7", "yes_deep"]),
    ask(["q9", "definitely"], ["q8", "guided"]),
  ]) {
    const r = recommend({ inputType: "questionnaire", input: { answers } });
    const sentences = r.rationale.split(/[.!?]+\s/).filter(Boolean).length;
    assert.ok(sentences >= 2, `${r.recommendedProgrammeCode}: ${sentences} sentence(s)`);
  }
});

check("questionnaire is 8–12 questions across the 3 categories (CLAUDE.md §6)", () => {
  assert.ok(QUESTIONS.length >= 8 && QUESTIONS.length <= 12, `${QUESTIONS.length} questions`);
  const cats = new Set(QUESTIONS.map((q) => q.category));
  assert.deepEqual([...cats].sort(), ["align", "evolve", "sculpt"]);
});

check("branching targets resolve to real questions/options", () => {
  const byId = new Map(QUESTIONS.map((q) => [q.id, q]));
  for (const q of QUESTIONS) {
    if (!q.branchOn) continue;
    const target = byId.get(q.branchOn.questionId);
    assert.ok(target, `${q.id} branches on missing ${q.branchOn.questionId}`);
    for (const v of q.branchOn.valueIn) {
      assert.ok(
        target!.options?.some((o) => o.value === v),
        `${q.id} branches on ${q.branchOn.questionId}=${v}, which is not an option`,
      );
    }
  }
});

// The ladder-walk bug class: the route degrades the programme when a rung is retired, so
// the rationale MUST be re-keyed to what is served. Serving Evolve's price under
// Signature's copy promises Live Cohort + 1:1 that the member is not buying — invisible,
// and it takes money. These pin the property the route depends on.
check("each rationale names its OWN programme, never a neighbour's", () => {
  const NAME: Record<ProgrammeCode, string> = {
    ashta_foundations: "Ashta Foundations",
    ashta_sculpt: "Ashta Sculpt",
    ashta_evolve: "Ashta Evolve",
    ashta_signature: "Ashta Signature",
  };
  for (const code of LADDER) {
    const r = rationaleFor(code);
    assert.ok(r.includes(NAME[code]), `${code}: rationale never names ${NAME[code]}`);
    for (const other of LADDER) {
      if (other === code) continue;
      assert.ok(!r.includes(NAME[other]), `${code}: rationale mentions ${NAME[other]}`);
    }
  }
});

check("only Signature's rationale promises Live Cohort / 1:1", () => {
  for (const code of LADDER) {
    const promises = /Live Cohort|1:1/.test(rationaleFor(code));
    assert.equal(promises, code === "ashta_signature", `${code}: wrong Live Cohort/1:1 promise`);
  }
});

check("rationaleFor is total over the ladder (a walk can land on any rung)", () => {
  for (const code of LADDER) {
    const r = rationaleFor(code);
    assert.ok(r && r.length > 40, `${code}: missing/short rationale`);
  }
  assert.equal(LADDER.length, 4);
});

check("public questionnaire never leaks the scoring weights", () => {
  const json = JSON.stringify(publicQuestionnaire());
  assert.ok(!json.includes("weights"), "weights exposed — a client could game its own result");
});

console.log(failed ? `\n${failed} FAILED` : "\nall pass");
process.exit(failed ? 1 : 0);
