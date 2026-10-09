// Sender rules and the Settings menu (the gear, top right) on desktop, phone and tablet.
//
// What is covered:
// - The Sender rules page (/rules): adding VIP, Always low and Private rules by address and by
//   domain, how patterns are cleaned up, validation, duplicates, Undo, Remove, reloads, the
//   no-JavaScript fallback, and rules made from an open email or the "Not sorted" tab.
// - Settings: opening / closing (click, Esc, outside click, focus back on the gear), Light / Dark /
//   Auto (data-theme, <meta name="theme-color">, <meta name="color-scheme">, the device setting),
//   every switch (aria-checked, the attribute on <html>, the knob, reloads, the keyboard), what
//   each one really does, the desktop sidebar rail, single-key shortcuts and Log out.
//
// Layouts (style.css §6 and §22, app.js "display preferences" and "sidebar"):
// - "Reading pane on the right" is only offered at >= 1280px (desktop); the phone and tablet hide it.
// - "Keyboard shortcuts" (and with it the "Single-key shortcuts" switch) is only offered with a
//   mouse (hover: hover); the phone and tablet hide it.
// - The Main menu button collapses the desktop sidebar to an icon rail (data-rail, remembered);
//   below 1024px it opens the sidebar as a drawer instead.
//
// Accessibility gaps found while writing these (CSS is used only where there is no accessible name):
// - The Settings gear is a <summary>: Playwright sees no button role for it, so it is found by its
//   aria-label (getByLabel('Settings')). The menu it opens has no role or name: `#more-menu`.
// - The rule groups on the Rules page are plain <div>s, not named sections: a group is found as the
//   `.rule-group` that holds its heading. Their count chips ("0", "1") have no label either.
// - The "Sort whole senders at once" block on the Not sorted tab is not a named region.
import type { Locator, Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test, expect, snackbar, PASSWORD, expectOnlyForScreenReaders } from './fixtures';

// The demo mailbox (e2e/server.py), sorted into tabs by app/ai/scoring.quadrant().
const CONTRACT = 'Contract renewal needs your signature today'; // Do now, priya@acme.example
const PAYMENT = 'Payment failed for velocity.example'; // Do now, next after the contract

const VIP = 'Always important (VIP)';
const LOW = 'Always low priority';
const PRIVATE = 'Private — never send to AI';
const BAD_PATTERN = 'Enter a sender address (boss@company.com) or a domain (@company.com)';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "Rule saved: …" then what it did with the sender's waiting mail (sorted now, at the next sync, or none). */
const saved = (kind: string, pattern: string) =>
  new RegExp(`Rule saved: ${escapeRe(kind)} for ${escapeRe(pattern)}\\. (Sorted \\d+ waiting emails?\\.|\\d+ waiting emails? (is|are) sorted at the next sync\\.|It applies to their new mail from now on\\.)`);

const isTouch = () => !!test.info().project.use.hasTouch;

/** A finger tap on touch devices, a mouse click on the desktop. */
async function press(target: Locator, position?: { x: number; y: number }) {
  if (isTouch()) await target.tap({ position });
  else await target.click({ position });
}

// --- Settings helpers -----------------------------------------------------------------------

/** The gear: a <summary> (no button role for Playwright), found by its aria-label. */
const gear = (page: Page) => page.getByLabel('Settings', { exact: true });
/** The Quick settings menu: no role or name of its own. */
const menu = (page: Page) => page.locator('#more-menu');
const settingSwitch = (page: Page, name: string) => menu(page).getByRole('switch', { name, exact: true });
const themeRadio = (page: Page, name: 'Auto' | 'Light' | 'Dark') =>
  menu(page).getByRole('group', { name: 'Theme' }).getByRole('radio', { name, exact: true });
const html = (page: Page) => page.locator('html');

async function openSettings(page: Page) {
  await press(gear(page));
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByText('Quick settings')).toBeVisible();
}

async function closeSettings(page: Page) {
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden();
}

/** Turn a switch in Settings on or off (opens the menu if needed) and check it took. */
async function setSwitch(page: Page, name: string, on: boolean) {
  if (!(await menu(page).isVisible())) await openSettings(page);
  const s = settingSwitch(page, name);
  if ((await s.getAttribute('aria-checked')) !== String(on)) await press(s);
  await expect(s).toHaveAttribute('aria-checked', String(on));
}

/** Every switch in the menu: what it puts on <html> when on, and when off. */
type SwitchSpec = { name: string; attr: string; whenOn: string | null; whenOff: string | null; byDefault: boolean };
const SWITCHES: SwitchSpec[] = [
  { name: 'Compact rows', attr: 'data-density', whenOn: 'compact', whenOff: null, byDefault: false },
  { name: 'Reading pane on the right', attr: 'data-split', whenOn: 'on', whenOff: null, byDefault: false },
  { name: 'Open next email after an action', attr: 'data-advance', whenOn: null, whenOff: 'off', byDefault: true },
  { name: 'Solid surfaces', attr: 'data-glass', whenOn: 'off', whenOff: null, byDefault: false },
];
/** The reading pane switch needs a window >= 1280px wide, so only the desktop offers it. */
const switchesOn = (isDesktop: boolean) => SWITCHES.filter((s) => isDesktop || s.name !== 'Reading pane on the right');

async function expectHtmlAttr(page: Page, attr: string, value: string | null) {
  if (value === null) await expect(html(page)).not.toHaveAttribute(attr);
  else await expect(html(page)).toHaveAttribute(attr, value);
}

/** The switch's knob slides right when it is on (style.css: .switch[aria-checked=true] .knob::after). */
async function expectKnob(s: Locator, on: boolean) {
  await expect.poll(() => s.locator('.knob').evaluate((k) => getComputedStyle(k, '::after').transform),
    { message: `the knob is drawn ${on ? 'on' : 'off'}` }).toBe(on ? 'matrix(1, 0, 0, 1, 16, 0)' : 'none');
}

