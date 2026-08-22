-- CR-003 multilingual FOUNDATION (authorized 2026-07-26; contracts §7).
--
-- The localizable MACHINERY, preemptive in R1 while Agent 2's UI is unbuilt:
--   * `locales`      — reference set of the 20 supported languages (seeded in seed.sql;
--                      only `en` active in R1). Active-read public, staff-write (RLS).
--   * `translations` — a generic sidecar (entity_type, entity_id, field, locale, value),
--                      so localizing a field never migrates the entity and an unqueried
--                      language costs nothing. Read MIRRORS the parent entity's SELECT
--                      policy, staff-write (RLS). SEEDED EMPTY in R1.
--   * `users.locale` — preferred UI language (BCP-47), NOT accepted on PATCH /me in R1.
--
-- R1 seeds ZERO `translations` rows, so the locale-resolution read seam always falls back
-- to the base/English column and every response is byte-identical to today. Media
-- localization is explicitly OUT of scope.
--
-- After deploy: `npm run db:rls` MUST run — two new tables need their policies + the
-- ALL-TABLES-IN-SCHEMA grant, which is evaluated when it runs, not prospectively.
--
-- Rollback:
--   DROP TABLE "translations";
--   DROP TABLE "locales";
--   ALTER TABLE "users" DROP COLUMN "locale";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "locale" TEXT;

-- CreateTable
CREATE TABLE "locales" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "native_name" TEXT NOT NULL,
    "is_rtl" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "locales_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "translations" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "field" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "translations_entity_type_entity_id_locale_idx" ON "translations"("entity_type", "entity_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "translations_entity_type_entity_id_field_locale_key" ON "translations"("entity_type", "entity_id", "field", "locale");

-- AddForeignKey
ALTER TABLE "translations" ADD CONSTRAINT "translations_locale_fkey" FOREIGN KEY ("locale") REFERENCES "locales"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
