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

interface OcrWord {
  text: string;
  x0: number; y0: number; x1: number; y1: number;
}
interface OcrLine extends OcrWord {}

interface OcrIndex {
  words: OcrWord[];
  lines: OcrLine[];
  width: number;
  height: number;
}

const ocrCache = new Map<string, Promise<OcrIndex | null>>();

async function ocrImage(imageUrl: string): Promise<OcrIndex | null> {
  if (!ocrCache.has(imageUrl)) {
    ocrCache.set(imageUrl, (async () => {
      try {
        const { createWorker } = await import("tesseract.js");
        const worker = await createWorker("eng");
        const { data } = await worker.recognize(imageUrl, {}, { blocks: true });
        await worker.terminate();
        const words: OcrWord[] = [];
        const lines: OcrLine[] = [];
        let width = 0, height = 0;
        for (const b of data.blocks ?? []) {
          width = Math.max(width, b.bbox.x1);
          height = Math.max(height, b.bbox.y1);
          for (const p of b.paragraphs) {
            for (const l of p.lines) {
              lines.push({ text: l.text, ...l.bbox });
              for (const w of l.words) words.push({ text: w.text, ...w.bbox });
            }
          }
        }
        return words.length ? { words, lines, width, height } : null;
      } catch {
        return null;
      }
    })());
  }
  return ocrCache.get(imageUrl)!;
}

const tokenize = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9%.]/g, " ").split(/\s+/).filter((t) => t.length > 1);

/** Union bbox of the OCR words matching the target's token sequence. */
function matchExact(index: OcrIndex, target: string): Region | null {
  const tokens = tokenize(target);
  if (!tokens.length) return null;

  const wordTokens = index.words.map((w) => tokenize(w.text)[0] ?? "");
  // Anchor on the first token, then greedily match following tokens nearby.
  for (let i = 0; i < wordTokens.length; i++) {
    if (wordTokens[i] !== tokens[0]) continue;
    const matched = [index.words[i]];
    let ti = 1;
    for (let j = i + 1; j < index.words.length && ti < tokens.length && j < i + tokens.length * 2 + 4; j++) {
      if (wordTokens[j] === tokens[ti]) {
        matched.push(index.words[j]);
        ti++;
      }
    }
    if (matched.length >= Math.max(1, Math.ceil(tokens.length * 0.6))) {
      const x0 = Math.min(...matched.map((w) => w.x0));
      const y0 = Math.min(...matched.map((w) => w.y0));
      const x1 = Math.max(...matched.map((w) => w.x1));
      const y1 = Math.max(...matched.map((w) => w.y1));
      const padX = index.width * 0.008, padY = index.height * 0.006;
      return {
        kind: "exact",
        left: Math.max(0, (x0 - padX) / index.width) * 100,
        top: Math.max(0, (y0 - padY) / index.height) * 100,
        width: Math.min(1, (x1 - x0 + 2 * padX) / index.width) * 100,
        height: Math.min(1, (y1 - y0 + 2 * padY) / index.height) * 100,
      };
    }
  }
  return null;
}

/** Multi-line block (the warning): union all OCR lines whose tokens overlap the target's. */
function matchBlock(index: OcrIndex, target: string): Region | null {
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
