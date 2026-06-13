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

  it("is idempotent — a remapped color stays put on a second pass", () => {
    const once = adaptColor("#000000", "foreground");
    expect(adaptColor(once, "foreground")).toBe(once);
  });
});

describe("remapInlineStyle", () => {
  it("remaps color and background-color", () => {
    expect(remapInlineStyle("color:#000;background-color:#fff")).toBe(
      "color:#ffffff;background-color:#000000",
    );
  });

  it("leaves non-color declarations and unrelated properties verbatim", () => {
    expect(remapInlineStyle("margin:0;font-size:14px")).toBe("margin:0;font-size:14px");
  });

  it("does not touch a background image/gradient", () => {
    const style = "background:url(data:image/png;base64,AAAA) no-repeat";
    expect(remapInlineStyle(style)).toBe(style);
    const grad = "background:linear-gradient(#fff,#000)";
    expect(remapInlineStyle(grad)).toBe(grad);
  });

  it("preserves !important and surrounding whitespace", () => {
    expect(remapInlineStyle("color: #000 !important")).toBe("color: #ffffff !important");
  });
});

describe("adaptHtmlForDark", () => {
  it("remaps inline light colors", () => {
    const out = adaptHtmlForDark('<p style="color:#000">hi</p>');
    expect(out).not.toContain('#000"');
    expect(out).toContain("#ffffff");
  });

  it("remaps bgcolor attributes", () => {
    const out = adaptHtmlForDark('<table bgcolor="#ffffff"><tr><td>x</td></tr></table>');
    expect(out).toContain('bgcolor="#000000"');
  });

  it("remaps <font color>", () => {
    const out = adaptHtmlForDark('<font color="#000000">x</font>');
    expect(out).toContain('color="#ffffff"');
  });

  it("preserves an already-dark email design", () => {
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
