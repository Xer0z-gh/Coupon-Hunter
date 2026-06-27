#!/usr/bin/env node
/**
 * build.js — packages the extension for the Chrome Web Store.
 *
 * No dependencies. Works on macOS, Linux, and Windows (CMD, PowerShell, or Git Bash).
 *
 * Usage: npm run build
 */

import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const distDir = join(root, 'dist');
const outFile = join(distDir, `coupon-hunter-v${version}.zip`);

// Only runtime files go in the store upload.
// Tests, build scripts, and docs are intentionally excluded.
const RUNTIME = [
  'manifest.json',
  'background.js',
  'sources.js',
  'core.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.css',
  'popup.js',
  'welcome.html',
  'welcome.js',
  'icons',
];

const missing = RUNTIME.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error(`Build failed — missing files:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

mkdirSync(distDir, { recursive: true });
if (existsSync(outFile)) {
  try { unlinkSync(outFile); } catch { /* will be overwritten */ }
}

// Try `zip` first (macOS, Linux, Git Bash, WSL).
// Fall back to PowerShell's Compress-Archive on plain Windows.
function zipWithCli() {
  // Use 'pipe' so a missing `zip` binary fails silently before the fallback runs.
  execSync(`zip -r "${outFile}" ${RUNTIME.join(' ')}`, { cwd: root, stdio: ['inherit', 'inherit', 'pipe'] });
}

function zipWithPowerShell() {
  // Compress-Archive needs absolute paths and a comma-separated list.
  const paths = RUNTIME.map((f) => join(root, f)).join('","');
  const cmd = [
    'powershell', '-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path "${paths}" -DestinationPath "${outFile}" -Force`,
  ];
  execFileSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit' });
}

let built = false;

try {
  zipWithCli();
  built = true;
} catch {
  // `zip` not found — try the PowerShell fallback (Windows).
  if (process.platform === 'win32') {
    try {
      zipWithPowerShell();
      built = true;
    } catch {
      // fall through to error below
    }
  }
}

if (!built) {
  console.error(
    '\nBuild failed.\n' +
    '  macOS/Linux : `zip` should be available by default\n' +
    '  Windows     : PowerShell fallback also failed — check execution policy'
  );
  process.exit(1);
}

const kb = (statSync(outFile).size / 1024).toFixed(1);
console.log(`\nBuilt dist/coupon-hunter-v${version}.zip (${kb} KB)`);
