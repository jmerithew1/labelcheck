import { describe, it, expect } from "vitest";
import { parseCsv, toCsv } from "./csv.ts";

// The CSV parser feeds the batch pipeline (200-300 applications per run).
// A silent parse bug corrupts every row after it, so every RFC 4180-ish
// behavior it claims gets a test that fails if it regresses.

describe("parseCsv", () => {
  it("parses a plain comma-separated grid", () => {
    expect(parseCsv("a,b,c\nd,e,f")).toEqual([
      ["a", "b", "c"],
      ["d", "e", "f"],
    ]);
  });

  it("strips a UTF-8 BOM from the first cell (Excel exports carry one)", () => {
    expect(parseCsv("﻿brand,abv\nX,45%")).toEqual([
      ["brand", "abv"],
      ["X", "45%"],
    ]);
  });

  it("treats CRLF and LF line endings identically", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual(parseCsv("a,b\nc,d\n"));
  });

  it("keeps commas inside quoted fields", () => {
    expect(parseCsv('brand,"Louisville, KY",done')).toEqual([
      ["brand", "Louisville, KY", "done"],
    ]);
  });

  it('unescapes doubled quotes inside quoted fields ("" -> ")', () => {
    expect(parseCsv('a,"say ""hi""",b')).toEqual([["a", 'say "hi"', "b"]]);
  });

  it("keeps newlines inside quoted fields as cell content, not row breaks", () => {
    expect(parseCsv('"line1\r\nline2",x\r\ny,z')).toEqual([
      ["line1\r\nline2", "x"],
      ["y", "z"],
    ]);
  });

  it("skips fully blank lines without inventing empty rows", () => {
    expect(parseCsv("a,b\n\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not append a phantom row for a trailing newline", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
  });

  it("preserves trailing empty cells (row width matters for column mapping)", () => {
    expect(parseCsv("a,b,\nc,,e")).toEqual([
      ["a", "b", ""],
      ["c", "", "e"],
    ]);
  });

  it("handles a quoted field at the very start and very end of the input", () => {
    expect(parseCsv('"a,1",b\nc,"d,2"')).toEqual([
      ["a,1", "b"],
      ["c", "d,2"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });
});

describe("toCsv", () => {
  it("quotes cells containing commas, quotes, or newlines and escapes quotes", () => {
    expect(toCsv([["a,b", 'q"x', "l1\nl2", "plain"]])).toBe(
      '"a,b","q""x","l1\nl2",plain',
    );
  });

  it("renders undefined as empty and numbers as text, joining rows with CRLF", () => {
    expect(toCsv([["a", undefined, 5], ["b", "c", "d"]])).toBe("a,,5\r\nb,c,d");
  });

  it("round-trips through parseCsv (batch results are re-exported as CSV)", () => {
    const rows = [
      ["brand", "note", "vol"],
      ["Stone's Throw", 'has "quotes", commas,\nand newlines', "750 mL"],
      ["Plain", "", "1 L"],
    ];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});
