-- DESIGN_GAPS G-12 — Personal Data screen fields (contracts §7, 2026-07-26).
--
-- Adds `date_of_birth` (date) + `gender` (free text), both accepted on PATCH /me.
-- DOB is GDPR personal data and is handled like the other PII on `users`.
-- `gender` is deliberately free text, not an enum: the client has not fixed a value set,
-- and an invented enum would be closer to inventing schema than an open column.
--
-- No RLS change — columns on `users` inherit `users_select`/`users_update`. Both are
-- legitimately member-writable, so neither is added to the §trigger guard.
--
-- Rollback:
--   ALTER TABLE "users" DROP COLUMN "gender";
--   ALTER TABLE "users" DROP COLUMN "date_of_birth";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "gender" TEXT;
