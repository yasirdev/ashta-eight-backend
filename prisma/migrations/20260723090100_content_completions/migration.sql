-- DESIGN_GAPS G-4 / ARCH_SPEC_G4_G8 §1.8 — the append-only session-completion event table.
--
-- WHY A SECOND TABLE. `content_progress` is a STATE row, uniquely keyed (user_id,
-- content_id) and mutated in place, so re-completing an item MOVES its completed_at:
-- a re-watch today silently deletes a session from last Tuesday's bar, and 30 days of
-- the same daily audio counts as 1. An event stream cannot live in a state table.
--
-- duration_seconds is a SNAPSHOT taken at completion, and content_id is ON DELETE SET
-- NULL, precisely so the dashboard aggregate never has to join `content` — under RLS a
-- tier downgrade or an unpublish would shrink a member's own history, and an admin
-- correcting a video's length would rewrite what they practised last March.
--
-- Rollback: DROP TABLE "content_completions"; — nothing references it.
-- After deploy: `npm run db:rls` MUST run (new table ⇒ new policies + the
-- ALL-TABLES-IN-SCHEMA grant, which is evaluated when it runs, not prospectively).

-- CreateTable
CREATE TABLE "content_completions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "content_id" UUID,
    "duration_seconds" INTEGER,
    "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_completions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The ONLY index G-4 needs: every access pattern (all-time totals, the calendar-week
-- range, the streak walk) is a prefix of it. A bare (completed_at) or (content_id) index
-- is deliberately NOT added — no R1 query is cross-member, so either would be a write
-- cost on every completion for a query nobody runs.
CREATE INDEX "content_completions_user_id_completed_at_idx" ON "content_completions"("user_id", "completed_at" DESC);

-- AddForeignKey
ALTER TABLE "content_completions" ADD CONSTRAINT "content_completions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_completions" ADD CONSTRAINT "content_completions_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "content"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: one event per already-completed item (ARCH_SPEC_G4_G8 §1.2e).
-- STATED HONESTLY — this is a LOWER BOUND. Repeat practices before this migration are
-- unrecoverable; that information was never stored. Pre-launch it is a handful of rows,
-- and it is recorded here so nobody later mistakes the backfill for complete history.
INSERT INTO "content_completions" ("id", "user_id", "content_id", "duration_seconds", "completed_at")
SELECT gen_random_uuid(), cp.user_id, cp.content_id, c.duration_seconds, cp.completed_at
FROM "content_progress" cp
JOIN "content" c ON c.id = cp.content_id
WHERE cp.status = 'completed' AND cp.completed_at IS NOT NULL;
