// Dark-mode color remapping for email bodies.
//
// The reading-pane iframe is theme-aware (see lib/sanitize.ts frameStyle): emails that
// ship no colors of their own inherit a readable dark fg/bg. But emails that hard-code
// light colors (e.g. color:#000 with no background, a white bgcolor table) still look
// wrong on the dark canvas. This module rewrites those authored colors for dark mode.
//
// It must run at srcdoc-build time, in the parent realm: the iframe runs no scripts
// (no allow-scripts), so nothing inside the frame can adjust colors. DOMPurify strips
// <style> blocks and <body> tags entirely (its html profile carries no CSS sanitizer),
// so the only authored color surface that survives sanitization is inline `style`
// attributes, `bgcolor` attributes, and `<font color>` — which is exactly what we walk.
//
// Strategy: property-aware *conditional* lightness inversion. We only touch a color that
// would be illegible in dark mode — a dark foreground or a light background — and flip its
// HSL lightness (preserving hue/saturation so brand colors stay recognizable). Already-light
// text and already-dark backgrounds are left untouched, which preserves emails that were
// authored dark in the first place, per-color, with no fragile whole-email detection. The
// rule is idempotent: a color we've inverted won't qualify on a second pass.

interface Rgba {
  r: number; // 0–255
  g: number; // 0–255
  b: number; // 0–255
  a: number; // 0–1
}

type ColorRole = "foreground" | "background";

// Common CSS named colors → hex. The hard-coded-light emails this targets overwhelmingly
// use hex/rgb or these everyday names; an unrecognized name parses as null and is left
// unchanged (safe degradation — at worst it stays its authored color, never corrupted).
const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  aqua: "#00ffff",
  magenta: "#ff00ff",
  fuchsia: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  maroon: "#800000",
  olive: "#808000",
  lime: "#00ff00",
  teal: "#008080",
  navy: "#000080",
  purple: "#800080",
  orange: "#ffa500",
  darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9",
  lightgray: "#d3d3d3",
  lightgrey: "#d3d3d3",
  dimgray: "#696969",
  dimgrey: "#696969",
  gainsboro: "#dcdcdc",
  whitesmoke: "#f5f5f5",
  ghostwhite: "#f8f8ff",
  ivory: "#fffff0",
  snow: "#fffafa",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  lavender: "#e6e6fa",
};

// CSS-wide and dynamic keywords we must not convert (no concrete color to invert).
const PASSTHROUGH_KEYWORDS = new Set([
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "none",
]);

// Inline-style properties we adapt, mapped to the role that decides the threshold.
// `border-color` and friends are deliberately out of scope for now (a light border on a
// dark canvas is visible, not broken) to keep the surface tight.
const COLOR_PROP_ROLE: Record<string, ColorRole> = {
  color: "foreground",
  "background-color": "background",
  background: "background",
};

// Matches a single CSS color token in a value: rgb()/rgba(), then hex (longest first so
// #aabbcc isn't read as #aab), then a known color name on a word boundary.
const NAMED_RE = Object.keys(NAMED_COLORS).join("|");
const COLOR_TOKEN_RE = new RegExp(
  `rgba?\\([^)]*\\)|#[0-9a-f]{8}(?![0-9a-f])|#[0-9a-f]{6}(?![0-9a-f])|#[0-9a-f]{4}(?![0-9a-f])|#[0-9a-f]{3}(?![0-9a-f])|\\b(?:${NAMED_RE})\\b`,
  "gi",
);

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexByte(n: number): string {
  return clampByte(n).toString(16).padStart(2, "0");
}

function expandHexDigits(hex: string): string {
  // #rgb → #rrggbb and #rgba → #rrggbbaa
  if (hex.length === 3 || hex.length === 4) {
    return Array.from(hex, (c) => c + c).join("");
  }
  return hex;
}

/** Parse a CSS color into RGBA, or null if it's unparseable or a keyword we leave alone. */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  if (value === "") return null;
  if (PASSTHROUGH_KEYWORDS.has(value)) return null;

  const named = NAMED_COLORS[value];
  // Both named colors and `#...` literals resolve to bare hex digits (no leading `#`).
  const hex = named !== undefined ? named.slice(1) : value.startsWith("#") ? value.slice(1) : null;
  if (hex !== null) {
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expanded = expandHexDigits(hex);
    if (expanded.length !== 6 && expanded.length !== 8) return null;
    const r = Number.parseInt(expanded.slice(0, 2), 16);
    const g = Number.parseInt(expanded.slice(2, 4), 16);
    const b = Number.parseInt(expanded.slice(4, 6), 16);
    const a = expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (fn?.[1] !== undefined) {
    // Accept both legacy comma syntax and modern space syntax with an optional `/ alpha`.
    const parts = fn[1]
      .replace("/", " ")
      .split(/[\s,]+/)
      .filter((p) => p !== "");
    const channel = (raw: string | undefined): number | null => {
      if (raw === undefined) return null;
      const num = Number.parseFloat(raw);
      if (Number.isNaN(num)) return null;
      return raw.endsWith("%") ? (num / 100) * 255 : num;
    };
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if (r === null || g === null || b === null) return null;
    let a = 1;
    if (parts[3] !== undefined) {
      const raw = parts[3];
      const num = Number.parseFloat(raw);
      if (Number.isNaN(num)) return null;
      a = raw.endsWith("%") ? num / 100 : num;
    }
    return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: Math.max(0, Math.min(1, a)) };
  }

  return null;
}

