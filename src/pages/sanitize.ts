import sanitizeHtml from "sanitize-html";

// CR-008 — admin-authored HTML for info pages (privacy/terms/about) and FAQ answers is
// sanitized ON WRITE, before it is ever stored. Authors are trusted 2FA staff, so this is
// defense-in-depth, not the sole guard: the admin preview renders in a sandboxed iframe and
// the Flutter renderer (flutter_widget_from_html) ignores scripts. But stored HTML is served
// to every member and re-rendered in other admins' browsers, so we never persist a script,
// event handler, style, or arbitrary tag. Allow only the small formatting subset a legal page
// or FAQ answer actually needs. Links are forced to open safely (no `target=_blank` reverse
// tabnabbing) and restricted to http/https/mailto.
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr",
    "h1", "h2", "h3", "h4",
    "ul", "ol", "li",
    "strong", "b", "em", "i", "u",
    "blockquote", "a",
  ],
  allowedAttributes: { a: ["href", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  // Force rel on links; drop target so nothing can open a new context. disallowedTagsMode
  // 'discard' strips a disallowed tag AND its content for <script>/<style> (escape would
  // leak the source text into the page).
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow" }, true),
  },
  disallowedTagsMode: "discard",
};

export function sanitizePageHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS);
}