/** <meta name="theme-color"> (light, dark) and <meta name="color-scheme">. */
async function expectBrowserColors(page: Page, themeColors: [string, string], colorScheme: string) {
  const metas = page.locator('meta[name="theme-color"]');
  await expect(metas.nth(0)).toHaveAttribute('content', themeColors[0]);
  await expect(metas.nth(1)).toHaveAttribute('content', themeColors[1]);
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute('content', colorScheme);
}
const LIGHT_BG = 'rgb(232, 235, 230)'; // --bg #e8ebe6
const DARK_BG = 'rgb(14, 15, 12)'; // --bg #0e0f0c
const pageBackground = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

// --- Rules page helpers ---------------------------------------------------------------------

const patternField = (page: Page) => page.getByRole('textbox', { name: 'Sender or domain' });
const kindRadio = (page: Page, kind: string) =>
  page.getByRole('group', { name: 'Rule' }).getByRole('radio', { name: kind, exact: true });
const addButton = (page: Page) => page.getByRole('button', { name: 'Add rule' });
/** One kind's group on the Rules page (a plain <div>: see the top). */
const ruleGroup = (page: Page, kind: string) =>
  page.locator('.rule-group').filter({ has: page.getByRole('heading', { level: 2, name: kind, exact: true }) });
const ruleItem = (page: Page, kind: string, pattern: string) =>
  ruleGroup(page, kind).getByRole('listitem').filter({ has: page.getByText(pattern, { exact: true }) });
const removeButton = (page: Page, pattern: string) =>
  page.getByRole('button', { name: `Remove rule ${pattern}`, exact: true });

async function addRule(page: Page, kind: string, pattern: string) {
  await press(kindRadio(page, kind));
  await expect(kindRadio(page, kind)).toBeChecked();
  await patternField(page).fill(pattern);
  await press(addButton(page));
}

/** The patterns listed under one kind, in order. */
const patternsIn = (page: Page, kind: string) => ruleGroup(page, kind).locator('.pattern');

// --- Inbox / email helpers ------------------------------------------------------------------

const list = (page: Page, tab = 'Do now') => page.getByRole('region', { name: tab, exact: true });
const rowLink = (page: Page, subject: string, tab = 'Do now') =>
  list(page, tab).getByRole('article').filter({ hasText: subject }).getByRole('link');
const pane = (page: Page) => page.getByRole('complementary', { name: 'Selected email' });
const subjectOf = (page: Page) => pane(page).getByRole('heading', { level: 2 });
const moveButton = (page: Page, label: string) =>
  pane(page).getByRole('region', { name: 'AI summary and priority' })
    .getByRole('group', { name: 'Move to' }).getByRole('button', { name: new RegExp(`^${label}`) });
const mailboxes = (page: Page) => page.getByRole('navigation', { name: 'Mailboxes' });
const mainMenu = (page: Page) => page.getByRole('button', { name: 'Main menu' });

async function openEmail(page: Page, subject: string, tab = 'Do now') {
  await press(rowLink(page, subject, tab));
  await expect(subjectOf(page)).toHaveText(subject);
}

// =============================================================================================
// Sender rules page
// =============================================================================================

