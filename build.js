#!/usr/bin/env node
/**
 * build.js — packages the extension into a Chrome Web Store .zip.
 *
 * Pure Node: it writes the ZIP itself (zlib DEFLATE + a hand-built central
 * directory). No dependencies, and it never shells out to another program, so
 * it behaves identically on macOS, Linux, and Windows.
 *
 * Usage: npm run build
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const distDir = join(root, "dist");
const outFile = join(distDir, `coupon-hunter-v${version}.zip`);

// Only runtime files go in the store upload. Tests, build scripts, the worker,
// and docs are intentionally excluded.
const RUNTIME = [
  "manifest.json",
  "background.js",
  "sources.js",
  "core.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.css",
  "popup.js",
  "welcome.html",
  "welcome.js",
  "icons",
];

// --- CRC-32 (standard polynomial) — required by the ZIP format ---------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- gather the files (forward-slash zip paths) ------------------------------
function collect() {
  const files = [];
  const addFile = (abs, name) => files.push({ name, data: readFileSync(abs) });
  const walk = (abs, prefix) => {
    for (const entry of readdirSync(abs)) {
      const p = join(abs, entry);
      const name = `${prefix}/${entry}`;
      if (statSync(p).isDirectory()) walk(p, name);
      else addFile(p, name);
    }
  };
  for (const item of RUNTIME) {
    const abs = join(root, item);
    if (!existsSync(abs)) throw new Error(`Build failed — missing ${item}`);
    if (statSync(abs).isDirectory()) walk(abs, item);
    else addFile(abs, item);
  }
  return files;
}

// --- assemble the ZIP in memory ----------------------------------------------
function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const deflated = deflateRawSync(f.data, { level: 9 });
    const store = deflated.length >= f.data.length; // don't grow tiny files
    const method = store ? 0 : 8;
    const body = store ? f.data : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(f.data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // central directory signature
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end-of-central-directory signature
  end.writeUInt16LE(files.length, 8); // entries on this disk
  end.writeUInt16LE(files.length, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12); // central directory size
  end.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...parts, centralBuf, end]);
}

mkdirSync(distDir, { recursive: true });
const files = collect();
const zip = buildZip(files);
writeFileSync(outFile, zip);
console.log(
  `Built dist/coupon-hunter-v${version}.zip (${(zip.length / 1024).toFixed(1)} KB, ${files.length} files)`
);