/** Perceived brightness (YIQ, 0–255) — the classic "should text be black or white" split. */
function brightness({ r, g, b }: Rgba): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const hue = (t: number): number => {
    let tn = t;
    if (tn < 0) tn += 1;
    if (tn > 1) tn -= 1;
    if (tn < 1 / 6) return p + (q - p) * 6 * tn;
    if (tn < 1 / 2) return q;
    if (tn < 2 / 3) return p + (q - p) * (2 / 3 - tn) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 };
}

/** Flip lightness for dark mode, preserving hue, saturation, and alpha. */
function invertLightness(color: Rgba): Rgba {
  const { h, s, l } = rgbToHsl(color);
  const { r, g, b } = hslToRgb(h, s, 1 - l);
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b), a: color.a };
}

function formatColor(color: Rgba): string {
  if (color.a >= 1) return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
  const a = Math.round(color.a * 1000) / 1000;
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${a})`;
}

/**
 * Adapt one authored color for dark mode given its role. Returns the original string
 * unchanged when the color parses to something already suited to dark mode (light text /
 * dark background) or can't be parsed — so callers can cheaply detect "no change".
 */
export function adaptColor(input: string, role: ColorRole): string {
  const color = parseColor(input);
  if (color === null) return input;
  const bright = brightness(color);
  const shouldInvert = role === "foreground" ? bright < 128 : bright > 128;
  if (!shouldInvert) return input;
  return formatColor(invertLightness(color));
}

function remapColorTokens(value: string, role: ColorRole): string {
  return value.replace(COLOR_TOKEN_RE, (token) => adaptColor(token, role));
}

/** Remap colors in an inline `style` attribute value, preserving everything else verbatim. */
export function remapInlineStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => {
      const colon = decl.indexOf(":");
      if (colon < 0) return decl;
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const role = COLOR_PROP_ROLE[prop];
      if (role === undefined) return decl;
      const value = decl.slice(colon + 1);
      // The `background` shorthand can carry an image or gradient; don't risk mangling a
      // url()/gradient() — only bare background colors are remapped.
      if (prop === "background" && /url\(|gradient\(/i.test(value)) return decl;
      const remapped = remapColorTokens(value, role);
      return remapped === value ? decl : `${decl.slice(0, colon)}:${remapped}`;
    })
    .join(";");
}

/**
 * Rewrite authored light colors in already-sanitized email HTML for dark mode. Operates on
 * inline `style`, `bgcolor`, and `<font color>` — the only authored color surface DOMPurify
 * leaves behind. Images and non-color markup are untouched; the transform only edits color
 * values (to numeric-derived strings) and re-serializes via the DOM, so it introduces no new
 * markup and can't reintroduce anything the prior sanitize pass removed.
 *
 * Security: the input is DOMPurify output (mXSS-safe and parser-normalized), and
 * `DOMParser.parseFromString` neither executes scripts nor fetches resources — it just builds
 * a detached tree in the parent realm. Even so, the result re-enters a sandboxed iframe with
 * no `allow-scripts` and a `default-src 'none'` CSP, so nothing this round-trip could produce
 * is executable or able to load. Run it only on already-sanitized HTML.
 */
export function adaptHtmlForDark(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");

  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>("*"))) {
    const style = el.getAttribute("style");
    if (style !== null) {
      const remapped = remapInlineStyle(style);
      if (remapped !== style) el.setAttribute("style", remapped);
    }

    const bgcolor = el.getAttribute("bgcolor");
    if (bgcolor !== null) {
      const remapped = adaptColor(bgcolor, "background");
      if (remapped !== bgcolor) el.setAttribute("bgcolor", remapped);
    }

    if (el.tagName === "FONT") {
      const color = el.getAttribute("color");
      if (color !== null) {
        const remapped = adaptColor(color, "foreground");
        if (remapped !== color) el.setAttribute("color", remapped);
      }
    }
  }

  return doc.body.innerHTML;
}
