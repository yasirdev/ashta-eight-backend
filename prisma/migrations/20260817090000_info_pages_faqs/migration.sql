-- CR-008 — Info pages (privacy/terms/about) + Help-Center FAQs. Admin-authored HTML,
-- served to the app. Public-ish, same posture as `programmes`/`content_categories`:
-- published rows readable by any app-role session; staff manage.
--
-- Rollback: DROP TABLE "faqs"; DROP TABLE "info_pages"; — nothing references them.
-- After deploy: `npm run db:rls` MUST run (new tables ⇒ new policies + grant).

-- CreateTable
CREATE TABLE "info_pages" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_html" TEXT NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "updated_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "info_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faqs" (
    "id" UUID NOT NULL,
    "question" TEXT NOT NULL,
    "answer_html" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_published" BOOLEAN NOT NULL DEFAULT true,
    "updated_by_admin_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "info_pages_slug_key" ON "info_pages"("slug");

-- CreateIndex
CREATE INDEX "faqs_position_idx" ON "faqs"("position");