test.describe('Sender rules page', () => {
  test('the gear menu leads to Sender rules, which starts with three empty groups', async ({ page, isPhone }) => {
    await page.goto('/');
    await openSettings(page);
    await press(menu(page).getByRole('link', { name: 'Sender rules' }));
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sender rules' })).toBeVisible();
    await expect(menu(page)).toBeHidden(); // choosing a menu item closes the menu
    for (const kind of [VIP, LOW, PRIVATE]) {
      await expect(ruleGroup(page, kind)).toContainText('None yet.');
      await expect(ruleGroup(page, kind).getByRole('listitem')).toHaveCount(0);
    }
    // VIP is preselected (DESIGN.md §13 "Sensible defaults")
    await expect(kindRadio(page, VIP)).toBeChecked();
    // where you are is marked, in the menu and in the sidebar
    await openSettings(page);
    await expect(menu(page).getByRole('link', { name: 'Sender rules' })).toHaveAttribute('aria-current', 'page');
    await closeSettings(page);
    if (isPhone) await press(mainMenu(page)); // on a phone the sidebar is a drawer
    await expect(mailboxes(page).getByRole('link', { name: /Sender rules/ })).toHaveAttribute('aria-current', 'page');
  });

  test('a VIP rule by address is saved in lower case and shows how many emails it matches', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, VIP, '  Priya@ACME.example ');
    await expect(snackbar(page)).toContainText(saved(VIP, 'priya@acme.example'));
    await expect(snackbar(page).getByRole('button', { name: 'Undo' })).toBeVisible();
    const item = ruleItem(page, VIP, 'priya@acme.example');
    await expect(item).toContainText('1 email ·'); // "1 email", not "1 emails"
    await expect(item).toContainText(/added \d{4}-\d{2}-\d{2}/);
    await expect(ruleGroup(page, VIP).locator('.count-chip')).toHaveText('1');
    // the field is cleared and keeps the focus, ready for the next one
    await expect(patternField(page)).toHaveValue('');
    await expect(patternField(page)).toBeFocused();
  });

  test('a bare domain becomes an @domain rule (Always low priority, added with Enter)', async ({ page }) => {
    await page.goto('/rules');
    await press(kindRadio(page, LOW));
    await patternField(page).fill('Medium.Example');
    await patternField(page).press('Enter');
    await expect(snackbar(page)).toContainText(saved(LOW, '@medium.example'));
    await expect(ruleItem(page, LOW, '@medium.example')).toContainText('1 email ·');
    await expect(ruleGroup(page, VIP).getByRole('listitem')).toHaveCount(0);
  });

  test('a Private rule for a whole domain counts every email from it', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, PRIVATE, '@acme.example'); // Priya (contract) and Dev (Q4 plan)
    await expect(snackbar(page)).toContainText(saved(PRIVATE, '@acme.example'));
    await expect(ruleItem(page, PRIVATE, '@acme.example')).toContainText('2 emails ·');
    await expect(ruleGroup(page, PRIVATE).locator('.count-chip')).toHaveText('1');
  });

  test('rules of every kind are listed in their own group and survive a reload', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, VIP, 'boss@acme.example');
    await expect(snackbar(page)).toContainText('Rule saved');
    await addRule(page, VIP, '@client.example');
    await expect(snackbar(page)).toContainText(saved(VIP, '@client.example'));
    await addRule(page, LOW, 'noreply@medium.example');
    await expect(snackbar(page)).toContainText(saved(LOW, 'noreply@medium.example'));
    await addRule(page, PRIVATE, '@bank.example');
    await expect(snackbar(page)).toContainText(saved(PRIVATE, '@bank.example'));

    const expected = { [VIP]: ['@client.example', 'boss@acme.example'], [LOW]: ['noreply@medium.example'],
      [PRIVATE]: ['@bank.example'] };
    for (const [kind, patterns] of Object.entries(expected)) await expect(patternsIn(page, kind)).toHaveText(patterns);
    await page.reload();
    for (const [kind, patterns] of Object.entries(expected)) await expect(patternsIn(page, kind)).toHaveText(patterns);
  });

  test('an empty pattern is stopped by the browser and nothing is saved', async ({ page }) => {
    await page.goto('/rules');
    let posted = false;
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/rules')) posted = true; });
    await press(addButton(page));
    expect(await patternField(page).evaluate((i: HTMLInputElement) => i.validity.valueMissing)).toBe(true);
    await expect(patternField(page)).toBeFocused(); // the browser points at the empty field
    await expect(snackbar(page)).toHaveCount(0);
    expect(posted, 'no rule was sent to the server').toBe(false);
    await page.reload();
    for (const kind of [VIP, LOW, PRIVATE]) await expect(ruleGroup(page, kind).getByRole('listitem')).toHaveCount(0);
  });

  for (const bad of ['not an email', '   ', 'boss@', '@nodot', 'a@b@c.com']) {
    test(`"${bad}" is refused with an error, keeps what was typed and marks the field invalid`, async ({ page, allowErrors }) => {
      allowErrors.push(/status of 400/); // the server answers 400 Bad Request on purpose
      await page.goto('/rules');
      await press(kindRadio(page, LOW));
      await patternField(page).fill(bad);
      await press(addButton(page));
      await expect(snackbar(page)).toContainText(BAD_PATTERN);
      await expect(snackbar(page)).toHaveAttribute('role', 'alert');
      await expect(patternField(page)).toHaveValue(bad);
      await expect(patternField(page)).toHaveAttribute('aria-invalid', 'true');
      await expect(patternField(page)).toBeFocused();
      await expect(kindRadio(page, LOW)).toBeChecked();
      // typing again clears the invalid mark
      await patternField(page).press('End');
      await patternField(page).pressSequentially('x');
      await expect(patternField(page)).not.toHaveAttribute('aria-invalid');
      await page.reload();
      for (const kind of [VIP, LOW, PRIVATE]) await expect(ruleGroup(page, kind).getByRole('listitem')).toHaveCount(0);
    });
  }

  test('adding the same rule twice keeps one and offers no Undo the second time', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, LOW, 'alerts@bank.example');
    await expect(snackbar(page).getByRole('button', { name: 'Undo' })).toBeVisible();
    await addRule(page, LOW, 'ALERTS@bank.example');
    await expect(snackbar(page)).toContainText(saved(LOW, 'alerts@bank.example'));
    await expect(snackbar(page).getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(patternsIn(page, LOW)).toHaveText(['alerts@bank.example']);
  });

  test('Undo right after adding a rule takes it away again', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, VIP, 'mum@family.example');
    await expect(ruleItem(page, VIP, 'mum@family.example')).toBeVisible();
    await press(snackbar(page).getByRole('button', { name: 'Undo' }));
    await expect(snackbar(page)).toContainText('Undone');
    await expect(ruleGroup(page, VIP).getByRole('listitem')).toHaveCount(0);
    await expect(ruleGroup(page, VIP)).toContainText('None yet.');
    await page.reload();
    await expect(ruleGroup(page, VIP).getByRole('listitem')).toHaveCount(0);
  });

  test('Remove deletes a rule (also after a reload), and Undo brings it back', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, VIP, 'priya@acme.example');
    await expect(snackbar(page)).toContainText('Rule saved');
    await addRule(page, VIP, '@client.example');
    await expect(patternsIn(page, VIP)).toHaveText(['@client.example', 'priya@acme.example']);

    await press(removeButton(page, 'priya@acme.example'));
    await expect(snackbar(page)).toContainText('Rule removed');
    await expect(patternsIn(page, VIP)).toHaveText(['@client.example']);
    await press(snackbar(page).getByRole('button', { name: 'Undo' }));
    await expect(snackbar(page)).toContainText('Undone');
    await expect(patternsIn(page, VIP)).toHaveText(['@client.example', 'priya@acme.example']);

    await press(removeButton(page, '@client.example'));
    await expect(snackbar(page)).toContainText('Rule removed');
    await page.reload();
    await expect(patternsIn(page, VIP)).toHaveText(['priya@acme.example']);
  });

  // Was a bug, now fixed: removing a rule with the keyboard drops focus to <body> (the Remove button is re-rendered away)
  test('removing a rule with the keyboard keeps the focus on the Rules page', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, LOW, '@medium.example');
    await expect(snackbar(page)).toContainText('Rule saved');
    await addRule(page, LOW, '@figma.example');
    await expect(patternsIn(page, LOW)).toHaveText(['@figma.example', '@medium.example']);
    await removeButton(page, '@figma.example').focus();
    await page.keyboard.press('Enter');
    await expect(snackbar(page)).toContainText('Rule removed');
    await expect(patternsIn(page, LOW)).toHaveText(['@medium.example']);
    // a keyboard or screen reader user carries on from the list, not from the top of the document
    await expect.poll(() => page.evaluate(() => {
      const a = document.activeElement;
      return !!a && a !== document.body && !!a.closest('main, #flash');
    }), { message: 'focus stays in the page (e.g. the next Remove button), not on <body>' }).toBe(true);
  });

  // Was a bug, now fixed: after adding a rule the page re-renders and the rule type jumps back to VIP
  test('the rule type you picked stays picked for the next rule', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, LOW, '@medium.example');
    await expect(snackbar(page)).toContainText(saved(LOW, '@medium.example'));
    // the next newsletter, typed straight away: it must not silently become a VIP
    await expect(kindRadio(page, LOW)).toBeChecked();
    await patternField(page).fill('@figma.example');
    await patternField(page).press('Enter');
    await expect(snackbar(page)).toContainText('@figma.example');
    await expect(patternsIn(page, LOW)).toHaveText(['@figma.example', '@medium.example']);
    await expect(ruleGroup(page, VIP).getByRole('listitem')).toHaveCount(0);
  });

  test('a very long address wraps instead of making the page scroll sideways', async ({ page }) => {
    await page.goto('/rules');
    const long = 'someone.with.a.really.long.mailbox.name.for.testing@a-very-long-subdomain.of.a-company.example';
    await addRule(page, PRIVATE, long);
    await expect(ruleItem(page, PRIVATE, long)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(0);
    const width = page.viewportSize()!.width;
    for (const el of [ruleItem(page, PRIVATE, long), removeButton(page, long)]) {
      const box = (await el.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
    }
  });

  // Was a bug, now fixed: on a phone the Compose button covers the last rule's Remove button, even scrolled to the very bottom
  test('scrolled to the bottom, the last Remove button is not hidden under the Compose button', async ({ page }) => {
    await page.goto('/rules');
    await addRule(page, PRIVATE, '@bank.example');
    await expect(snackbar(page)).toContainText('Rule saved');
    await page.reload(); // no snackbar in the way
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const remove = removeButton(page, '@bank.example');
    await expect(remove).toBeInViewport({ ratio: 1 });
    const fab = page.locator('a.fab'); // the phone's floating Compose button (hidden on wider screens)
    if (await fab.isVisible()) {
      await expect.poll(async () => {
        const a = (await remove.boundingBox())!;
        const b = (await fab.boundingBox())!;
        const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        return w > 0 && h > 0 ? Math.round(w * h) : 0;
      }, { message: 'px² of the Remove button under the Compose button' }).toBe(0);
    }
    await press(remove);
    await expect(snackbar(page)).toContainText('Rule removed');
  });

  test('the Inbox link at the top goes back to the inbox', async ({ page }) => {
    await page.goto('/rules');
    await press(page.getByRole('main').getByRole('link', { name: 'Inbox' }));
    await expect(page).toHaveURL(/\/$/);
    await expect(list(page).getByRole('article').filter({ hasText: CONTRACT })).toBeVisible();
  });
});

