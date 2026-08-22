import { Router } from "express";
import { z } from "zod";
import type { CoachingLead, Prisma } from "@prisma/client";
import { asUser, prismaService } from "../db";
import { AppError, asyncHandler, parseBody, parsePagination } from "../http";
import { requireAdmin, requireAuth } from "../auth/middleware";

// Coaching leads (contracts §Public POST /leads + §Admin — leads). The public
// application form is pre-account (no auth), so it writes via the service role —
// a contract-listed "anonymous questionnaire/form capture" flow. Admin views/edits
// run through the RLS staff path (asUser → coaching_leads_staff policy).

const serializeLead = (l: CoachingLead) => ({
  id: l.id,
  userId: l.userId,
  fullName: l.fullName,
  email: l.email,
  phone: l.phone,
  stage: l.stage,
  source: l.source,
  answers: l.answers,
  notes: l.notes,
  createdAt: l.createdAt,
  updatedAt: l.updatedAt,
});

// Public website application form → pipeline (stage 'applied').
export const leadsRouter = Router();
leadsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        fullName: z.string().min(1).max(200),
        email: z.string().email(),
        phone: z.string().max(40).optional(),
        answers: z.unknown().optional(),
      }),
      req.body,
    );
    const lead = await prismaService.coachingLead.create({
      data: {
        fullName: body.fullName,
        email: body.email,
        phone: body.phone,
        answers: (body.answers ?? undefined) as Prisma.InputJsonValue | undefined,
        source: "website_form",
        stage: "applied",
      },
    });
    res.status(201).json({ leadId: lead.id });
  }),
);

// Admin pipeline (R1: 'applied' only; PATCH lets an admin advance stage / add notes).
export const adminLeadsRouter = Router();
adminLeadsRouter.use(requireAuth, requireAdmin);

adminLeadsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const { page, limit, skip } = parsePagination(req.query);
    const q = parseBody(
      z.object({ stage: z.enum(["applied", "contacted", "qualified", "converted", "lost"]).optional() }),
      req.query,
    );
    const where = q.stage ? { stage: q.stage } : {};
    const { items, total } = await asUser(userId, role, async (tx) => {
      const [items, total] = await Promise.all([
        tx.coachingLead.findMany({ where, orderBy: { createdAt: "desc" }, skip, take: limit }),
        tx.coachingLead.count({ where }),
      ]);
      return { items, total };
    });
    res.json({ items: items.map(serializeLead), page, limit, total });
  }),
);

adminLeadsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const lead = await asUser(userId, role, (tx) => tx.coachingLead.findFirst({ where: { id } }));
    if (!lead) throw new AppError(404, "not_found", "Lead not found");
    res.json({ lead: serializeLead(lead) });
  }),
);

adminLeadsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { userId, role } = req.auth!;
    const id = String(req.params.id);
    const body = parseBody(
      z.object({
        stage: z.enum(["applied", "contacted", "qualified", "converted", "lost"]).optional(),
        notes: z.string().max(5000).optional(),
      }),
      req.body,
    );
    const updated = await asUser(userId, role, async (tx) => {
      const exists = await tx.coachingLead.findFirst({ where: { id } });
      if (!exists) throw new AppError(404, "not_found", "Lead not found");
      return tx.coachingLead.update({ where: { id }, data: body });
    });
    res.json({ lead: serializeLead(updated) });
  }),
);
