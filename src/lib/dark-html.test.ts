import { describe, expect, it } from "vitest";
import { adaptColor, adaptHtmlForDark, parseColor, remapInlineStyle } from "@/lib/dark-html";

describe("parseColor", () => {
  it("parses #rgb, #rrggbb, and alpha hex", () => {
    expect(parseColor("#000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
  });

  it("parses rgb()/rgba() in comma and space syntax", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("rgb(10 20 30 / 50%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
  });

  it("parses common named colors", () => {
    expect(parseColor("black")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("WHITE")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("returns null for keywords and unparseable input", () => {
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("inherit")).toBeNull();
    expect(parseColor("var(--x)")).toBeNull();
    expect(parseColor("notacolor")).toBeNull();
    expect(parseColor("#xyz")).toBeNull();
  });
});

describe("adaptColor", () => {
  it("lightens dark foreground colors", () => {
    expect(adaptColor("#000000", "foreground")).toBe("#ffffff");
    expect(adaptColor("black", "foreground")).toBe("#ffffff");
  });

  it("darkens light background colors", () => {
    expect(adaptColor("#ffffff", "background")).toBe("#000000");
    expect(adaptColor("white", "background")).toBe("#000000");
  });

  it("leaves already-light foreground and already-dark background untouched", () => {
    expect(adaptColor("#ffffff", "foreground")).toBe("#ffffff");
    expect(adaptColor("#111111", "background")).toBe("#111111");
  });

  it("leaves unparseable values and keywords untouched", () => {
    expect(adaptColor("transparent", "background")).toBe("transparent");
    expect(adaptColor("var(--brand)", "foreground")).toBe("var(--brand)");
  });

  it("preserves alpha when inverting", () => {
    expect(adaptColor("rgba(0, 0, 0, 0.5)", "foreground")).toBe("rgba(255, 255, 255, 0.5)");
  });

  it("preserves hue while flipping lightness of a saturated color", () => {
    // Dark navy text → lighter blue, still recognizably blue (b channel dominant).
    const out = parseColor(adaptColor("#000080", "foreground"));
    expect(out).not.toBeNull();
    if (out) {
      expect(out.b).toBeGreaterThan(out.r);
      expect(out.b).toBeGreaterThan(out.g);
      expect(out.b).toBeGreaterThan(128); // got lighter
    }
  });

  it("lightens a saturated color that sits at HSL lightness 0.5 (pure blue link)", () => {
    // The classic email link color: HSL lightness is exactly 0.5, so an HSL-lightness flip
    // would be a no-op. Perceived-brightness inversion must still make it readable.
    const remapped = adaptColor("#0000ff", "foreground");
    expect(remapped).not.toBe("#0000ff");
    const out = parseColor(remapped);
    expect(out).not.toBeNull();
    if (out) {
      expect(out.b).toBeGreaterThan(out.r); // still blue-dominant
      // Perceived brightness rose well past the dark threshold — now legible on dark.
      expect((out.r * 299 + out.g * 587 + out.b * 114) / 1000).toBeGreaterThan(128);
    }
  });

  it("is idempotent — a remapped color stays put on a second pass", () => {
    const once = adaptColor("#000000", "foreground");
    expect(adaptColor(once, "foreground")).toBe(once);
    const blue = adaptColor("#0000ff", "foreground");
    expect(adaptColor(blue, "foreground")).toBe(blue);
  });
});

describe("remapInlineStyle", () => {
  it("remaps color and background-color, leaving other declarations verbatim", () => {
    expect(remapInlineStyle("color:#000;margin:0;background-color:#fff")).toBe(
      "color:#ffffff;margin:0;background-color:#000000",
    );
  });

  it("keeps a url() value with an internal ; as a single declaration", () => {
    // A naive split on ';' would fragment this into a phantom 'color:black)' declaration.
    const style = "background:url(data:image/svg+xml;color:black) no-repeat";
    expect(remapInlineStyle(style)).toBe(style);
  });

  it("leaves a background shorthand that uses a function untouched", () => {
    expect(remapInlineStyle("background:linear-gradient(#fff,#000)")).toBe(
      "background:linear-gradient(#fff,#000)",
    );
  });

  it("preserves !important and surrounding whitespace", () => {
    expect(remapInlineStyle("color: #000 !important")).toBe("color: #ffffff !important");
  });
});

// Helper: pull the resolved inline color off an element after a dark-mode pass, so
// assertions don't depend on whether the serializer emits hex or rgb().
function resolvedStyle(html: string, prop: "color" | "background-color"): string {
  const el = new DOMParser().parseFromString(adaptHtmlForDark(html), "text/html").body
    .firstElementChild as HTMLElement;
  return el.style.getPropertyValue(prop);
}

describe("adaptHtmlForDark", () => {
  it("lightens a hard-coded dark foreground color", () => {
    const color = parseColor(resolvedStyle('<p style="color:#000">hi</p>', "color"));
    expect(color).not.toBeNull();
    if (color) expect((color.r * 299 + color.g * 587 + color.b * 114) / 1000).toBeGreaterThan(128);
  });

  it("does not mangle a background shorthand that carries an image", () => {
    // The `;` inside the data: URL must not fragment the declaration, and a shorthand with a
    // function is left untouched, so the whole thing round-trips byte-for-byte.
    const html =
      '<div style="background:url(data:image/png;base64,AAAA) #ffffff no-repeat">x</div>';
    expect(adaptHtmlForDark(html)).toBe(html);
  });

  it("remaps the color half of a background shorthand with no image", () => {
    const bg = parseColor(
      resolvedStyle('<div style="background:#ffffff">x</div>', "background-color"),
    );
    expect(bg).not.toBeNull();
    if (bg) expect((bg.r * 299 + bg.g * 587 + bg.b * 114) / 1000).toBeLessThan(128);
  });

  it("remaps bgcolor attributes", () => {
    const out = adaptHtmlForDark('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>');
    expect(out).toContain('bgcolor="#000000"');
  });

  it("remaps <font color>", () => {
    const out = adaptHtmlForDark('<font color="#000000">x</font>');
    expect(out).toContain('color="#ffffff"');
  });

  it("preserves an already-dark email design untouched", () => {
    const html = '<div style="background-color:#111111;color:#eeeeee">x</div>';
    expect(adaptHtmlForDark(html)).toBe(html);
  });

  it("never touches images", () => {
    const html = '<img src="https://x.test/a.png" alt="a">';
    expect(adaptHtmlForDark(html)).toContain('src="https://x.test/a.png"');
  });

  it("leaves color-free markup unchanged", () => {
    const html = "<p>hello <strong>world</strong></p>";
    expect(adaptHtmlForDark(html)).toBe(html);
  });
});