test.describe('Sender rules page without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('a refused rule keeps what was typed and explains the problem under the field', async ({ page }) => {
    await page.goto('/rules');
    await page.getByRole('radio', { name: LOW, exact: true }).check();
    await patternField(page).fill('not an email');
    await addButton(page).click();
    await expect(page).toHaveURL(/\/rules\?pattern=not\+an\+email&kind=low$/);
    const error = page.getByRole('main').getByRole('alert');
    await expect(error).toHaveText(BAD_PATTERN);
    await expect(patternField(page)).toHaveValue('not an email');
    await expect(patternField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(patternField(page)).toHaveAccessibleDescription(BAD_PATTERN);
    await expect(page.getByRole('radio', { name: LOW, exact: true })).toBeChecked();
  });

  test('a rule can be added and removed with plain form posts', async ({ page }) => {
    await page.goto('/rules');
    await page.getByRole('radio', { name: PRIVATE, exact: true }).check();
    await patternField(page).fill('bank.example');
    await addButton(page).click();
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole('status')).toContainText(saved(PRIVATE, '@bank.example'));
    await expect(ruleItem(page, PRIVATE, '@bank.example')).toContainText('1 email ·');
    await press(page.getByRole('link', { name: 'Dismiss' })); // the flash stays until dismissed without JS
    await expect(page.getByRole('status')).toHaveCount(0);
    await page.waitForLoadState('load'); // Dismiss is a link: the page loads again
    // scrolled up into the middle of the screen, as a person would, clear of the floating Compose button
    await removeButton(page, '@bank.example').evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await removeButton(page, '@bank.example').click({ timeout: 10_000 });
    await expect(page.getByRole('status')).toContainText('Rule removed');
    await expect(ruleGroup(page, PRIVATE).getByRole('listitem')).toHaveCount(0);
  });
});

test.describe('Rules made elsewhere show on the Rules page', () => {
  test('"Rules for this sender" on an open email: the rule shows on the email and on the Rules page', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const p = pane(page);
    await press(p.getByText('Rules for this sender', { exact: true }));
    const applyTo = p.getByLabel('Apply to');
    await expect(applyTo).toBeVisible();
    await applyTo.selectOption('@acme.example');
    await press(p.getByRole('button', { name: VIP, exact: true }));
    await expect(snackbar(page)).toContainText(saved(VIP, '@acme.example'));
    await expect(p.getByRole('list', { name: 'Active rules' }).getByRole('listitem'))
      .toHaveText([`${VIP} · @acme.example`]);

    // back to the list, then Settings › Sender rules (on a phone the email covers the header)
    await press(p.getByRole('link', { name: 'Back to the list' }));
    await expect(pane(page)).toBeHidden();
    await openSettings(page);
    await press(menu(page).getByRole('link', { name: 'Sender rules' }));
    await expect(page).toHaveURL(/\/rules$/);
    await expect(ruleItem(page, VIP, '@acme.example')).toContainText('2 emails ·');

    // removed here, it is gone from the email too
    await press(removeButton(page, '@acme.example'));
    await expect(snackbar(page)).toContainText('Rule removed');
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await expect(pane(page).getByRole('list', { name: 'Active rules' })).toHaveCount(0);
  });

  test('a single-sender Private rule from an open email lists that address', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const p = pane(page);
    await press(p.getByText('Rules for this sender', { exact: true }));
    await expect(p.getByLabel('Apply to')).toHaveValue('priya@acme.example'); // "This sender" is the default
    await press(p.getByRole('button', { name: PRIVATE, exact: true }));
    await expect(snackbar(page)).toContainText(saved(PRIVATE, 'priya@acme.example'));
    await page.goto('/rules');
    await expect(patternsIn(page, PRIVATE)).toHaveText(['priya@acme.example']);
    await expect(ruleItem(page, PRIVATE, 'priya@acme.example')).toContainText('1 email ·');
  });

});

