import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Prisma, Programme, RecommendationRequest } from "@prisma/client";
import { asUser, prismaApp, prismaService } from "../db";
import { AppError, asyncHandler, parseBody } from "../http";
import { requireAuth } from "../auth/middleware";
import { BASE_LOCALIZER, makeLocalizer, type Localizer } from "../i18n";
import { publicQuestionnaire } from "./questionnaire";
import { LADDER, rationaleFor, recommend, type ProgrammeCode } from "./engine";

// Recommendation / questionnaire (contracts §3 + §5).
//
// The intake is completable with NO account (CLAUDE.md §6), so capture writes via the
// service role — the contract's listed "anonymous questionnaire capture" flow
// (§2). recommendation_requests has a SELECT policy for the owner only and no INSERT/
// UPDATE policy for the app role, so an anonymous write has no RLS path by design.
// Member reads go through asUser → the owner policy.

// `loc` = the CR-003 locale seam (default base pass-through; byte-identical in R1).
const serializeProgramme = (p: Programme, loc: Localizer = BASE_LOCALIZER) => ({
  id: p.id,
  code: p.code,
  name: loc.text("programme", p.id, "name", p.name),
  description: loc.text("programme", p.id, "description", p.description),
  tierRank: p.tierRank,
  priceMinor: p.priceMinor,
  currency: p.currency,
  billingInterval: p.billingInterval,
});

// Resolve the engine's pick to a programme the member can ACTUALLY buy.
// Read via prismaApp (RLS `programmes_select` = is_active OR is_staff, so an
// unauthenticated read sees active rows only) with the filter also explicit — the
// pattern payments/routes.ts:41,77 already established. The BYPASSRLS client must not
// be used here: it would ignore is_active and recommend a retired tier at a live price
// whose checkout 404s (contract D1 re-prices by deactivating, so this is a designed-for
// state, not a hypothetical).
// If the recommended rung is retired, walk DOWN the ladder to the highest active rung:
// the tiers are cumulative (contract D2), so the next one down is a strict subset of
// what was recommended — never more than the answers asked for. Recommending nothing
// would dead-end the app's entry screen.
// Returns the ladder `code` alongside the row so the caller can re-key the rationale to
// what is actually served — the code is a ProgrammeCode by construction (it only ever
// comes from LADDER), which a bare `programme.code` string would not guarantee.
async function resolvePurchasable(
  code: ProgrammeCode,
): Promise<{ programme: Programme; code: ProgrammeCode } | null> {
  const active = await prismaApp.programme.findMany({
    where: { isActive: true },
    orderBy: { tierRank: "asc" },
  });
  const byCode = new Map(active.map((p) => [p.code, p]));
  for (let i = LADDER.indexOf(code); i >= 0; i--) {
    const hit = byCode.get(LADDER[i]);
    if (hit) return { programme: hit, code: LADDER[i] };
  }
  return null; // every programme retired — degrade to a rationale with no programme
}

export const recommendationRouter = Router();

// GET /recommendation/questionnaire — public. The question set the app renders.
recommendationRouter.get(
  "/questionnaire",
  asyncHandler(async (_req, res) => {
    res.json(publicQuestionnaire());
  }),
);

