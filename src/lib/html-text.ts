// Render composed HTML down to a plain-text alternative. Compose v2 is rich-text always, but we send
// multipart/alternative so plain-text clients still get a readable body — this builds that text/plain
// part from the canonical HTML (see buildDraftEmail). It is deliberately a lightweight structural
// flatten, not a full HTML→text renderer: the input is the composer's own clean output (plus quoted,
// already-sanitized source HTML), so it only needs to turn block boundaries into newlines and let the
// DOM decode entities. Runs in the browser/jsdom (uses a <template>), so it lives here, not in a
// "pure, no-DOM" builder.

// Elements that imply a line break around their content when flattened to text. <br> is handled
// separately (a single newline, no surrounding ones).
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "BLOCKQUOTE",
  "PRE",
  "LI",
  "UL",
  "OL",
  "TR",
  "TABLE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

// Recursively flatten, inserting a single newline at each block boundary (deduped against a newline
// already present) and one for each <br>, so adjacent blocks are single-spaced while an explicit
// empty block (e.g. <div><br></div>) still yields a blank line. Text nodes contribute verbatim; the
// DOM has already decoded their entities.
function flatten(node: Node): string {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? "";
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    if (el.tagName === "BR") {
      text += "\n";
      continue;
    }
    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock && text && !text.endsWith("\n")) text += "\n";
    text += flatten(el);
    if (isBlock && !text.endsWith("\n")) text += "\n";
  }
  return text;
}

/**
 * Flatten composed HTML to a plain-text alternative: block elements become line breaks, `<br>` a
 * single newline, and the DOM decodes entities. Collapses 3+ blank lines to one and trims the ends.
 * Quoted blockquotes lose their "> " markers (the HTML part carries the real fidelity) — an accepted
 * simplification for the alternative part.
 */
export function htmlToText(html: string): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return flatten(tpl.content)
    .replace(/[ \t]+\n/g, "\n") // drop trailing spaces left before a block break
    .replace(/\n{3,}/g, "\n\n") // collapse runs of blank lines
    .trim();
}