test.describe('Rules made from the Not sorted tab', () => {
  // the demo mailbox has one email per sender; "Sort whole senders at once" needs several
  test.use({ mailbox: 'big' });

  test('"Sort whole senders at once" makes a rule that shows on the Rules page', async ({ page }) => {
    await page.goto('/?tab=unsorted');
    await expect(page.getByRole('heading', { name: /Sort whole senders at once/ })).toBeVisible();
    const sender = page.locator('.senders').getByRole('listitem').first(); // the block has no name
    const email = (await sender.locator('.addr').textContent())!.trim();
    expect(email).toMatch(/^s\d+@corp\d+\.example$/);
    await press(sender.getByRole('button', { name: 'Important', exact: true }));
    await expect(snackbar(page)).toContainText(saved(VIP, email));
    await page.goto('/rules');
    await expect(patternsIn(page, VIP)).toHaveText([email]);
    await expect(ruleItem(page, VIP, email)).toContainText(/\d+ emails ·/);
  });
});

// =============================================================================================
// Settings menu
// =============================================================================================

test.describe('Settings menu', () => {
  test('the gear opens Quick settings with the controls this device supports', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    await expect(gear(page)).toBeVisible();
    await expect(menu(page)).toBeHidden();
    await openSettings(page);
    await expect(menu(page).getByRole('group', { name: 'Theme' }).getByRole('radio')).toHaveCount(3);
    for (const s of SWITCHES) {
      const shown = !(isPhone || isTablet) || s.name !== 'Reading pane on the right';
      if (shown) await expect(settingSwitch(page, s.name)).toBeVisible();
      else await expect(settingSwitch(page, s.name)).toBeHidden(); // the side-by-side pane needs >= 1280px
    }
    await expect(menu(page).getByRole('link', { name: 'Sender rules' })).toBeVisible();
    const keys = menu(page).getByRole('button', { name: /Keyboard shortcuts/ });
    if (isPhone || isTablet) await expect(keys).toBeHidden(); // single-key shortcuts need a keyboard and mouse
    else await expect(keys).toBeVisible();
  });

  test('the menu fits on the screen', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await expect(menu(page)).toBeInViewport({ ratio: 1 });
    const vp = page.viewportSize()!;
    const box = (await menu(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  });

  test('on touch screens every control in Settings is at least 44px tall', async ({ page }) => {
    test.skip(!isTouch(), 'the 44px minimum is for fingers (pointer: coarse); the desktop uses a mouse');
    await page.goto('/');
    const g = (await gear(page).boundingBox())!;
    expect(g.height, 'the gear').toBeGreaterThanOrEqual(44);
    expect(g.width, 'the gear').toBeGreaterThanOrEqual(44);
    await openSettings(page);
    const targets = [
      ...['Auto', 'Light', 'Dark'].map((n) => ({ n, l: themeRadio(page, n as 'Auto').locator('xpath=..') })),
      ...switchesOn(false).map((s) => ({ n: s.name, l: settingSwitch(page, s.name) })),
      { n: 'Sender rules', l: menu(page).getByRole('link', { name: 'Sender rules' }) },
    ];
    for (const { n, l } of targets) {
      const b = (await l.boundingBox())!;
      expect(b.height, n).toBeGreaterThanOrEqual(44);
    }
  });

  test('a click or tap outside closes the menu', async ({ page }) => {
    await page.goto('/rules');
    await openSettings(page);
    // the page title's left edge: nothing to click there, and clear of the menu on every screen
    await press(page.getByRole('heading', { level: 1, name: 'Sender rules' }), { x: 4, y: 4 });
    await expect(menu(page)).toBeHidden();
    await expect(page).toHaveURL(/\/rules$/); // the outside tap only closed the menu
  });

  test('the gear closes the menu again', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await press(gear(page));
    await expect(menu(page)).toBeHidden();
    await expect(html(page).locator('details.more-wrap')).not.toHaveAttribute('open');
  });

  test('Esc closes the menu and puts the focus back on the gear', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await settingSwitch(page, 'Compact rows').focus();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(gear(page)).toBeFocused();
    // a second Esc does nothing surprising
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/$/);
  });

  test('the menu works from the keyboard: Enter opens, Tab reaches the theme and the switches', async ({ page }) => {
    await page.goto('/');
    await gear(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(themeRadio(page, 'Auto')).toBeFocused();
    await page.keyboard.press('ArrowRight'); // radio group: arrows pick the next theme
    await expect(themeRadio(page, 'Light')).toBeChecked();
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await page.keyboard.press('Tab');
    await expect(settingSwitch(page, 'Compact rows')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(settingSwitch(page, 'Compact rows')).toHaveAttribute('aria-checked', 'true');
    await expect(menu(page)).toBeVisible(); // a switch keeps the menu open
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(gear(page)).toBeFocused();
  });

  test('choosing Sender rules closes the menu on the way', async ({ page }) => {
    await page.goto('/?view=all');
    await openSettings(page);
    await press(menu(page).getByRole('link', { name: 'Sender rules' }));
    await expect(page.getByRole('heading', { level: 1, name: 'Sender rules' })).toBeVisible();
    await expect(menu(page)).toBeHidden();
  });
});

// =============================================================================================
// Theme
// =============================================================================================

