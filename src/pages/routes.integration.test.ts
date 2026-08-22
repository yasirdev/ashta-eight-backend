// CR-008 end-to-end: real app over HTTP against real Postgres with RLS enforced.
// Run: npx tsx src/pages/routes.integration.test.ts   (needs the DB + info_pages/faqs).
// Seeds its own fixtures (TAG-prefixed) and removes them in a finally block.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createApp } from "../server";
import { prismaService } from "../db";
import { issueSession } from "../auth/tokens";

const PORT = 4300;
const B = `http://localhost:${PORT}`;
const TAG = "cr008-probe-";

type R = { name: string; ok: boolean; detail: string };
const results: R[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message.split("\n")[0] });
  }
}

const api = async (path: string, init?: RequestInit & { token?: string }) => {
  const { token, ...rest } = init ?? {};
  const res = await fetch(`${B}${path}`, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...rest.headers,
    },
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: json as any, text };
};

async function main() {
  const server: Server = createServer(createApp());
  await new Promise<void>((r) => server.listen(PORT, r));

  const createdFaqIds: string[] = [];
  let adminId: string | undefined;
  let memberId: string | undefined;

  try {
    const admin = await prismaService.user.create({
      data: { email: `${TAG}admin@example.com`, displayName: "CR008 Admin", role: "administrator" },
    });
    adminId = admin.id;
    const member = await prismaService.user.create({
      data: { email: `${TAG}member@example.com`, displayName: "CR008 Member", role: "member" },
    });
    memberId = member.id;
    const adminToken = (await issueSession(admin.id, "administrator")).access;
    const memberToken = (await issueSession(member.id, "member")).access;

    // Reset the seeded privacy-policy to a known unpublished/empty state.
    await prismaService.infoPage.update({
      where: { slug: "privacy-policy" },
      data: { bodyHtml: "", isPublished: false },
    });

    await check("public GET /pages/:slug hides an unpublished page (404)", async () => {
      const r = await api("/pages/privacy-policy");
      assert.equal(r.status, 404, `expected 404, got ${r.status}`);
    });

    await check("member CANNOT write /admin/pages (403)", async () => {
      const r = await api("/admin/pages/privacy-policy", {
        method: "PUT",
        token: memberToken,
        body: JSON.stringify({ title: "X", bodyHtml: "<p>x</p>", isPublished: true }),
      });
      assert.equal(r.status, 403, `expected 403, got ${r.status}`);
    });

    await check("admin PUT sanitizes + publishes the page", async () => {
      const r = await api("/admin/pages/privacy-policy", {
        method: "PUT",
        token: adminToken,
        body: JSON.stringify({
          title: "Privacy Policy",
          bodyHtml: '<h2>Privacy</h2><p onclick="steal()">We respect you.</p><script>alert(1)</script>',
          isPublished: true,
        }),
      });
      assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.text}`);
      assert.equal(r.body.page.isPublished, true);
    });

    await check("public GET now returns the page with script/handler STRIPPED", async () => {
      const r = await api("/pages/privacy-policy");
      assert.equal(r.status, 200, `expected 200, got ${r.status}`);
      const html: string = r.body.page.bodyHtml;
      assert.ok(html.includes("<h2>Privacy</h2>"), "kept allowed markup");
      assert.ok(html.includes("We respect you."), "kept text");
      assert.ok(!/<script/i.test(html), `script not stripped: ${html}`);
      assert.ok(!/onclick/i.test(html), `handler not stripped: ${html}`);
    });

    await check("admin POST /admin/faqs (published) sanitizes the answer", async () => {
      const r = await api("/admin/faqs", {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({
          question: "How do I cancel?",
          answerHtml: '<p>From <strong>Subscription</strong>.</p><script>x()</script>',
          position: 1,
          isPublished: true,
        }),
      });
      assert.equal(r.status, 201, `expected 201, got ${r.status} ${r.text}`);
      createdFaqIds.push(r.body.faq.id);
      assert.ok(!/<script/i.test(r.body.faq.answerHtml), "answer script stripped");
    });

    await check("admin POST a DRAFT faq (unpublished)", async () => {
      const r = await api("/admin/faqs", {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({ question: "Hidden?", answerHtml: "<p>draft</p>", isPublished: false }),
      });
      assert.equal(r.status, 201);
      createdFaqIds.push(r.body.faq.id);
    });

    await check("public GET /faqs returns published only", async () => {
      const r = await api("/faqs");
      assert.equal(r.status, 200);
      const items: any[] = r.body.items;
      assert.ok(items.some((f) => f.question === "How do I cancel?"), "published faq present");
      assert.ok(!items.some((f) => f.question === "Hidden?"), "draft faq must be hidden");
    });
  } finally {
    // Cleanup — service role bypasses RLS.
    for (const id of createdFaqIds) await prismaService.faq.delete({ where: { id } }).catch(() => {});
    await prismaService.infoPage
      .update({ where: { slug: "privacy-policy" }, data: { bodyHtml: "", isPublished: false } })
      .catch(() => {});
    if (adminId) await prismaService.user.delete({ where: { id: adminId } }).catch(() => {});
    if (memberId) await prismaService.user.delete({ where: { id: memberId } }).catch(() => {});
    server.close();
    await prismaService.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
