-- DESIGN_GAPS G-5 / ARCH_SPEC_G4_G8 §2 — presentational browse tiles for the Home screen.
--
-- NOT a fourth classification dimension. The four labels are heterogeneous across
-- dimensions that already exist ("Neural Audio" IS type='audio'), which is the signature
-- of a curated browse taxonomy, not of a missing column on `content`. Each row resolves
-- SERVER-SIDE to a set of content; the app only ever knows the slug.
--
-- Rollback: DROP TABLE "content_categories"; — nothing references it.
-- After deploy: `npm run db:rls` MUST run (new table ⇒ new policies + grant).

-- CreateTable
CREATE TABLE "content_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "icon_key" TEXT NOT NULL,
    "pillar" "Pillar",
    "type" "ContentType",
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "content_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "content_categories_slug_key" ON "content_categories"("slug");

-- CreateIndex
CREATE INDEX "content_categories_position_idx" ON "content_categories"("position");
