"use client";

import type { Bands, BandField } from "./vision/locate.ts";

/**
 * Evidence highlighting, layered by confidence (spike-validated):
 *  1. EXACT — browser OCR (tesseract.js) reads the image once; each field's
 *     known transcription is matched against OCR words → pixel boxes.
 *  2. BAND — the AI locator's approximate vertical band (padded ±2.5%),
 *     used when OCR can't find the text (decorative fonts, rough photos).
 * Verdict latency is untouched: OCR runs after results render and is cached
 * per image URL.
 */

export interface Region {
  kind: "exact" | "band";
  /** percentages of rendered image dimensions */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
  /** index into OcrIndex.lines — matching is line-scoped, see matchExact */
  line: number;
}
export interface OcrLine extends OcrWord {}

export interface OcrIndex {
  words: OcrWord[];
  lines: OcrLine[];
  width: number;
  height: number;
}

const ocrCache = new Map<string, Promise<OcrIndex | null>>();

/** True pixel dimensions of the image — the coordinate space every OCR box
 *  must be normalized against. Normalizing against text-block extents (the
 *  original bug) shifts every box by the label's margin fraction. */
function imageDimensions(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function ocrImage(imageUrl: string): Promise<OcrIndex | null> {
  if (!ocrCache.has(imageUrl)) {
    ocrCache.set(imageUrl, (async () => {
      try {
        const dims = await imageDimensions(imageUrl);
        if (!dims) return null;
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const { data } = await worker.recognize(imageUrl, {}, { blocks: true });
        await worker.terminate();
        const words: OcrWord[] = [];
        const lines: OcrLine[] = [];
        for (const b of data.blocks ?? []) {
          for (const p of b.paragraphs) {
            for (const l of p.lines) {
              const lineIdx = lines.length;
              lines.push({ text: l.text, ...l.bbox, line: lineIdx });
              for (const w of l.words) words.push({ text: w.text, ...w.bbox, line: lineIdx });
            }
          }
        }
        return words.length ? { words, lines, width: dims.width, height: dims.height } : null;
      } catch {
        return null;
      }
    })());
  }
  return ocrCache.get(imageUrl)!;
}

const tokenize = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9%.]/g, " ").split(/\s+/).filter((t) => t.length > 1);

/** Union bbox of the OCR words matching the target's tokens.
 *
 *  Matching is LINE-SCOPED. An earlier version scanned a flat word window and
 *  anchored on any matching token, which let a token shared with another
 *  field drag the box across lines: on a gin label, "Distilled Gin" matched
 *  the GIN in "HARBOR LIGHT GIN" plus the DISTILLED below it, and the
 *  highlight spanned the gap between them. Scoring each line on its own, then
 *  extending only into adjacent lines that are themselves a good match (for
 *  genuinely wrapped text), keeps a phrase's box on the phrase.
 *
 *  Still tolerant of a garbled word: a decorative first word OCR mangles
 *  ("OLD" in display serif) must not force a band fallback when the rest of
 *  the phrase is readable, so a line qualifies on a fraction of the tokens. */
