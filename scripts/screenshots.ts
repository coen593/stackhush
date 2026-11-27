// Takes the screenshots in docs/screenshots/ from the local database's synthetic state
// (run `npm run db:migrate:local` and `npm run seed:local` first). It starts the dev server,
// signs in with a one-time local link, drives headless Chrome over the DevTools protocol (no
// extra dependency) and stops both again.
//
// The dashboard shows a source as "not configured" unless its token is set, so the dev server
// gets placeholder tokens through a temporary .dev.vars, deleted again at the end. The script
// refuses to run when a .dev.vars already exists. Nothing calls an API with them: the dev
// server runs no cron, so no check is made and no email is sent.
//
//   npm run screenshots
//
// Set CHROME_PATH when Chrome is not at a usual location. Output: docs/screenshots/<name>.png.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import config from '../stackhush.config.ts';
import { githubTokenSecretName } from '../worker/config.ts';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = join(ROOT, 'docs', 'screenshots');
const DEV_VARS = join(ROOT, '.dev.vars');
const PLACEHOLDER_TOKEN = 'placeholder-for-screenshots';
const DEV_PORT = 5199;
const DEBUG_PORT = 9333;
const START_TIMEOUT_MS = 60_000;
const SETTLE_MS = 1500;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
];

// Phone shots show what the screen shows; `fullPage` captures the whole scrolled page.
const PHONE = { width: 390, height: 844, scale: 2, mobile: true };
const DESKTOP = { width: 1280, height: 800, scale: 1, mobile: false };
const SHOTS = [
  { name: 'phone-light', ...PHONE, scheme: 'light', fullPage: false },
  { name: 'phone-dark', ...PHONE, scheme: 'dark', fullPage: false },
  { name: 'phone-light-full', ...PHONE, scheme: 'light', fullPage: true },
  { name: 'desktop-light', ...DESKTOP, scheme: 'light', fullPage: true },
  { name: 'desktop-dark', ...DESKTOP, scheme: 'dark', fullPage: true },
] as const;

const chromePath = CHROME_CANDIDATES.find((path) => path && existsSync(path));
if (!chromePath) throw new Error('Chrome not found. Set CHROME_PATH.');
if (existsSync(DEV_VARS)) {
  throw new Error(
    'A .dev.vars exists. Move it away first: this script writes its own and deletes it.',
  );
}

const origin = `http://localhost:${DEV_PORT}`;
const children: ChildProcess[] = [];
const profileDir = mkdtempSync(join(tmpdir(), 'stackhush-shots-'));

const CHILD_EXIT_TIMEOUT_MS = 3000;

let wroteDevVars = false;
let cleanedUp = false;
let cleaning: Promise<void> | null = null;

/** Signals each child's process group (detached): vite under npx, Chrome's helper processes. */
function signalChildren(signal: NodeJS.Signals): void {
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(CHILD_EXIT_TIMEOUT_MS),
  ]);
}

function removeProfile(): void {
  rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/**
 * Removes the placeholder tokens, stops the dev server and Chrome, waits until they are gone and
 * only then removes Chrome's profile (a Chrome that is still running would write it again).
 * Every caller gets the same run.
 */
function cleanUp(): Promise<void> {
  cleaning ??= (async () => {
    // The placeholder tokens go first, so nothing below can leave them behind.
    if (wroteDevVars) rmSync(DEV_VARS, { force: true });
    signalChildren('SIGTERM');
    await Promise.all(children.map(waitForExit));
    if (children.some((child) => !hasExited(child))) {
      signalChildren('SIGKILL');
      await Promise.all(children.map(waitForExit));
    }
    removeProfile();
    cleanedUp = true;
  })();
  return cleaning;
}

// Fallback for an uncaught error, which ends the process without waiting for anything: the same
// steps, without the wait.
process.on('exit', () => {
  if (cleanedUp) return;
  if (wroteDevVars) rmSync(DEV_VARS, { force: true });
  signalChildren('SIGKILL');
  removeProfile();
});

// A signal would end the process without any cleanup, so each one cleans up first and then exits
// with the usual 128 + signal number.
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const) {
  process.on(signal, () => {
    void cleanUp().finally(() => process.exit(code));
  });
}

/** Every token the config can use, set to a placeholder, so every source counts as set. */
function placeholderDevVars(): string {
  const names = [
    ...config.githubOwners.map((owner) => githubTokenSecretName(owner.key)),
    'SUPABASE_TOKEN',
    'CF_TOKEN',
  ];
  return names.map((name) => `${name}=${PLACEHOLDER_TOKEN}\n`).join('');
}

async function waitFor(url: string, what: string): Promise<Response> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Not up yet.
    }
    await sleep(300);
  }
  throw new Error(`${what} did not start within ${START_TIMEOUT_MS / 1000} s.`);
}

/** Sends DevTools commands over one page's WebSocket and matches replies by id. */
class Page {
  private nextId = 1;
  private readonly waiting = new Map<number, (result: unknown) => void>();

  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown };
      if (message.id === undefined) return;
      this.waiting.get(message.id)?.(message.result);
      this.waiting.delete(message.id);
    });
  }

  static async open(url: string): Promise<Page> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new Page(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.waiting.set(id, resolve));
  }

  close(): void {
    this.socket.close();
  }
}

/** Capture options for the whole page, beyond the viewport. */
async function fullPageClip(page: Page, width: number): Promise<Record<string, unknown>> {
  const metrics = (await page.send('Page.getLayoutMetrics')) as {
    cssContentSize: { height: number };
  };
  return {
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: Math.ceil(metrics.cssContentSize.height), scale: 1 },
  };
}

try {
  mkdirSync(OUT_DIR, { recursive: true });
  // 'wx' fails if the file appeared since the check above, so an existing one is never replaced.
  writeFileSync(DEV_VARS, placeholderDevVars(), { flag: 'wx' });
  wroteDevVars = true;

  const dev = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: true,
  });
  children.push(dev);
  await waitFor(origin, 'The dev server');

  const output = execFileSync('node', ['scripts/signin-link.ts', '--local', '--url', origin], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const link = output.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error('No sign-in link in the output.');

  children.push(
    spawn(
      chromePath,
      [
        '--headless=new',
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: 'ignore', detached: true },
    ),
  );
  const targets = await (
    await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/list`, 'Chrome')
  ).json();
  const pageTarget = (targets as { type: string; webSocketDebuggerUrl: string }[]).find(
    (target) => target.type === 'page',
  );
  if (!pageTarget) throw new Error('Chrome has no page.');
  const page = await Page.open(pageTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');

  // The page takes the code out of the address bar and signs in; it then shows the dashboard.
  await page.send('Page.navigate', { url: link });
  await sleep(SETTLE_MS * 2);

  for (const shot of SHOTS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: shot.width,
      height: shot.height,
      deviceScaleFactor: shot.scale,
      mobile: shot.mobile,
    });
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: shot.scheme }],
    });
    await page.send('Page.navigate', { url: origin });
    await sleep(SETTLE_MS);
    const { data } = (await page.send(
      'Page.captureScreenshot',
      shot.fullPage
        ? { format: 'png', ...(await fullPageClip(page, shot.width)) }
        : { format: 'png' },
    )) as { data: string };
    const file = join(OUT_DIR, `${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`Wrote ${file}`);
  }
  page.close();
} finally {
  await cleanUp();
}
