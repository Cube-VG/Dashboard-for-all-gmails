import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');

export const PASSWORD = 'correct horse';

export type SentMail = {
  from: string; to: string; cc: string | null; rcpt: string[];
  subject: string; in_reply_to: string | null; body: string;
};

type Server = { url: string };

type WorkerFixtures = {
  /** Start the dashboard with a password (test.use({ loginRequired: true })). */
  loginRequired: boolean;
  server: Server;
};

type TestFixtures = {
  /** 'demo': 10 emails in 3 accounts. 'big': 1,500 emails, every tab has several pages. */
  mailbox: 'demo' | 'big';
  /** Console errors a test expects (e.g. a 422 it provokes on purpose). */
  allowErrors: RegExp[];
  /** What the fake mail server has been given so far, oldest first. */
  sentMail: () => Promise<SentMail[]>;
  isPhone: boolean;
  isTablet: boolean;
  _fresh: void;
  _noErrors: void;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

async function waitUntilUp(url: string, proc: ChildProcess, log: () => string) {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (proc.exitCode !== null) throw new Error(`e2e/server.py stopped:\n${log()}`);
    try {
      const r = await fetch(url + '__test/sent');
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`e2e/server.py didn't start in 20 s:\n${log()}`);
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  loginRequired: [false, { scope: 'worker', option: true }],

  server: [async ({ loginRequired }, use) => {
    const port = await freePort();
    let out = '';
    const proc = spawn(PYTHON, ['e2e/server.py', String(port), ...(loginRequired ? ['--login'] : [])],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => { out += d; });
    proc.stderr!.on('data', (d) => { out += d; });
    const url = `http://127.0.0.1:${port}/`;
    try {
      await waitUntilUp(url, proc, () => out);
      await use({ url });
    } finally {
      proc.kill();
    }
  }, { scope: 'worker', timeout: 30_000 }],

  baseURL: async ({ server }, use) => { await use(server.url); },

  mailbox: ['demo', { option: true }],

  _fresh: [async ({ server, mailbox }, use) => {
    const r = await fetch(`${server.url}__test/reset?data=${mailbox}`, { method: 'POST' });
    expect(r.ok, 'reset the test mailbox').toBe(true);
    await use();
  }, { auto: true }],

  allowErrors: async ({}, use) => { await use([]); },

  _noErrors: [async ({ page, allowErrors }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.on('response', (r) => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
    await use();
    const real = errors.filter((e) => !allowErrors.some((re) => re.test(e)));
    expect(real, 'no JavaScript errors or server errors').toEqual([]);
  }, { auto: true }],

  sentMail: async ({ server }, use) => {
    await use(async () => (await fetch(server.url + '__test/sent')).json());
  },

  isPhone: async ({}, use, info) => { await use(info.project.name === 'phone'); },
  isTablet: async ({}, use, info) => { await use(info.project.name === 'tablet'); },
});

export { expect };

/** A real finger swipe (touch events, as on a phone) from (x0, y0) to (x1, y1). */
export async function swipe(page: Page, x0: number, y0: number, x1: number, y1: number,
                            { ms = 180, steps = 12 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const at = (x: number, y: number) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x0, y0) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent',
      { type: 'touchMove', touchPoints: at(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps) });
    await page.waitForTimeout(ms / steps);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

/** The snackbar at the bottom ("Sending… Undo", "Moved to Later", …). */
export const snackbar = (page: Page) => page.locator('.flash:not(.leaving)');

/** Gone from the screen but still read out (the icon rail keeps its words for screen readers). */
export async function expectOnlyForScreenReaders(locator: Locator) {
  await expect.poll(() => locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1;
  }), { message: 'not visible on screen' }).toBe(true);
}
