import { describe, expect, it } from "vitest";
import { htmlToText } from "./html-text";

describe("htmlToText", () => {
  it("turns adjacent blocks into single-spaced lines", () => {
    expect(htmlToText("<div>one</div><div>two</div>")).toBe("one\ntwo");
  });

  it("treats an explicit empty block as a blank line between paragraphs", () => {
    expect(htmlToText("<div>one</div><div><br></div><div>two</div>")).toBe("one\n\ntwo");
  });

  it("renders <br> as a single newline within a block", () => {
    expect(htmlToText("<div>one<br>two</div>")).toBe("one\ntwo");
  });

  it("decodes HTML entities via the DOM", () => {
    expect(htmlToText("<div>a &amp; b &lt;c&gt;</div>")).toBe("a & b <c>");
  });

  it("strips formatting tags but keeps their text", () => {
    expect(htmlToText("<div>hi <b>there</b> <i>you</i></div>")).toBe("hi there you");
  });

  it("flattens list items to lines", () => {
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("a\nb");
  });

  it("separates table cells with a tab and rows with a newline (no run-together)", () => {
    const table = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>";
    expect(htmlToText(table)).toBe("a\tb\nc\td");
  });

  it("flattens a quoted blockquote (losing the '>' markers)", () => {
    expect(htmlToText("<div>reply</div><blockquote><div>quoted</div></blockquote>")).toBe(
      "reply\nquoted",
    );
  });

  it("collapses runs of blank lines and trims the ends", () => {
    expect(htmlToText("<div><br></div><div><br></div><div>body</div><div><br></div>")).toBe("body");
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toBe("");
  });
});
