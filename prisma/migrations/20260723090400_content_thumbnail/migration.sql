-- DESIGN_GAPS G-7 / ARCH_SPEC_G4_G8 §4 — content card artwork.
--
-- Holds an S3 object key under the `images/` prefix; serialized to members as an
-- absolute `thumbnailUrl` (CDN when MEDIA_CDN_BASE_URL is set, else a presigned GET in
-- dev), never the raw key. No index — it is never filtered on. No backfill — the client
-- has not supplied the photographs, so every row is legitimately NULL and the card keeps
-- its placeholder. That is a CONTENT gap, not a schema gap.
--
-- No RLS change: a column on `content` inherits `content_select` (published AND at/below
-- tier) by construction — a member cannot fetch the thumbnail of content they cannot see,
-- because they cannot see the row.
--
-- Rollback: ALTER TABLE "content" DROP COLUMN "thumbnail_object_key";

-- AlterTable
ALTER TABLE "content" ADD COLUMN     "thumbnail_object_key" TEXT;