export function matchExact(index: OcrIndex, target: string): Region | null {
  const tokens = tokenize(target);
  if (!tokens.length) return null;

  const need = Math.max(1, Math.ceil(tokens.length * 0.6));
  const byLine = new Map<number, typeof index.words>();
  for (const w of index.words) {
    const arr = byLine.get(w.line);
    if (arr) arr.push(w);
    else byLine.set(w.line, [w]);
  }

  /** Words on one line consuming the target's token budget, greedily. */
  const matchLine = (lineWords: typeof index.words, budget: Map<string, number>) => {
    const hit: typeof index.words = [];
    for (const w of lineWords) {
      const wt = tokenize(w.text)[0] ?? "";
      const left = budget.get(wt) ?? 0;
      if (left > 0) {
        budget.set(wt, left - 1);
        hit.push(w);
      }
    }
    return hit;
  };

  const freshBudget = () => {
    const b = new Map<string, number>();
    for (const t of tokens) b.set(t, (b.get(t) ?? 0) + 1);
    return b;
  };

  let best: { matched: typeof index.words; score: number; ratio: number } | null = null;
  for (const [lineIdx, lineWords] of byLine) {
    const budget = freshBudget();
    const matched = matchLine(lineWords, budget);
    if (!matched.length) continue;

    // Extend into following lines only while they keep contributing AND are
    // themselves mostly target text — that is what wrapped phrases look like,
    // and what an unrelated line sharing one word does not.
    let cursor = lineIdx;
    while (matched.length < tokens.length) {
      const nextWords = byLine.get(cursor + 1);
      if (!nextWords) break;
      const gained = matchLine(nextWords, budget);
      if (!gained.length || gained.length / nextWords.length < 0.5) break;
      matched.push(...gained);
      cursor++;
    }

    // Ratio guards against a long unrelated line that happens to contain one
    // of the tokens outscoring the short line that IS the phrase.
    const spannedWords = lineWords.length +
      (cursor > lineIdx ? Array.from({ length: cursor - lineIdx }, (_, k) => byLine.get(lineIdx + 1 + k)?.length ?? 0).reduce((a, b) => a + b, 0) : 0);
    const ratio = matched.length / Math.max(1, spannedWords);
    if (matched.length < need) continue;
    if (!best || matched.length > best.score || (matched.length === best.score && ratio > best.ratio)) {
      best = { matched, score: matched.length, ratio };
    }
  }
  if (!best) return null;

  const x0 = Math.min(...best.matched.map((w) => w.x0));
  const y0 = Math.min(...best.matched.map((w) => w.y0));
  const x1 = Math.max(...best.matched.map((w) => w.x1));
  const y1 = Math.max(...best.matched.map((w) => w.y1));
  const padX = index.width * 0.008, padY = index.height * 0.006;
  return {
    kind: "exact",
    left: Math.max(0, (x0 - padX) / index.width) * 100,
    top: Math.max(0, (y0 - padY) / index.height) * 100,
    width: Math.min(1, (x1 - x0 + 2 * padX) / index.width) * 100,
    height: Math.min(1, (y1 - y0 + 2 * padY) / index.height) * 100,
  };
}

/** Multi-line block (the warning): union all OCR lines whose tokens overlap the target's. */
export function matchBlock(index: OcrIndex, target: string): Region | null {
  const targetSet = new Set(tokenize(target));
  if (!targetSet.size) return null;
  const hits = index.lines.filter((l) => {
    const lt = tokenize(l.text);
    if (lt.length < 2) return false;
    const overlap = lt.filter((t) => targetSet.has(t)).length / lt.length;
    return overlap >= 0.5;
  });
  if (hits.length < 1) return null;
  const x0 = Math.min(...hits.map((l) => l.x0));
  const y0 = Math.min(...hits.map((l) => l.y0));
  const x1 = Math.max(...hits.map((l) => l.x1));
  const y1 = Math.max(...hits.map((l) => l.y1));
  return {
    kind: "exact",
    left: (x0 / index.width) * 100 - 0.5,
    top: (y0 / index.height) * 100 - 0.5,
    width: ((x1 - x0) / index.width) * 100 + 1,
    height: ((y1 - y0) / index.height) * 100 + 1,
  };
}

function bandRegion(bands: Bands, field: BandField): Region | null {
  const band = bands[field];
  if (!band) return null;
  const [t, b] = band;
  const top = Math.max(0, t / 10 - 2.5);
  const bottom = Math.min(100, b / 10 + 2.5);
  return { kind: "band", left: 0, top, width: 100, height: bottom - top };
}

export interface FieldTexts {
  brand_name?: string;
  class_type?: string;
  alcohol_content?: string;
  net_contents?: string;
  warning?: string;
}

/** Resolve a region per field: exact OCR match first, AI band fallback. */
export async function resolveRegions(
  imageUrl: string,
  fieldTexts: FieldTexts,
  bands: Bands,
): Promise<Partial<Record<BandField, Region>>> {
  const index = await ocrImage(imageUrl);
  const out: Partial<Record<BandField, Region>> = {};
  for (const [field, text] of Object.entries(fieldTexts) as [BandField, string][]) {
    if (!text) {
      const band = bandRegion(bands, field);
      if (band) out[field] = band;
      continue;
    }
    const exact = index
      ? field === "warning"
        ? matchBlock(index, text)
        : matchExact(index, text)
      : null;
    const region = exact ?? bandRegion(bands, field);
    if (region) out[field] = region;
  }
  return out;
}