test.describe('Theme: Light / Dark / Auto', () => {
  test('Auto is chosen at first and follows the device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await openSettings(page);
    await expect(themeRadio(page, 'Auto')).toBeChecked();
    await expect(html(page)).not.toHaveAttribute('data-theme');
    await expectBrowserColors(page, ['#e8ebe6', '#0e0f0c'], 'light dark');
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
  });

  test('Dark sets data-theme and the browser colours, and survives a reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await openSettings(page);
    await press(themeRadio(page, 'Dark'));
    await expect(themeRadio(page, 'Dark')).toBeChecked();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expectBrowserColors(page, ['#0e0f0c', '#0e0f0c'], 'dark');
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await expect(menu(page)).toBeVisible(); // picking a theme keeps the menu open

    await page.reload();
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expectBrowserColors(page, ['#0e0f0c', '#0e0f0c'], 'dark');
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await openSettings(page);
    await expect(themeRadio(page, 'Dark')).toBeChecked();
    // a light device setting doesn't override the choice
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
  });

  test('Light stays light on a dark device, and survives a reload and other pages', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await openSettings(page);
    await press(themeRadio(page, 'Light'));
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await expectBrowserColors(page, ['#e8ebe6', '#e8ebe6'], 'light');
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
    await page.goto('/rules');
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await expectBrowserColors(page, ['#e8ebe6', '#e8ebe6'], 'light');
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
  });

  test('back to Auto: the attribute and browser colours return to the device setting', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await openSettings(page);
    await press(themeRadio(page, 'Light'));
    await expect(html(page)).toHaveAttribute('data-theme', 'light');
    await press(themeRadio(page, 'Auto'));
    await expect(themeRadio(page, 'Auto')).toBeChecked();
    await expect(html(page)).not.toHaveAttribute('data-theme');
    await expectBrowserColors(page, ['#e8ebe6', '#0e0f0c'], 'light dark');
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await page.reload();
    await expect(html(page)).not.toHaveAttribute('data-theme');
    await expect.poll(() => pageBackground(page)).toBe(DARK_BG);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => pageBackground(page)).toBe(LIGHT_BG);
    await openSettings(page);
    await expect(themeRadio(page, 'Auto')).toBeChecked();
  });
});

// =============================================================================================
// Switches
// =============================================================================================

test.describe('Switches', () => {
  test('every switch shows its state in aria-checked, the knob and on <html>, and keeps it after a reload', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    const all = switchesOn(!(isPhone || isTablet));
    await openSettings(page);
    for (const s of all) {
      await expect(settingSwitch(page, s.name), `${s.name} by default`).toHaveAttribute('aria-checked', String(s.byDefault));
      await expectKnob(settingSwitch(page, s.name), s.byDefault);
      await expectHtmlAttr(page, s.attr, s.byDefault ? s.whenOn : s.whenOff);
    }
    // flip them all
    for (const s of all) {
      await press(settingSwitch(page, s.name));
      await expect(settingSwitch(page, s.name)).toHaveAttribute('aria-checked', String(!s.byDefault));
      await expectKnob(settingSwitch(page, s.name), !s.byDefault);
      await expectHtmlAttr(page, s.attr, !s.byDefault ? s.whenOn : s.whenOff);
      await expect(menu(page), 'a switch keeps the menu open').toBeVisible();
    }
    await page.reload();
    for (const s of all) await expectHtmlAttr(page, s.attr, !s.byDefault ? s.whenOn : s.whenOff);
    await openSettings(page);
    for (const s of all) {
      await expect(settingSwitch(page, s.name), `${s.name} after a reload`).toHaveAttribute('aria-checked', String(!s.byDefault));
      await expectKnob(settingSwitch(page, s.name), !s.byDefault);
    }
    // and back
    for (const s of all) await press(settingSwitch(page, s.name));
    await page.reload();
    for (const s of all) await expectHtmlAttr(page, s.attr, s.byDefault ? s.whenOn : s.whenOff);
  });

  test('every switch works with Space and Enter', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    await openSettings(page);
    for (const s of switchesOn(!(isPhone || isTablet))) {
      const sw = settingSwitch(page, s.name);
      await sw.focus();
      await page.keyboard.press('Space');
      await expect(sw, `${s.name}: Space`).toHaveAttribute('aria-checked', String(!s.byDefault));
      await expectHtmlAttr(page, s.attr, !s.byDefault ? s.whenOn : s.whenOff);
      await page.keyboard.press('Enter');
      await expect(sw, `${s.name}: Enter`).toHaveAttribute('aria-checked', String(s.byDefault));
      await expectHtmlAttr(page, s.attr, s.byDefault ? s.whenOn : s.whenOff);
      await expect(sw).toBeFocused();
    }
    await expect(menu(page)).toBeVisible();
  });
});

