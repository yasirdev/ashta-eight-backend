-- DESIGN_GAPS G-1 / ARCH_SPEC_G1 §4b — ordered marketing feature rows on a programme.
-- Existing rows need NO backfill: NOT NULL DEFAULT fills all four in place (PG 11+ adds
-- a defaulted column without a table rewrite). Rollback is the DROP COLUMN below —
-- nothing else references it.

-- AlterTable
ALTER TABLE "programmes"
  ADD COLUMN "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Shape floor (the API's Zod schema is the ceiling — see ARCH_SPEC_G1 §5c).
-- Subquery-free by necessity: PostgreSQL CHECK constraints cannot contain subqueries,
-- so per-element LENGTH is validated at the API layer, not here. Hand-written: Prisma
-- models neither the NOT NULL on an array nor CHECK constraints, same as RLS — so do
-- NOT re-run `prisma migrate dev` over this file; the CHECK is the expected drift.
ALTER TABLE "programmes"
  ADD CONSTRAINT "programmes_features_valid" CHECK (
        COALESCE(array_ndims("features"), 1) = 1                 -- one-dimensional
    AND COALESCE(array_length("features", 1), 0) <= 8            -- design shows 4; headroom to 8
    AND array_position("features", NULL::text) IS NULL           -- no NULL elements
    AND NOT ("features" && ARRAY['']::TEXT[])                    -- no empty-string rows
  );