// POST /recommendation — public. GDPR consent FIRST: no consent, nothing is processed or
// stored (CLAUDE.md §6 "GDPR consent first"), so the literal `true` is the gate, not a flag
// we record after the fact.
recommendationRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        // UUID, not "any string ≥8 chars". This key is a bearer capability: whoever
        // presents it later claims the intake (personal data). A client-chosen key like
        // "device12" can collide across people, and `claim` takes EVERY match — so one
        // stranger's claim would sweep up both. A v4 UUID makes that implausible, and it
        // is what the server mints anyway (contract §5's own example is "anon-uuid").
        sessionKey: z.string().uuid().optional(),
        inputType: z.literal("questionnaire").default("questionnaire"),
        input: z.object({
          answers: z
            .array(
              z.object({
                questionId: z.string().min(1).max(50),
                // Accepted and stored but NOT trusted: the engine derives category from
                // QUESTIONS. Kept so the persisted `input` jsonb is a faithful audit
                // record of what the member actually submitted (contract §5's example
                // carries it); zod would otherwise strip it silently.
                category: z.enum(["align", "sculpt", "evolve"]).optional(),
                value: z.union([z.string().max(200), z.array(z.string().max(200)).max(20)]),
              }),
            )
            .min(1)
            .max(50),
        }),
        // Consent-first: z.literal(true) rejects false/absent with a 400 before any work.
        gdprConsent: z.literal(true),
      }),
      req.body,
    );

    const result = recommend({ inputType: "questionnaire", input: body.input });

    // The engine returns a code; the row stores the id. A retired/renamed programme must
    // not 500 the intake — it degrades to the highest purchasable rung, or to null.
    const hit = await resolvePurchasable(result.recommendedProgrammeCode);
    const programme = hit?.programme ?? null;

    // Re-key the rationale to the programme actually SERVED. If the ladder walked down,
    // the engine's rationale still describes the rung we could not sell — serving Evolve's
    // price under Signature's "Live Cohort sessions and 1:1 coaching" copy would promise
    // what the member is not buying. Persisted together with the id below, so the row
    // stays internally coherent and /me/recommendation can never re-serve the mismatch.
    const rationale = hit ? rationaleFor(hit.code) : result.rationale;

    // A caller may pass its own key to tie several intakes to one anonymous session;
    // otherwise mint one so the intake is claimable at register (auth/routes.ts already
    // claims by sessionKey). NOT a dedupe key: each submission is its own row (`create`,
    // not `upsert` — an upsert would need a @unique, which is a contract gap).
    const sessionKey = body.sessionKey ?? randomUUID();

    const row = await prismaService.recommendationRequest.create({
      data: {
        userId: null, // anonymous by construction; /claim or register attaches it
        sessionKey,
        inputType: "questionnaire",
        input: body.input as unknown as Prisma.InputJsonValue,
        gdprConsentAt: new Date(), // consent is proven by reaching here (literal true)
        recommendedProgrammeId: programme?.id ?? null,
        rationale, // the SERVED programme's rationale (see above), not the engine's pick
        engineVersion: result.engineVersion,
      },
    });

    const loc = await makeLocalizer(req);
    if (programme) await loc.preload(prismaApp, "programme", [programme.id]);
    res.status(201).json({
      recommendationId: row.id,
      sessionKey,
      programme: programme ? serializeProgramme(programme, loc) : null,
      rationale,
    });
  }),
);

// POST /recommendation/claim — member. Attach an anonymous intake to the caller.
recommendationRouter.post(
  "/claim",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = req.auth!;
    const body = parseBody(
      z
        .object({
          recommendationId: z.string().uuid().optional(),
          sessionKey: z.string().uuid().optional(), // see POST / — a bearer capability
        })
        // One identifier is required; with neither, updateMany would match every
        // unclaimed row in the table and hand the caller all of them.
        .refine((v) => !!(v.recommendationId || v.sessionKey), {
          message: "recommendationId or sessionKey is required",
        }),
      req.body,
    );

    // `userId: null` is the security guard, not an optimisation: it means a claim can only
    // ever take an UNCLAIMED row, so knowing another member's id/key can never re-point
    // their intake. Same guard the register path uses (auth/routes.ts). Service role is
    // required — the app role has no UPDATE policy on this table.
    const where: Prisma.RecommendationRequestWhereInput = {
      userId: null,
      ...(body.recommendationId ? { id: body.recommendationId } : {}),
      ...(body.sessionKey ? { sessionKey: body.sessionKey } : {}),
    };
    const { count } = await prismaService.recommendationRequest.updateMany({
      where,
      data: { userId },
    });

    // Nothing matched = wrong key, or already claimed. Do NOT distinguish those cases:
    // the difference tells an attacker whether a given key exists.
    if (count === 0) throw new AppError(404, "not_found", "No unclaimed recommendation found");
    res.json({ ok: true });
  }),
);

// GET /me/recommendation — member. Latest recommendation, or null. Mounted under /me.
export const meRecommendationRouter = Router();
meRecommendationRouter.get(
  "/recommendation",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    // Read through RLS (owner policy) rather than the service role — this is a plain
    // owner read, so it should not touch the BYPASSRLS surface.
    const row = await asUser(userId, role, (tx) =>
      tx.recommendationRequest.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
    );
    if (!row) return res.json(null);

    // Same rule as capture: never re-serve a retired tier as purchasable. This read is
    // historical, so it does NOT walk the ladder — showing a *different* programme than
    // the one we recommended would be a silent rewrite of history. A retired programme
    // degrades to null; the rationale still stands and the client can re-run the intake.
    const programme = row.recommendedProgrammeId
      ? await prismaApp.programme.findFirst({
          where: { id: row.recommendedProgrammeId, isActive: true },
        })
      : null;

    const loc = await makeLocalizer(req);
    if (programme) await loc.preload(prismaApp, "programme", [programme.id]);
    res.json({
      recommendationId: row.id,
      programme: programme ? serializeProgramme(programme, loc) : null,
      rationale: (row as RecommendationRequest).rationale,
    });
  }),
);
