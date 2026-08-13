// Rebuild samples/batch/sample-batch.zip from what is actually on disk.
//
// This file used to be a hand-built artifact with no generator, which meant the
// "sample bundle (zip)" download silently disagreed with batch.csv after any
// change to the batch set — a user who downloaded the bundle would get
// different images from the ones "Load the sample batch" runs.
//
// Store-only (no DEFLATE) on purpose: PNG is already compressed, so deflating
// buys ~nothing, and store-only keeps this a ~70-line dependency-free writer
// rather than a native dependency added days before a submission.
//
//   node samples/tools/make-sample-zip.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BATCH = path.join(ROOT, 'samples', 'batch');
const OUT = path.join(BATCH, 'sample-batch.zip');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

// The archive is flat — batch.csv and the PNGs at the root — because the batch
// page's drop handler reads a flat file list, not a directory tree.
const entries = [
  { name: 'batch.csv', file: path.join(BATCH, 'batch.csv') },
  ...fs.readdirSync(path.join(BATCH, 'images'))
    .filter((f) => /\.png$/i.test(f))
    .sort()
    .map((f) => ({ name: f, file: path.join(BATCH, 'images', f) })),
];

const locals = [];
const centrals = [];
let offset = 0;
for (const e of entries) {
  const data = fs.readFileSync(e.file);
  const name = Buffer.from(e.name, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);       // version needed
  local.writeUInt16LE(0, 6);        // flags
  local.writeUInt16LE(0, 8);        // method 0 = stored
  local.writeUInt16LE(0, 10);       // time (fixed — a changing timestamp would
  local.writeUInt16LE(0x21, 12);    // date       make every rebuild a diff)
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  locals.push(local, data);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  // 30 extra-len, 32 comment-len, 34 disk-start, 36 internal-attrs and
  // 38 external-attrs are all zero, which Buffer.alloc already gave us.
  central.writeUInt32LE(offset, 42); // relative offset of the local header
  name.copy(central, 46);
  centrals.push(central);

  offset += local.length + data.length;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));

// Verify the bundle agrees with the CSV it ships beside — the whole point of
// generating it. A bundle listing files the CSV never references (or missing
// ones it does) is the stale-artifact bug this script exists to prevent.
const csv = fs.readFileSync(path.join(BATCH, 'batch.csv'), 'utf8').replace(/^﻿/, '');
const wanted = csv.trim().split(/\r?\n/).slice(1).map((l) => l.split(',')[0].trim());
const packed = new Set(entries.map((e) => e.name));
const missing = wanted.filter((w) => !packed.has(w));
const extra = [...packed].filter((p) => p !== 'batch.csv' && !wanted.includes(p));
if (missing.length || extra.length) {
  console.error(`ZIP DISAGREES WITH batch.csv — missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
  process.exit(1);
}
console.log(`sample-batch.zip: ${entries.length} entries (${wanted.length} images + batch.csv), ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
console.log('verified against batch.csv — every referenced image is present, no extras');
