// Sanitizer self-check (CR-008). No framework, no DB: `npx tsx src/pages/sanitize.test.ts`.
// This is the one security-bearing bit of the info-pages/FAQ feature, so it earns a test.
import assert from "node:assert/strict";
import { sanitizePageHtml } from "./sanitize";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${(e as Error).message.split("\n")[0]}`);
  }
}

check("keeps the allowed formatting subset", () => {
  const out = sanitizePageHtml("<h2>Title</h2><p>Hello <strong>world</strong></p><ul><li>a</li></ul>");
  assert.equal(out, "<h2>Title</h2><p>Hello <strong>world</strong></p><ul><li>a</li></ul>");
});

check("strips <script> and its contents", () => {
  const out = sanitizePageHtml("<p>ok</p><script>alert(document.cookie)</script>");
  assert.equal(out, "<p>ok</p>");
});

check("drops event-handler attributes", () => {
  const out = sanitizePageHtml('<p onclick="steal()">x</p>');
  assert.equal(out, "<p>x</p>");
});

check("neutralises javascript: links but keeps http/mailto", () => {
  assert.ok(!/javascript:/i.test(sanitizePageHtml('<a href="javascript:alert(1)">x</a>')));
  const ok = sanitizePageHtml('<a href="https://ashta.example">x</a>');
  assert.ok(ok.includes('href="https://ashta.example"'));
  assert.ok(ok.includes('rel="noopener noreferrer nofollow"'));
});

check("strips target so no new browsing context can open", () => {
  assert.ok(!/target=/i.test(sanitizePageHtml('<a href="https://x.example" target="_blank">x</a>')));
});

check("removes style/class and unknown tags", () => {
  const out = sanitizePageHtml('<div class="x" style="color:red"><iframe src="https://e.example"></iframe><p>keep</p></div>');
  assert.equal(out, "<p>keep</p>");
});

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall sanitizer checks passed");