test.describe('Compact rows', () => {
  test('compact rows make the list denser, also after a reload', async ({ page }) => {
    await page.goto('/?view=all');
    const firstRow = page.getByRole('article').first().getByRole('link');
    const before = (await firstRow.boundingBox())!.height;
    await setSwitch(page, 'Compact rows', true);
    await expect(html(page)).toHaveAttribute('data-density', 'compact');
    await expect.poll(async () => (await firstRow.boundingBox())!.height).toBeLessThan(before);
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-density', 'compact');
    await expect.poll(async () => (await firstRow.boundingBox())!.height).toBeLessThan(before);
    await setSwitch(page, 'Compact rows', false);
    await expect(html(page)).not.toHaveAttribute('data-density');
    await expect.poll(async () => (await firstRow.boundingBox())!.height).toBe(before);
  });

  // Was a bug, now fixed: on a tablet, compact rows are 32px tall: `:root[data-density=compact] .row-link` beats the 44px touch minimum
  test('on touch screens compact rows are still at least 44px tall', async ({ page }) => {
    test.skip(!isTouch(), 'the 44px minimum is for fingers (pointer: coarse); the desktop uses a mouse');
    await page.goto('/?view=all');
    await setSwitch(page, 'Compact rows', true);
    await closeSettings(page);
    const rows = page.getByRole('article');
    await expect(rows).toHaveCount(10);
    for (const h of await rows.evaluateAll((els) => els.map((e) => e.querySelector('a')!.getBoundingClientRect().height))) {
      expect(h, 'row height with compact rows on a touch screen').toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('Open next email after an action', () => {
  test('on (the default): moving an open email opens the next one', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await expect(settingSwitch(page, 'Open next email after an action')).toHaveAttribute('aria-checked', 'true');
    await closeSettings(page);
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Later'));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await expect(page).toHaveURL(/[?&]open=2\b/);
  });

  test('off: the moved email stays open, and the choice survives a reload', async ({ page }) => {
    await page.goto('/');
    await setSwitch(page, 'Open next email after an action', false);
    await expect(html(page)).toHaveAttribute('data-advance', 'off');
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-advance', 'off');
    await openSettings(page);
    await expect(settingSwitch(page, 'Open next email after an action')).toHaveAttribute('aria-checked', 'false');
    await closeSettings(page);

    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Later'));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(moveButton(page, 'Later')).toHaveAttribute('aria-pressed', 'true');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(page).toHaveURL(/[?&]open=1\b/);
    // it really moved
    await page.goto('/?tab=later');
    await expect(list(page, 'Later').getByRole('article').filter({ hasText: CONTRACT })).toBeVisible();
  });
});

test.describe('Solid surfaces', () => {
  test('turns the frosted glass of menus solid, also after a reload', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    const style = () => menu(page).evaluate((m) => ({ blur: getComputedStyle(m).backdropFilter, bg: getComputedStyle(m).backgroundColor }));
    expect((await style()).blur).toContain('blur');
    await setSwitch(page, 'Solid surfaces', true);
    await expect(html(page)).toHaveAttribute('data-glass', 'off');
    await expect.poll(async () => (await style()).blur).toBe('none');
    await expect.poll(async () => (await style()).bg).toMatch(/^rgb\(\d+, \d+, \d+\)$/); // fully opaque
    await page.reload();
    await openSettings(page);
    await expect(settingSwitch(page, 'Solid surfaces')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(async () => (await style()).blur).toBe('none');
  });
});

test.describe('Reading pane on the right', () => {
  test('desktop: list and email side by side, remembered; phone and tablet: not offered', async ({ page, isPhone, isTablet }) => {
    if (isPhone || isTablet) {
      await page.goto('/');
      await openSettings(page);
      await expect(settingSwitch(page, 'Reading pane on the right')).toBeHidden();
      await closeSettings(page);
      // even if it was turned on in a wide window, emails open the normal way here
      await page.evaluate(() => localStorage.setItem('pref:split', 'on'));
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-split', 'on');
      await openEmail(page, CONTRACT);
      const vp = page.viewportSize()!;
      if (isPhone) {
        // the email covers the whole screen
        await expect.poll(async () => Math.round((await pane(page).boundingBox())!.x), { message: 'slid all the way in' }).toBe(0);
        expect(Math.round((await pane(page).boundingBox())!.width)).toBe(vp.width);
        await expect(pane(page)).toBeInViewport({ ratio: 0.9 });
      } else {
        // the email takes the list's place
        await expect(list(page)).toBeHidden();
      }
      return;
    }
    await page.goto('/');
    await setSwitch(page, 'Reading pane on the right', true);
    await expect(html(page)).toHaveAttribute('data-split', 'on');
    await closeSettings(page);
    await openEmail(page, CONTRACT);
    await expect(list(page)).toBeVisible();
    const l = (await list(page).boundingBox())!;
    const p = (await pane(page).boundingBox())!;
    expect(p.x, 'the email is to the right of the list').toBeGreaterThanOrEqual(l.x + l.width - 1);
    await page.reload();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(list(page)).toBeVisible();
    await setSwitch(page, 'Reading pane on the right', false);
    await closeSettings(page);
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await expect(list(page)).toBeHidden(); // Gmail's default: the email replaces the list
  });
});

test.describe('Sidebar rail', () => {
  test('desktop: the Main menu button collapses the sidebar to icons and back, remembered', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    const label = mailboxes(page).getByText('All mail', { exact: true });
    if (isPhone || isTablet) {
      // below 1024px the button opens the sidebar as a drawer, with labels, and sets no rail
      await press(mainMenu(page));
      await expect(mainMenu(page)).toHaveAttribute('aria-expanded', 'true');
      await expect(label).toBeVisible();
      await expect(html(page)).not.toHaveAttribute('data-rail');
      expect(await page.evaluate(() => localStorage.getItem('pref:rail'))).toBeNull();
      return;
    }
    await expect(label).toBeVisible();
    await press(mainMenu(page));
    await expect(html(page)).toHaveAttribute('data-rail', 'on');
    await expectOnlyForScreenReaders(label);
    // the icons still work and still have names
    await expect(mailboxes(page).getByRole('link', { name: /All mail/ })).toBeVisible();
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-rail', 'on');
    await expectOnlyForScreenReaders(label);
    await press(mainMenu(page));
    await expect(html(page)).not.toHaveAttribute('data-rail');
    await expect(label).toBeVisible();
    await page.reload();
    await expect(label).toBeVisible();
  });

  // Was a bug, now fixed: on the desktop the Main menu button keeps aria-expanded="false" while the full sidebar is shown, and never changes it
  test('the Main menu button tells screen readers whether the sidebar is expanded', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    if (isPhone || isTablet) {
      await expect(mainMenu(page)).toHaveAttribute('aria-expanded', 'false');
      await press(mainMenu(page));
      await expect(mainMenu(page)).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(mainMenu(page)).toHaveAttribute('aria-expanded', 'false');
      return;
    }
    await expect(mailboxes(page).getByText('All mail', { exact: true })).toBeVisible();
    await expect(mainMenu(page), 'the full sidebar is showing').toHaveAttribute('aria-expanded', 'true');
    await press(mainMenu(page));
    await expect(html(page)).toHaveAttribute('data-rail', 'on');
    await expect(mainMenu(page), 'collapsed to the rail').toHaveAttribute('aria-expanded', 'false');
  });

  // Was a bug, now fixed: the remembered rail (data-rail=on) also hides every label in the drawer once the window is narrower than 1024px
  test('after collapsing to a rail on a wide screen, the drawer on a narrower one still shows labels', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone, 'a phone is never 1024px wide, so it cannot collapse the sidebar to a rail');
    // tablet: held landscape (1080 wide), then turned to portrait; desktop: a window made narrower
    if (isTablet) await page.setViewportSize({ width: 1080, height: 810 });
    await page.goto('/');
    await press(mainMenu(page));
    await expect(html(page)).toHaveAttribute('data-rail', 'on');
    await page.setViewportSize(isTablet ? { width: 810, height: 1080 } : { width: 900, height: 900 });
    await press(mainMenu(page));
    await expect(mainMenu(page)).toHaveAttribute('aria-expanded', 'true');
    const drawer = mailboxes(page);
    for (const name of ['Inbox', 'All mail', 'Priority matrix', 'Sent', 'Sender rules']) {
      await expect(drawer.getByText(name, { exact: true }), `"${name}" in the open drawer`).toBeVisible();
    }
  });
});

