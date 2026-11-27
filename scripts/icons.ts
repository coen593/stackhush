// Makes the PNG icons in public/ from public/icon.svg with headless Chrome (no extra
// dependency). The PNGs are committed; run this again only when icon.svg changes.
//
//   npm run icons
//
// Set CHROME_PATH when Chrome is not at a usual location.
//
// - apple-touch-icon.png (180): iOS wants a square without transparency; icon.svg has a solid
//   background, so the PNG has none.
// - icon-192.png and icon-512.png: the manifest icons ("any").
// - icon-maskable-512.png: the icon at 80% on the same background, so a launcher's mask (a circle
//   at worst) never cuts into the drawing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC_DIR = join(ROOT, 'public');
const BACKGROUND = '#1c1c1a';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];

const ICONS = [
  { file: 'apple-touch-icon.png', size: 180, drawing: 1 },
  { file: 'icon-192.png', size: 192, drawing: 1 },
  { file: 'icon-512.png', size: 512, drawing: 1 },
  { file: 'icon-maskable-512.png', size: 512, drawing: 0.8 },
] as const;

const chromePath = CHROME_CANDIDATES.find((path) => path && existsSync(path));
if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH.');

const svg = readFileSync(join(PUBLIC_DIR, 'icon.svg'), 'utf8');
const workDir = mkdtempSync(join(tmpdir(), 'stackhush-icons-'));

try {
  for (const icon of ICONS) {
    const drawn = Math.round(icon.size * icon.drawing);
    const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:${icon.size}px;height:${icon.size}px;background:${BACKGROUND};overflow:hidden}
body{display:flex;align-items:center;justify-content:center}
svg{width:${drawn}px;height:${drawn}px;display:block}</style>${svg}`;
    const page = join(workDir, 'icon.html');
    writeFileSync(page, html);
    execFileSync(
      chromePath,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--user-data-dir=${join(workDir, 'profile')}`,
        `--window-size=${icon.size},${icon.size}`,
        `--screenshot=${join(PUBLIC_DIR, icon.file)}`,
        `file://${page}`,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    );
    console.log(`Wrote public/${icon.file}`);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
