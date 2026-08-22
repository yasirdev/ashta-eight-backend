import { Router } from "express";
import { z } from "zod";
import type { Faq, InfoPage } from "@prisma/client";
import { asUser, prismaApp } from "../db";
import { AppError, asyncHandler, parseBody } from "../http";
import { requireAdmin, requireAuth } from "../auth/middleware";
import { sanitizePageHtml } from "./sanitize";

// CR-008 — Info pages (privacy/terms/about) + Help-Center FAQs, admin-authored HTML.
//
// Same "public-ish" posture as `programmes`/`content_categories`: PUBLIC reads run as
// ashta_app with NO session GUC, so RLS (`is_published OR is_staff()`) shows only published
// rows to anyone — including a signed-out app showing Terms during the signup consent step.
// Admin CRUD runs through asUser (staff) and the RLS write policy is the real gate.
//
// The app is given the rendered HTML and nothing else. Bodies are sanitized ON WRITE
// (./sanitize), never on read, so the store never holds a script and reads stay cheap.

const serializePage = (p: InfoPage) => ({
  slug: p.slug,
  title: p.title,
  bodyHtml: p.bodyHtml,
  updatedAt: p.updatedAt,
});

const serializePageAdmin = (p: InfoPage) => ({
  ...serializePage(p),
  isPublished: p.isPublished,
});

const serializeFaq = (f: Faq) => ({
  id: f.id,
  question: f.question,
  answerHtml: f.answerHtml,
  position: f.position,
});

const serializeFaqAdmin = (f: Faq) => ({ ...serializeFaq(f), isPublished: f.isPublished });

// ── Public reads (no auth) ────────────────────────────────────────────────────
export const pagesRouter = Router();

// GET /pages/:slug — one info page. 404 when missing OR unpublished (RLS hides it,
// so a member cannot tell a draft from a nonexistent page).
pagesRouter.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const slug = String(req.params.slug);
    const page = await prismaApp.infoPage.findFirst({ where: { slug } });
    if (!page) throw new AppError(404, "not_found", "Page not found");
    res.json({ page: serializePage(page) });
  }),
);

export const faqsRouter = Router();

// GET /faqs — published FAQ entries, ordered. Flat list (categories are an additive
// R2 upgrade with no contract change).
faqsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const items = await prismaApp.faq.findMany({
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    res.json({ items: items.map(serializeFaq) });
  }),
);

// ── Admin CRUD (staff only) ───────────────────────────────────────────────────
export const adminPagesRouter = Router();

// GET /admin/pages — all pages incl. drafts.
adminPagesRouter.get(
  "/pages",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const items = await asUser(userId, role, (tx) => tx.infoPage.findMany({ orderBy: { slug: "asc" } }));
    res.json({ items: items.map(serializePageAdmin) });
  }),
);

// GET /admin/pages/:slug — one page for editing.
adminPagesRouter.get(
  "/pages/:slug",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const slug = String(req.params.slug);
    const page = await asUser(userId, role, (tx) => tx.infoPage.findFirst({ where: { slug } }));
    if (!page) throw new AppError(404, "not_found", "Page not found");
    res.json({ page: serializePageAdmin(page) });
  }),
);

// PUT /admin/pages/:slug — upsert (the three slugs are seeded, but upsert keeps this
// resilient if the seed hasn't run and lets us add a future page without a code change).
// Body HTML is sanitized before storage.
adminPagesRouter.put(
  "/pages/:slug",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const slug = String(req.params.slug);
    const body = parseBody(
      z.object({
        title: z.string().min(1).max(200),
        bodyHtml: z.string().max(100_000),
        isPublished: z.boolean(),
      }),
      req.body,
    );
    const clean = sanitizePageHtml(body.bodyHtml);
    const saved = await asUser(userId, role, (tx) =>
      tx.infoPage.upsert({
        where: { slug },
        create: { slug, title: body.title, bodyHtml: clean, isPublished: body.isPublished, updatedByAdminId: userId },
        update: { title: body.title, bodyHtml: clean, isPublished: body.isPublished, updatedByAdminId: userId },
      }),
    );
    res.json({ page: serializePageAdmin(saved) });
  }),
);

export const adminFaqsRouter = Router();

const faqBody = z.object({
  question: z.string().min(1).max(500),
  answerHtml: z.string().max(50_000),
  position: z.number().int().min(0).optional(),
  isPublished: z.boolean().optional(),
});

// GET /admin/faqs — all FAQ entries incl. drafts.
adminFaqsRouter.get(
  "/faqs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const items = await asUser(userId, role, (tx) =>
      tx.faq.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }] }),
    );
    res.json({ items: items.map(serializeFaqAdmin) });
  }),
);

// POST /admin/faqs — create an entry.
adminFaqsRouter.post(
  "/faqs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const b = parseBody(faqBody, req.body);
    const created = await asUser(userId, role, (tx) =>
      tx.faq.create({
        data: {
          question: b.question,
          answerHtml: sanitizePageHtml(b.answerHtml),
          position: b.position ?? 0,
          isPublished: b.isPublished ?? true,
          updatedByAdminId: userId,
        },
      }),
    );
    res.status(201).json({ faq: serializeFaqAdmin(created) });
  }),
);

// PATCH /admin/faqs/:id — partial update.
adminFaqsRouter.patch(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const b = parseBody(faqBody.partial(), req.body);
    const updated = await asUser(userId, role, async (tx) => {
      const exists = await tx.faq.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "FAQ not found");
      return tx.faq.update({
        where: { id },
        data: {
          question: b.question,
          answerHtml: b.answerHtml !== undefined ? sanitizePageHtml(b.answerHtml) : undefined,
          position: b.position,
          isPublished: b.isPublished,
          updatedByAdminId: userId,
        },
      });
    });
    res.json({ faq: serializeFaqAdmin(updated) });
  }),
);

// DELETE /admin/faqs/:id.
adminFaqsRouter.delete(
  "/faqs/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    await asUser(userId, role, async (tx) => {
      const exists = await tx.faq.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "FAQ not found");
      await tx.faq.delete({ where: { id } });
    });
    res.json({ ok: true });
  }),
);
