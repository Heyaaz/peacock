import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PeacockMark, PeacockWordmark } from "./peacock-mark";

describe("PeacockMark", () => {
  it("is the script P alone: one filled path in the current color, on its tile's square", () => {
    const markup = renderToStaticMarkup(createElement(PeacockMark));
    expect(markup).toContain('viewBox="0 0 100 100"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup.match(/<path /gu)).toHaveLength(1);
    // no stroke: the old chevron and its crossbar are gone
    expect(markup).not.toContain("stroke");
    expect(markup).toContain('aria-hidden="true"');
    const d = /d="([^"]+)"/u.exec(markup)![1]!;
    // the glyph stays inside the tile, the mock's 84% and nudge put it at about 11-88%
    const numbers = d.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    expect(Math.min(...numbers)).toBeGreaterThan(10);
    expect(Math.max(...numbers)).toBeLessThan(90);
  });

  it("is named when it stands for the app, and the wordmark stays", () => {
    expect(renderToStaticMarkup(createElement(PeacockMark, { title: "Peacock" }))).toContain('aria-label="Peacock"');
    expect(renderToStaticMarkup(createElement(PeacockWordmark))).toContain(">PEACOCK<");
  });
});