test.describe('Keyboard shortcuts switch', () => {
  test('turning single-key shortcuts off stops them, and the choice survives a reload', async ({ page, isPhone, isTablet }) => {
    if (isPhone || isTablet) {
      // touch screens don't offer the shortcut list, so there is nothing to switch here
      await page.goto('/');
      await openSettings(page);
      await expect(menu(page).getByRole('button', { name: /Keyboard shortcuts/ })).toBeHidden();
      await expect(page.getByRole('switch', { name: 'Single-key shortcuts' })).toBeHidden();
      return;
    }
    await page.goto('/');
    // on: g then r opens the Rules page
    await page.keyboard.press('g');
    await page.keyboard.press('r');
    await expect(page).toHaveURL(/\/rules$/);
    await page.goto('/');

    await openSettings(page);
    await press(menu(page).getByRole('button', { name: /Keyboard shortcuts/ }));
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(menu(page)).toBeHidden();
    const keysSwitch = sheet.getByRole('switch', { name: 'Single-key shortcuts' });
    await expect(keysSwitch).toHaveAttribute('aria-checked', 'true');
    await press(keysSwitch);
    await expect(keysSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(html(page)).toHaveAttribute('data-keys', 'off');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(gear(page)).toBeFocused(); // the sheet hands the focus back to where it came from

    const tryShortcuts = async () => {
      await page.locator('body').focus();
      await page.keyboard.press('c'); // compose
      await page.keyboard.press('/'); // search
      await page.keyboard.press('g');
      await page.keyboard.press('r'); // g r: Rules
      await page.keyboard.press('?'); // the shortcut list
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole('form', { name: 'New message' })).toHaveCount(0);
      await expect(page.getByRole('searchbox', { name: 'Search mail' })).not.toBeFocused();
      await expect(sheet).toBeHidden();
    };
    await tryShortcuts();
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-keys', 'off');
    await tryShortcuts();

    // and back on
    await openSettings(page);
    await press(menu(page).getByRole('button', { name: /Keyboard shortcuts/ }));
    await expect(keysSwitch).toHaveAttribute('aria-checked', 'false');
    await press(keysSwitch);
    await expect(html(page)).not.toHaveAttribute('data-keys');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await page.keyboard.press('c');
    await expect(page.getByRole('form', { name: 'New message' })).toBeVisible();
  });
});

// `loginRequired` is a worker option (test.use can't set it inside a describe), so this group
// starts its own copy of e2e/server.py with --login, the same way e2e/fixtures.ts does.
test.describe('Log out', () => {
  let proc: ChildProcess | null = null;
  let base = '';

  test.beforeAll(async () => {
    const root = join(__dirname, '..');
    const python = process.env.PYTHON
      || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const { port: p } = s.address() as { port: number }; s.close(() => resolve(p)); });
    });
    let out = '';
    proc = spawn(python, ['e2e/server.py', String(port), '--login'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout!.on('data', (d) => { out += d; });
    proc.stderr!.on('data', (d) => { out += d; });
    base = `http://127.0.0.1:${port}`;
    const until = Date.now() + 20_000;
    for (;;) {
      if (proc.exitCode !== null) throw new Error(`e2e/server.py --login stopped:\n${out}`);
      try { if ((await fetch(base + '/__test/sent')).ok) break; } catch { /* not up yet */ }
      if (Date.now() > until) throw new Error(`e2e/server.py --login didn't start:\n${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  test.afterAll(() => { proc?.kill(); });

  test('without a password there is nothing to log out of', async ({ page }) => {
    await page.goto('/');
    await openSettings(page);
    await expect(menu(page).getByRole('link', { name: 'Sender rules' })).toBeVisible();
    await expect(menu(page).getByRole('button', { name: 'Log out' })).toHaveCount(0);
  });

  test('Log out in Settings signs you out', async ({ page }) => {
    await page.goto(base + '/rules');
    await expect(page).toHaveURL(/\/login\?next=%2Frules$/);
    await page.getByLabel('Password').fill(PASSWORD);
    await press(page.getByRole('button', { name: 'Sign in' }));
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sender rules' })).toBeVisible();

    await openSettings(page);
    const logout = menu(page).getByRole('button', { name: 'Log out' });
    await expect(logout).toBeVisible();
    await press(logout);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    // signed out for real
    await page.goto(base + '/rules');
    await expect(page).toHaveURL(/\/login\?next=%2Frules$/);
  });

  // Was a bug, now fixed: Log out sends Clear-Site-Data: "storage", which wipes every saved Setting, not just the unsent drafts
  test('your Settings (theme, compact rows) are still there after logging out and in again', async ({ page }) => {
    await page.goto(base + '/login');
    await page.getByLabel('Password').fill(PASSWORD);
    await press(page.getByRole('button', { name: 'Sign in' }));
    await expect(page).toHaveURL(new RegExp(`^${base}/$`));
    await openSettings(page);
    await press(themeRadio(page, 'Dark'));
    await setSwitch(page, 'Compact rows', true);
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await press(menu(page).getByRole('button', { name: 'Log out' }));
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(html(page), 'the sign-in page in your theme').toHaveAttribute('data-theme', 'dark');
    await page.getByLabel('Password').fill(PASSWORD);
    await press(page.getByRole('button', { name: 'Sign in' }));
    await expect(page).toHaveURL(new RegExp(`^${base}/$`));
    await expect(html(page)).toHaveAttribute('data-theme', 'dark');
    await expect(html(page)).toHaveAttribute('data-density', 'compact');
  });
});
