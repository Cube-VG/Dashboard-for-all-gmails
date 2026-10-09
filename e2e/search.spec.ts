// Search, filters and the "Not sorted" tab, on a desktop, a phone and a tablet.
//
// How the app means these to work (app/web/main.py Filters, base.html #filters, app.js):
// - The search box is in the top bar on every screen size ("/" focuses it on a desktop).
//   Like Gmail, a search is one list of every match: from an Inbox tab it opens All mail
//   (?view=all&q=…); from the Priority matrix it stays in the matrix. A link that keeps a tab
//   and q (/?tab=later&q=…) searches only that tab.
// - Filters (Unread, account, category, "Not sorted yet") live in the address bar. Tabs, the
//   ‹ › arrows and the search box keep them (the form carries them as hidden inputs); the
//   sidebar's Inbox / All mail / Priority matrix start afresh. Esc in the search box, the ✕ on
//   the search chip and "Clear filters" take them off again.
// - Everything swaps in place (no page load), and Back / Forward walk through earlier lists.
// - "Not sorted" offers "Sort whole senders at once" for senders with 2+ unsorted emails.
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - A row's subject has no accessible name of its own (the row link reads sender, labels,
//   subject, summary and time as one), so subjects are read from `article .subject`.
// - "Sort whole senders at once" is a plain <div> with an <h3> (no <h2> before it on the page),
//   its count ("2") has no words around it, and every row's buttons are just "Important" and
//   "Low": a screen reader hears five identical pairs without the sender they are for.
// - The ✕ inside the search box is the browser's own clear button: it has no accessible name
//   and can only be reached with a pointer, so the test clicks it by position.
// - The "Categories" disclosure is a <summary> without a role Playwright can address; it is
//   found by its text, and its open state read from the <details>.
// - The filter chips' toolbar has no landmark or label, so "all the chips" is `.list-toolbar`.
// - Which sidebar view is current is only exposed as aria-current (no role option for it).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar } from './fixtures';

// The demo mailbox (e2e/server.py) in All mail order: highest priority first, answered last.
// Quadrants follow app/ai/scoring.py (importance and urgency >= 4 count as high).
const ALL = [
  'Contract renewal needs your signature today', 'Payment failed for velocity.example', 'Sunday lunch?',
  'Quick question about the invoice', 'Your OTP is 482913', 'Your weekly team digest', 'Top stories for you',
  'Trip photos', 'Receipt from Velocity Growth', 'Q4 planning doc — comments welcome',
];
const CONTRACT = 'Contract renewal needs your signature today';
const PAYMENT = 'Payment failed for velocity.example';
const Q4 = 'Q4 planning doc — comments welcome';
const DIGESTS = ['Your weekly team digest', 'Top stories for you'];
const UNSORTED = ['Trip photos', 'Receipt from Velocity Growth'];

// --- the 'big' mailbox, worked out independently of the web app ----------------------------
// Seeds the same 1,500 emails into a scratch database with e2e/server.py's own seed_big() and
// answers with plain SQL what a search and the sender suggestions should show.
type Sender = { email: string; name: string; n: number };
type Big = {
  search: Record<string, string[]>;
  searchUnread: Record<string, string[]>;
  senders: Sender[];
  sendersByAccount: Record<string, Sender[]>;
  unsorted: number;
  fromSender: Record<string, string[]>;
};
const ROOT = join(__dirname, '..');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');
const ORACLE = `
import importlib.util, json
spec = importlib.util.spec_from_file_location("e2e_seed_search", "e2e/server.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
from app import db
path = seed.WORK / "oracle-search.db"
seed.seed_big(path)
c = db.connect(path)
FROM = " FROM messages m JOIN accounts a ON a.id = m.account_id"
ORDER = (" ORDER BY m.answered_at IS NOT NULL, m.priority_score IS NULL, m.priority_score DESC,"
         " m.received_at DESC, m.id DESC")
FIELDS = ("subject", "from_email", "from_name", "snippet", "body_text")
def found(q, extra=""):
    match = "(" + " OR ".join("instr(lower(m.%s), lower(?)) > 0" % f for f in FIELDS) + ")"
    return [r[0] for r in c.execute("SELECT m.subject" + FROM + " WHERE " + match + extra + ORDER, [q] * len(FIELDS))]
def senders(extra="", args=()):
    rows = c.execute("SELECT lower(m.from_email) AS email, MAX(m.from_name) AS name, COUNT(*) AS n" + FROM
        + " WHERE (m.importance IS NULL OR m.urgency IS NULL) AND m.from_email != ''" + extra
        + " GROUP BY lower(m.from_email) HAVING COUNT(*) > 1 ORDER BY n DESC, email", args).fetchall()
    return [{"email": r["email"], "name": r["name"], "n": r["n"]} for r in rows]
everyone = senders()
out = {
    "search": {q: found(q) for q in ("number 12", "number 1")},
    "searchUnread": {q: found(q, " AND m.is_read = 0") for q in ("number 12", "number 1")},
    "senders": everyone,
    "sendersByAccount": {a.email: senders(" AND a.email = ?", (a.email,)) for a in seed.BIG_ACCOUNTS},
    "unsorted": c.execute("SELECT COUNT(*) FROM messages WHERE importance IS NULL OR urgency IS NULL").fetchone()[0],
    "fromSender": {s["email"]: [r[0] for r in c.execute("SELECT m.subject" + FROM + " WHERE lower(m.from_email) = ?" + ORDER, (s["email"],))]
                   for s in everyone[:6]},
}
print("ORACLE " + json.dumps(out))
`;
let bigCache: Big | null = null;
function big(): Big {
  if (!bigCache) {
    const text = execFileSync(PYTHON, ['-c', ORACLE], { cwd: ROOT, encoding: 'utf8' });
    const line = text.split('\n').find((l) => l.startsWith('ORACLE '));
    if (!line) throw new Error(`the big-mailbox oracle printed nothing usable:\n${text}`);
    bigCache = JSON.parse(line.slice('ORACLE '.length)) as Big;
  }
  return bigCache;
}

// --- helpers ------------------------------------------------------------------------------
const isDesktop = () => test.info().project.name === 'desktop';
const onPhone = () => test.info().project.name === 'phone';

/** A mouse click on the desktop, a finger tap on the phone and tablet. */
async function press(target: Locator) {
  if (isDesktop()) await target.click(); else await target.tap();
}
const searchBox = (page: Page) => page.getByRole('searchbox', { name: 'Search mail' });
const subjects = (page: Page) => page.locator('#board article .subject');
const rows = (page: Page) => page.locator('#board').getByRole('article');
const heading = (page: Page) => page.getByRole('heading', { level: 1 });
const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Inbox tabs' });
const tabLink = (page: Page, name: string) => tabBar(page).getByRole('link', { name: new RegExp(`^${name}\\b`) });
const unreadChip = (page: Page) => page.getByRole('link', { name: 'Unread', exact: true });
const clearFilters = (page: Page) => page.getByRole('link', { name: 'Clear filters' }).first();
const nothingMatches = (page: Page) => page.getByRole('heading', { name: /^Nothing matches/ });
const suggestions = (page: Page) => page.getByRole('list').filter({ has: page.getByRole('button', { name: 'Low', exact: true }) });
const suggestionsTitle = (page: Page) => page.getByRole('heading', { name: /^Sort whole senders at once/ });
/** The sidebar entry marked as the current page (the sidebar is a closed drawer on a phone). */
const currentView = (page: Page) => page.getByRole('navigation', { name: 'Mailboxes', includeHidden: true })
  .getByRole('link', { includeHidden: true }).and(page.locator('[aria-current="page"]'));
const footPager = (page: Page) => page.getByRole('navigation', { name: 'More emails' });
const rangeText = (page: Page) => footPager(page).getByText(/^\d+–\d+ of \d+$/);

/** Search the way a person would: click (or tap) the box in the top bar, type, press Enter.
 *  (The "/" shortcut has its own test: it doesn't reach the box, see "/ puts the cursor…".) */
async function search(page: Page, text: string) {
  const box = searchBox(page);
  await press(box);
  await expect(box).toBeFocused();
  await box.fill(text);
  await box.press('Enter');
}

/** The address bar holds exactly these filters (in any order). */
async function expectFilters(page: Page, want: Record<string, string>) {
  const sorted = (o: Record<string, string>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  await expect.poll(() => {
    const u = new URL(page.url());
    return u.pathname === '/' ? sorted(Object.fromEntries(u.searchParams)) : `not the inbox: ${u.pathname}`;
  }, { message: `the address bar holds ${JSON.stringify(want)}` }).toEqual(sorted(want));
}

async function markDocument(page: Page) {
  await page.evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
}
/** The page was changed in place: the document (and the marker set on it) is still the same. */
async function expectSameDocument(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker),
    'changed in place, without loading a new page').toBe(1);
}

/** The sidebar: always shown on a desktop; a drawer opened with the menu button below 1024px. */
async function sidebar(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Mailboxes' });
  if (isDesktop()) return nav;
  const menu = page.getByRole('button', { name: 'Main menu' });
  if ((await menu.getAttribute('aria-expanded')) !== 'true') {
    await menu.tap();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
  }
  return nav;
}
async function chooseInSidebar(page: Page, name: RegExp | string) {
  const nav = await sidebar(page);
  await press(nav.getByRole('link', typeof name === 'string' ? { name, exact: true } : { name }));
  if (!isDesktop()) await expect(page.getByRole('button', { name: 'Main menu' })).toHaveAttribute('aria-expanded', 'false');
}
async function chooseCategory(page: Page, name: string) {
  const nav = await sidebar(page);
  const link = nav.getByRole('link', { name, exact: true });
  if (!(await link.isVisible())) await press(nav.getByText('Categories', { exact: true }));
  await expect(link).toBeVisible();
  await press(link);
  if (!isDesktop()) await expect(page.getByRole('button', { name: 'Main menu' })).toHaveAttribute('aria-expanded', 'false');
}

/** Scroll to the very end of a long list (rows off screen only have an estimated height). */
async function scrollToEnd(page: Page) {
  await page.evaluate(async () => {
    let lastY = -1, lastH = -1, still = 0;
    for (let i = 0; i < 200 && still < 4; i++) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const y = window.scrollY, h = document.documentElement.scrollHeight;
      still = y === lastY && h === lastH ? still + 1 : 0;
      lastY = y;
      lastH = h;
    }
  });
}
/** Turn to the older / newer page with the arrows a user reaches first on this screen. */
async function turnPage(page: Page, dir: 'Older' | 'Newer') {
  if (onPhone()) await scrollToEnd(page); // a phone has the arrows only under the list
  await press(page.getByRole('link', { name: `${dir} emails` }).filter({ visible: true }).first());
}

/** No sideways scrolling, and each of these controls fits on the screen. */
async function expectFitsScreen(page: Page, controls: Locator) {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.scrollingElement!.scrollWidth, width: document.documentElement.clientWidth }));
  expect(scroll, 'the page does not scroll sideways').toBeLessThanOrEqual(width);
  for (const el of await controls.all()) {
    const box = (await el.boundingBox())!;
    expect(box.x, `${await el.textContent()} starts on screen`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${await el.textContent()} ends on screen`).toBeLessThanOrEqual(width + 0.5);
  }
}

// =============================================================================================
test.describe('Search finds mail', () => {
  test("a sender's name finds their mail, and the address bar holds the search", async ({ page }) => {
    await page.goto('/');
    await search(page, 'Priya');
    await expectFilters(page, { view: 'all', q: 'Priya' });
    await expect(subjects(page)).toHaveText([CONTRACT]);
    await expect(heading(page)).toHaveText('All mail, search “Priya”');
    await expect(page.getByRole('link', { name: 'Remove search Priya' })).toBeVisible();
    await expect(searchBox(page)).toHaveValue('Priya');
    // the address can be reloaded (or shared) and shows the same results
    await page.reload();
    await expect(subjects(page)).toHaveText([CONTRACT]);
    await expect(searchBox(page)).toHaveValue('Priya');
  });

  test('a word from the subject finds every email with it, and a sender name counts too', async ({ page }) => {
    await page.goto('/');
    await search(page, 'planning');
    await expectFilters(page, { view: 'all', q: 'planning' });
    await expect(subjects(page)).toHaveText([Q4]);
    // "digest" is in one subject and in the other sender's name (Medium Daily Digest)
    await search(page, 'digest');
    await expectFilters(page, { view: 'all', q: 'digest' });
    await expect(subjects(page)).toHaveText(DIGESTS);
    // wider screens say how many matched (a phone has no room for it over a short list)
    if (onPhone()) await expect(page.getByText(/^\d+–\d+ of \d+$/)).toBeHidden();
    else await expect(page.getByText('1–2 of 2', { exact: true })).toBeVisible();
  });

  test('an address or a whole domain finds the mail from it', async ({ page }) => {
    await page.goto('/');
    await search(page, 'acme.example');
    await expectFilters(page, { view: 'all', q: 'acme.example' });
    await expect(subjects(page)).toHaveText([CONTRACT, Q4]);
    await search(page, 'billing@hostinger.example');
    await expectFilters(page, { view: 'all', q: 'billing@hostinger.example' });
    await expect(subjects(page)).toHaveText([PAYMENT]);
  });

  test('upper or lower case makes no difference, and words in the email text are found', async ({ page }) => {
    await page.goto('/');
    await search(page, 'PRIYA');
    await expect(subjects(page)).toHaveText([CONTRACT]);
    // only in the text: "…within 48 hours" and "…the extra design hours?"
    await search(page, 'hours');
    await expectFilters(page, { view: 'all', q: 'hours' });
    await expect(subjects(page)).toHaveText([PAYMENT, 'Quick question about the invoice']);
    await search(page, '₹12,400');
    await expect(subjects(page)).toHaveText(['Receipt from Velocity Growth']);
  });

  test('a search with no results says so kindly and offers the way back', async ({ page }) => {
    await page.goto('/');
    await search(page, 'zebra crossing');
    await expectFilters(page, { view: 'all', q: 'zebra crossing' });
    await expect(nothingMatches(page)).toBeVisible();
    await expect(page.getByText('No emails match these filters. Remove one, or start over.')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await press(page.getByRole('link', { name: 'Clear filters' }).last());
    await expectFilters(page, { view: 'all' });
    await expect(subjects(page)).toHaveText(ALL);
    await expect(searchBox(page)).toHaveValue('');
  });
});

// =============================================================================================
test.describe('Search with special characters', () => {
  test('% and _ are plain characters, not wildcards that match everything', async ({ page }) => {
    await page.goto('/');
    for (const q of ['%', '_', '100%', 'a_b']) {
      await search(page, q);
      await expectFilters(page, { view: 'all', q });
      await expect(nothingMatches(page), `"${q}" matches no email`).toBeVisible();
      await expect(rows(page)).toHaveCount(0);
      await expect(page.getByRole('link', { name: `Remove search ${q}` })).toBeVisible();
    }
  });

  test('HTML typed into the search is shown as text and never runs', async ({ page }) => {
    let dialogs = 0;
    page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
    const q = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>"><b>bold</b>';
    await page.goto('/');
    await search(page, q);
    await expectFilters(page, { view: 'all', q });
    await expect(nothingMatches(page)).toBeVisible();
    await expect(heading(page)).toHaveText(`All mail, search “${q}”`);
    await expect(page.getByRole('link', { name: `Remove search ${q}` })).toContainText(q);
    await expect(searchBox(page)).toHaveValue(q);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned), 'no injected code ran').toBeUndefined();
    await expect(page.locator('#content img, #content b:text-is("bold")'), 'no injected elements').toHaveCount(0);
    // a reload of that address is just as safe
    await page.reload();
    await expect(nothingMatches(page)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(dialogs, 'no alert or confirm popped up').toBe(0);
  });

  test("quotes, apostrophes, backslashes and SQL are searched literally and break nothing", async ({ page }) => {
    await page.goto('/');
    // the apostrophe is in "We couldn't charge your card…"
    await search(page, "couldn't");
    await expectFilters(page, { view: 'all', q: "couldn't" });
    await expect(subjects(page)).toHaveText([PAYMENT]);
    for (const q of ['\\', "'; DROP TABLE messages; --", '%_\\%']) {
      await search(page, q);
      await expectFilters(page, { view: 'all', q });
      await expect(page.getByRole('link', { name: `Remove search ${q}` })).toBeVisible();
      await expect(nothingMatches(page)).toBeVisible();
      await expect(searchBox(page)).toHaveValue(q);
    }
    // double quotes: no error and nothing injected (whether they mean a phrase is up to the app)
    await search(page, '"lunch"');
    await expectFilters(page, { view: 'all', q: '"lunch"' });
    await expect(page.getByRole('link', { name: 'Remove search "lunch"' })).toBeVisible();
    await expect(nothingMatches(page).or(subjects(page).filter({ hasText: 'Sunday lunch?' }))).toBeVisible();
    await expect(searchBox(page)).toHaveValue('"lunch"');
    // the mailbox is untouched
    await press(clearFilters(page));
    await expectFilters(page, { view: 'all' });
    await expect(subjects(page)).toHaveText(ALL);
  });
});

// =============================================================================================
test.describe('What a search looks through', () => {
  test('searching from an inbox tab looks through all mail, sorted or not', async ({ page }) => {
    await page.goto('/?tab=quick');
    await expect(subjects(page)).toHaveText(['Quick question about the invoice', 'Your OTP is 482913']);
    // "velocity" is in an email in Do now and in one the AI has not sorted yet
    await search(page, 'velocity');
    await expectFilters(page, { view: 'all', q: 'velocity' });
    await expect(heading(page)).toHaveText('All mail, search “velocity”');
    await expect(subjects(page)).toHaveText([PAYMENT, 'Receipt from Velocity Growth']);
    await expect(rows(page).filter({ hasText: PAYMENT })).toContainText('Do now');
    await expect(rows(page).filter({ hasText: 'Receipt from Velocity Growth' })).toContainText('Not sorted');
    await expect(tabBar(page)).toHaveCount(0);
    await expect(currentView(page)).toHaveAttribute('href', '/?view=all');
    // every email has an address at .example: the search covers all ten
    await search(page, 'example');
    await expect(subjects(page)).toHaveText(ALL);
  });

  test('a search from the Priority matrix stays in the matrix', async ({ page }) => {
    await page.goto('/?view=matrix');
    await search(page, 'acme');
    await expectFilters(page, { view: 'matrix', q: 'acme' });
    await expect(heading(page)).toHaveText('Priority matrix, search “acme”');
    const col = (name: string) => page.getByRole('region', { name, exact: true });
    await expect(col('Do now').locator('article .subject')).toHaveText([CONTRACT]);
    await expect(col('Schedule').locator('article .subject')).toHaveText([Q4]);
    await expect(col('Quick reply').getByRole('article')).toHaveCount(0);
    await expect(col('Later').getByRole('article')).toHaveCount(0);
    await expect(currentView(page)).toHaveAttribute('href', '/?view=matrix');
  });

  test('a link that keeps a tab and a search narrows that tab, its counts and the other tabs', async ({ page }) => {
    await page.goto('/?tab=later&q=digest');
    await expect(heading(page)).toHaveText('Inbox: Later, search “digest”');
    await expect(tabLink(page, 'Later')).toHaveAttribute('aria-current', 'page');
    await expect(subjects(page)).toHaveText(DIGESTS);
    // the other tabs count only matching mail: no "2 new" badges any more
    for (const name of ['Do now', 'Schedule', 'Quick reply']) await expect(tabLink(page, name)).toHaveAccessibleName(name);
    await expect(tabLink(page, 'Not sorted')).toHaveCount(0);
    // a tab switch keeps the search
    await markDocument(page);
    await press(tabLink(page, 'Do now'));
    await expectFilters(page, { q: 'digest' });
    await expect(page.getByRole('heading', { name: 'Nothing matches here' })).toBeVisible();
    await expect(page.getByText('No emails in this tab match. Try another tab, or clear the filters.')).toBeVisible();
    await expectSameDocument(page);
    await press(page.getByRole('link', { name: 'Clear filters' }).last());
    await expectFilters(page, {});
    await expect(subjects(page)).toHaveText([CONTRACT, PAYMENT]);
  });
});

// =============================================================================================
test.describe('Search in place, Back and clearing', () => {
  test('the search box sits in the top bar, ready without opening a menu', async ({ page }) => {
    await page.goto('/?tab=quick');
    const box = searchBox(page);
    await expect(page.getByRole('banner').getByRole('search').getByRole('searchbox')).toHaveAccessibleName('Search mail');
    await expect(box).toBeInViewport();
    const top = (await page.getByRole('banner').boundingBox())!;
    const b = (await box.boundingBox())!;
    expect(b.y + b.height, 'inside the top bar').toBeLessThanOrEqual(top.y + top.height);
    if (!isDesktop()) await expect(page.getByRole('button', { name: 'Main menu' })).toHaveAttribute('aria-expanded', 'false');
    // the phone keyboard shows a Search key and doesn't capitalise or correct what you type
    await expect(box).toHaveAttribute('enterkeyhint', 'search');
    await expect(box).toHaveAttribute('autocapitalize', 'off');
    await expect(box).toHaveAttribute('spellcheck', 'false');
    await press(box);
    await expect(box).toBeFocused();
    await box.fill('lunch');
    await box.press('Enter');
    await expectFilters(page, { view: 'all', q: 'lunch' });
    await expect(subjects(page)).toHaveText(['Sunday lunch?']);
    await expect(box, 'the keyboard goes away after searching').not.toBeFocused();
  });

  // APP BUG: "/" focuses the form's first <input>, the hidden view=… field, so the search box never gets the cursor.
  test('"/" puts the cursor in the search box, with the old search selected', async ({ page }) => {
    test.skip(onPhone(), 'a phone has no hardware keyboard: there the box is tapped in the top bar (tested above)');
    await page.goto('/?view=all&q=digest');
    const box = searchBox(page);
    await expect(box).toHaveAttribute('aria-keyshortcuts', '/');
    await page.keyboard.press('/');
    await expect(box).toBeFocused();
    // the old search is selected, so typing replaces it
    expect(await box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, 6]);
    await page.keyboard.type('lunch');
    await expect(box).toHaveValue('lunch');
    await page.keyboard.press('Enter');
    await expectFilters(page, { view: 'all', q: 'lunch' });
    await expect(subjects(page)).toHaveText(['Sunday lunch?']);
  });

  test('searching swaps the list in place, and Back and Forward walk through earlier searches', async ({ page }) => {
    await page.goto('/?tab=quick');
    await markDocument(page);
    await search(page, 'digest');
    await expectFilters(page, { view: 'all', q: 'digest' });
    await expect(subjects(page)).toHaveText(DIGESTS);
    await search(page, 'acme');
    await expectFilters(page, { view: 'all', q: 'acme' });
    await expect(subjects(page)).toHaveText([CONTRACT, Q4]);
    await expectSameDocument(page);

    await page.goBack();
    await expectFilters(page, { view: 'all', q: 'digest' });
    await expect(subjects(page)).toHaveText(DIGESTS);
    await expect(searchBox(page)).toHaveValue('digest');
    await page.goBack();
    await expectFilters(page, { tab: 'quick' });
    await expect(tabLink(page, 'Quick reply')).toHaveAttribute('aria-current', 'page');
    await expect(subjects(page)).toHaveText(['Quick question about the invoice', 'Your OTP is 482913']);
    await expect(searchBox(page)).toHaveValue('');
    await page.goForward();
    await expectFilters(page, { view: 'all', q: 'digest' });
    await expect(subjects(page)).toHaveText(DIGESTS);
    await expect(searchBox(page)).toHaveValue('digest');
    await expectSameDocument(page);
  });

  test('an email opened from the results closes back to the same results', async ({ page, isPhone }) => {
    await page.goto('/');
    await search(page, 'digest');
    await expect(subjects(page)).toHaveText(DIGESTS);
    const pane = page.getByRole('complementary', { name: 'Selected email' });
    for (const how of ['close', 'back'] as const) {
      await press(rows(page).filter({ hasText: 'Your weekly team digest' }).getByRole('link').first());
      await expect(pane.getByRole('heading', { name: 'Your weekly team digest' })).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('digest');
      if (isPhone) { // the email opens full screen over the list
        const width = page.viewportSize()!.width;
        await expect.poll(async () => Math.round((await pane.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(width);
      }
      if (how === 'close') await press(pane.getByRole('link', { name: 'Back to the list' }));
      else await page.goBack();
      await expectFilters(page, { view: 'all', q: 'digest' });
      await expect(pane.getByRole('heading', { name: 'Your weekly team digest' })).toHaveCount(0);
      await expect(subjects(page)).toHaveText(DIGESTS);
      await expect(searchBox(page)).toHaveValue('digest');
    }
  });

  test('a new search while an email is open shows the new results', async ({ page, isPhone }) => {
    await page.goto('/?view=all');
    await press(rows(page).filter({ hasText: CONTRACT }).getByRole('link').first());
    const pane = page.getByRole('complementary', { name: 'Selected email' });
    await expect(pane.getByRole('heading', { name: CONTRACT })).toBeVisible();
    await markDocument(page);
    // a phone shows the email full screen (the top bar is covered): back to the list first
    if (isPhone) await press(pane.getByRole('link', { name: 'Back to the list' }));
    await search(page, 'lunch');
    await expectFilters(page, { view: 'all', q: 'lunch' });
    await expect(subjects(page)).toHaveText(['Sunday lunch?']);
    await expect(pane.getByRole('heading', { name: CONTRACT })).toHaveCount(0);
    await expectSameDocument(page);
  });

  test('searching from Sent or Sender rules opens the results in All mail', async ({ page }) => {
    for (const from of ['/sent', '/rules']) {
      await page.goto(from);
      await search(page, 'acme');
      await expectFilters(page, { view: 'all', q: 'acme' });
      await expect(heading(page)).toHaveText('All mail, search “acme”');
      await expect(subjects(page)).toHaveText([CONTRACT, Q4]);
    }
  });

  test('the ✕ on the search chip clears the search and brings every email back', async ({ page }) => {
    await page.goto('/');
    await search(page, 'digest');
    await expect(subjects(page)).toHaveText(DIGESTS);
    await markDocument(page);
    await press(page.getByRole('link', { name: 'Remove search digest' }));
    await expectFilters(page, { view: 'all' });
    await expect(subjects(page)).toHaveText(ALL);
    await expect(searchBox(page)).toHaveValue('');
    await expect(page.getByRole('link', { name: /^Remove search/ })).toHaveCount(0);
    await expectSameDocument(page);
  });

  test('Esc in the search box clears the search and its results', async ({ page }) => {
    await page.goto('/');
    await search(page, 'digest');
    await expect(subjects(page)).toHaveText(DIGESTS);
    await markDocument(page);
    const box = searchBox(page);
    await press(box);
    await expect(box).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(box).toHaveValue('');
    await expect(box).not.toBeFocused();
    await expectFilters(page, { view: 'all' });
    await expect(subjects(page)).toHaveText(ALL);
    await expectSameDocument(page);
    // Esc in an empty box changes nothing
    await press(box);
    await page.keyboard.press('Escape');
    await expectFilters(page, { view: 'all' });
    await expect(subjects(page)).toHaveText(ALL);
  });

  // APP BUG: the ✕ inside the search box only empties the field; the results stay filtered by the old search.
  test('the ✕ inside the search box clears the search, not just the text', async ({ page }) => {
    await page.goto('/');
    await search(page, 'digest');
    await expect(subjects(page)).toHaveText(DIGESTS);
    const box = searchBox(page);
    // on a touch screen the ✕ answers once the field is being edited (as on iOS)
    if (!isDesktop()) await box.tap();
    const b = (await box.boundingBox())!;
    const pad = await box.evaluate((el) => parseFloat(getComputedStyle(el).paddingRight));
    const x = b.x + b.width - pad - 9, y = b.y + b.height / 2; // the browser's clear button
    if (isDesktop()) await page.mouse.click(x, y); else await page.touchscreen.tap(x, y);
    await expect(box, 'the ✕ was hit: the field is empty').toHaveValue('');
    // like Esc and the chip's ✕: no search left behind, every email back
    await expectFilters(page, { view: 'all' });
    await expect(page.getByRole('link', { name: 'Remove search digest' })).toHaveCount(0);
    await expect(subjects(page)).toHaveText(ALL);
  });
});

// =============================================================================================
test.describe('Filters', () => {
  test('Unread shows only unread mail in every tab, and stays on across tabs and a reload', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);
    await press(unreadChip(page));
    await expectFilters(page, { unread: '1' });
    await expect(unreadChip(page)).toHaveAttribute('aria-current', 'true');
    await expect(subjects(page)).toHaveText([CONTRACT, PAYMENT]);
    await press(tabLink(page, 'Schedule'));
    await expectFilters(page, { tab: 'schedule', unread: '1' });
    await expect(subjects(page)).toHaveText(['Sunday lunch?']); // the Q4 doc was read already
    await press(tabLink(page, 'Later'));
    await expectFilters(page, { tab: 'later', unread: '1' });
    await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
    await expect(page.getByText(/^No unread mail in Later/)).toBeVisible();
    await expectSameDocument(page);
    await page.reload();
    await expect(unreadChip(page)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('heading', { name: 'All caught up' })).toBeVisible();
    await press(page.getByRole('link', { name: 'Show read mail' }));
    await expectFilters(page, { tab: 'later' });
    await expect(subjects(page)).toHaveText(DIGESTS);
    await expect(unreadChip(page)).not.toHaveAttribute('aria-current', 'true');
  });

  test('an account combines with a tab, Unread and a search, and Clear filters takes them all off', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);
    await chooseInSidebar(page, /^Personal\b/);
    await expectFilters(page, { account: 'sam@gmail.com' });
    await expect(page.getByRole('link', { name: 'Remove filter Personal' })).toBeVisible();
    // Personal has nothing in Do now, and one email the AI has not sorted yet
    await expect(page.getByText(/Nothing here yet — 1 still being sorted/)).toBeVisible();
    await press(tabLink(page, 'Quick reply'));
    await expectFilters(page, { tab: 'quick', account: 'sam@gmail.com' });
    await expect(subjects(page)).toHaveText(['Your OTP is 482913']); // not the invoice (Velocity)
    await press(unreadChip(page));
    await expectFilters(page, { tab: 'quick', account: 'sam@gmail.com', unread: '1' });
    await expect(subjects(page)).toHaveText(['Your OTP is 482913']);
    // the search box keeps both filters, even after these in-place changes
    await search(page, 'sunday');
    await expectFilters(page, { view: 'all', account: 'sam@gmail.com', unread: '1', q: 'sunday' });
    await expect(subjects(page)).toHaveText(['Sunday lunch?']);
    await expect(page.getByRole('link', { name: 'Remove filter Personal' })).toBeVisible();
    await expect(unreadChip(page)).toHaveAttribute('aria-current', 'true');
    await expectSameDocument(page);
    await press(clearFilters(page));
    await expectFilters(page, { view: 'all' });
    await expect(subjects(page)).toHaveText(ALL);
    await expect(page.getByRole('link', { name: /^Remove (filter|search)/ })).toHaveCount(0);
  });

  test("a search inside one account finds only that account's matches", async ({ page }) => {
    await page.goto('/?view=all');
    await chooseInSidebar(page, /^Work\b/);
    await expectFilters(page, { view: 'all', account: 'sam.work@gmail.com' });
    await search(page, 'digest');
    await expectFilters(page, { view: 'all', account: 'sam.work@gmail.com', q: 'digest' });
    await expect(subjects(page)).toHaveText(['Your weekly team digest']);
    // switching to another account keeps the search
    await chooseInSidebar(page, /^Personal\b/);
    await expectFilters(page, { view: 'all', account: 'sam@gmail.com', q: 'digest' });
    await expect(subjects(page)).toHaveText(['Top stories for you']);
    await press(page.getByRole('link', { name: 'Remove filter Personal' }));
    await expectFilters(page, { view: 'all', q: 'digest' });
    await expect(subjects(page)).toHaveText(DIGESTS);
  });

  test('a category from the sidebar narrows each tab and combines with a search', async ({ page }) => {
    await page.goto('/');
    await chooseCategory(page, 'client');
    await expectFilters(page, { category: 'client' });
    await expect(page.getByRole('link', { name: 'Remove filter client' })).toBeVisible();
    await expect(subjects(page)).toHaveText([CONTRACT]);
    await press(tabLink(page, 'Quick reply'));
    await expectFilters(page, { tab: 'quick', category: 'client' });
    await expect(subjects(page)).toHaveText(['Quick question about the invoice']);
    // "acme" alone finds the contract and the Q4 doc; the client category keeps only the contract
    await search(page, 'acme');
    await expectFilters(page, { view: 'all', category: 'client', q: 'acme' });
    await expect(subjects(page)).toHaveText([CONTRACT]);
    await press(page.getByRole('link', { name: 'Remove filter client' }));
    await expectFilters(page, { view: 'all', q: 'acme' });
    await expect(subjects(page)).toHaveText([CONTRACT, Q4]);
  });

  test('filters stay on through tab switches and a reload; the sidebar Inbox starts afresh', async ({ page }) => {
    await page.goto('/?account=sam.work%40gmail.com&unread=1');
    await expect(subjects(page)).toHaveText([CONTRACT]);
    await press(tabLink(page, 'Schedule'));
    await expectFilters(page, { tab: 'schedule', account: 'sam.work@gmail.com', unread: '1' });
    await expect(page.getByRole('heading', { name: 'Nothing matches here' })).toBeVisible(); // the Q4 doc is read
    await page.reload();
    await expectFilters(page, { tab: 'schedule', account: 'sam.work@gmail.com', unread: '1' });
    await expect(tabLink(page, 'Schedule')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('link', { name: 'Remove filter Work' })).toBeVisible();
    await expect(unreadChip(page)).toHaveAttribute('aria-current', 'true');
    await press(tabLink(page, 'Do now'));
    await expectFilters(page, { account: 'sam.work@gmail.com', unread: '1' });
    await expect(subjects(page)).toHaveText([CONTRACT]);
    // Clear filters keeps the tab you are on
    await press(tabLink(page, 'Schedule'));
    await press(clearFilters(page));
    await expectFilters(page, { tab: 'schedule' });
    await expect(subjects(page)).toHaveText(['Sunday lunch?', Q4]);
    // Inbox in the sidebar is the plain inbox again
    await press(unreadChip(page));
    await expectFilters(page, { tab: 'schedule', unread: '1' });
    await chooseInSidebar(page, /^Inbox\b/);
    await expectFilters(page, {});
    await expect(subjects(page)).toHaveText([CONTRACT, PAYMENT]);
    await expect(unreadChip(page)).not.toHaveAttribute('aria-current', 'true');
  });

  test('the Categories menu offers only categories that still have mail under the other filters', async ({ page }) => {
    const categories = async () => {
      const nav = await sidebar(page);
      const group = nav.locator('details[data-key="nav-categories"]'); // the disclosure has no role of its own
      if (!(await group.evaluate((d: HTMLDetailsElement) => d.open))) await press(nav.getByText('Categories', { exact: true }));
      const names = group.getByRole('link');
      await expect(names.first()).toBeVisible();
      const all = await names.allTextContents();
      if (!isDesktop()) await page.keyboard.press('Escape'); // put the drawer away again
      return all.map((t) => t.trim());
    };
    await page.goto('/');
    expect(await categories()).toEqual(['client', 'finance', 'newsletter', 'otp', 'personal', 'promo', 'work']);
    await page.goto('/?account=sam.work%40gmail.com');
    expect(await categories(), "only the Work account's categories").toEqual(['client', 'promo', 'work']);
    await page.goto('/?view=all&q=digest');
    expect(await categories(), 'only the categories of the two digests').toEqual(['newsletter', 'promo']);
  });

  test('"Not sorted yet" (sorted=no) lists only unsorted mail; searches keep it and its chip removes it', async ({ page }) => {
    await page.goto('/?view=all&sorted=no');
    await expect(subjects(page)).toHaveText(UNSORTED);
    await expect(page.getByRole('link', { name: 'Remove filter Not sorted yet' })).toBeVisible();
    await search(page, 'velocity');
    await expectFilters(page, { view: 'all', sorted: 'no', q: 'velocity' });
    await expect(subjects(page)).toHaveText(['Receipt from Velocity Growth']);
    await press(page.getByRole('link', { name: 'Remove filter Not sorted yet' }));
    await expectFilters(page, { view: 'all', q: 'velocity' });
    await expect(subjects(page)).toHaveText([PAYMENT, 'Receipt from Velocity Growth']);
  });

  test('many filters at once wrap neatly and nothing runs off the screen', async ({ page }) => {
    await page.goto('/?view=all&sorted=no&account=sam%40velocity.example&unread=1&category=finance&q=payment');
    const chips = page.locator('.list-toolbar').getByRole('link'); // the toolbar has no landmark of its own
    await expect(chips).toHaveText(['Unread', /Velocity/, '“payment”', /finance/, 'Not sorted yet', 'Clear filters']);
    await expectFitsScreen(page, chips);
    // a long pasted search wraps inside its chip, with its ✕ still on screen
    const long = 'quarterly-reconciliation-statement-for-velocity-growth-private-limited-2026';
    await page.goto(`/?view=all&q=${long}`);
    await expect(page.getByRole('link', { name: `Remove search ${long}` })).toBeVisible();
    await expectFitsScreen(page, page.locator('.list-toolbar').getByRole('link'));
  });

  // APP BUG: on touch screens the filter chips are 40px tall and "Clear filters" only 20px, under the 44px the design asks for.
  test('filter chips and Clear filters are at least 44px tall on a touch screen', async ({ page }) => {
    test.skip(isDesktop(), 'the 44px rule is for touch (coarse pointer); a mouse gets the compact 32px chips by design');
    await page.goto('/?view=all&account=sam%40gmail.com&q=top');
    await expect(subjects(page)).toHaveText(['Top stories for you']);
    const targets = [unreadChip(page), page.getByRole('link', { name: 'Remove filter Personal' }),
      page.getByRole('link', { name: 'Remove search top' }), clearFilters(page)];
    const short: string[] = [];
    for (const t of targets) {
      const box = (await t.boundingBox())!;
      if (box.height < 44) short.push(`${await t.getAttribute('aria-label') ?? (await t.textContent())!.trim()}: ${Math.round(box.height)}px`);
    }
    expect(short, 'every filter control is a 44px touch target').toEqual([]);
  });
});

// =============================================================================================
test.describe('Not sorted', () => {
  test('lists the mail the AI has not sorted yet; single emails get no sender suggestions', async ({ page }) => {
    await page.goto('/');
    await expect(tabLink(page, 'Not sorted')).toHaveAccessibleName('Not sorted 2 waiting');
    await press(tabLink(page, 'Not sorted'));
    await expectFilters(page, { tab: 'unsorted' });
    await expect(heading(page)).toHaveText('Inbox: Not sorted');
    await expect(page.getByRole('region', { name: 'Not sorted yet', exact: true }).locator('article .subject')).toHaveText(UNSORTED);
    // Rahul and Stripe each sent one email: there is no sender worth a rule yet
    await expect(suggestionsTitle(page)).toHaveCount(0);
    // a search from here looks through all mail, as everywhere
    await search(page, 'photos');
    await expectFilters(page, { view: 'all', q: 'photos' });
    await expect(subjects(page)).toHaveText(['Trip photos']);
  });

  test.describe('with a big mailbox', () => {
    test.use({ mailbox: 'big' });

    test('"Sort whole senders at once" lists the senders with the most unsorted mail', async ({ page }) => {
      const want = big().senders.slice(0, 5);
      expect(want.length, 'the big mailbox has senders to suggest').toBe(5);
      await page.goto('/?tab=unsorted');
      await expect(tabLink(page, 'Not sorted')).toHaveAccessibleName(`Not sorted ${big().unsorted} waiting`);
      await expect(suggestionsTitle(page)).toBeVisible();
      await expect(suggestionsTitle(page)).toContainText('a rule sorts their mail now and in future (Low skips the AI)');
      const items = suggestions(page).getByRole('listitem');
      await expect(items).toHaveCount(5);
      for (const [i, s] of want.entries()) {
        const item = items.nth(i);
        await expect(item).toContainText(`${s.name} ${s.email}`);
        await expect(item.getByText(String(s.n), { exact: true })).toBeVisible();
        await expect(item.getByRole('button', { name: 'Important', exact: true })).toHaveAttribute('title', 'Always important (VIP)');
        await expect(item.getByRole('button', { name: 'Low', exact: true })).toHaveAttribute('title', 'Always low priority');
      }
      // the list below still pages through every unsorted email
      await expect(rows(page)).toHaveCount(50);
      await expect(rangeText(page)).toHaveText(`1–50 of ${big().unsorted}`);
    });

    test('the suggestions follow the account filter', async ({ page }) => {
      await page.goto('/?tab=unsorted');
      await expect(suggestionsTitle(page)).toBeVisible();
      await chooseInSidebar(page, /^Personal\b/);
      await expectFilters(page, { tab: 'unsorted', account: 'a@gmail.com' });
      await expect(rows(page).first()).toBeVisible();
      const want = big().sendersByAccount['a@gmail.com'].slice(0, 5);
      if (want.length) {
        await expect(suggestions(page).getByRole('listitem')).toHaveCount(want.length);
        for (const [i, s] of want.entries()) await expect(suggestions(page).getByRole('listitem').nth(i)).toContainText(s.email);
      } else {
        // in this account no sender has two unsorted emails, so there is nothing to suggest
        await expect(suggestionsTitle(page)).toHaveCount(0);
      }
    });

    test('"Low" on a suggested sender saves a rule, says so, and the rule is on the Rules page', async ({ page }) => {
      const s = big().senders[0];
      await page.goto('/?tab=unsorted');
      const item = suggestions(page).getByRole('listitem').filter({ hasText: s.email });
      await press(item.getByRole('button', { name: 'Low', exact: true }));
      await expect(snackbar(page)).toContainText(
        `Rule saved: Always low priority for ${s.email}. Sorted ${s.n} waiting emails.`);
      await expect(snackbar(page).getByRole('button', { name: 'Undo' })).toBeVisible();
      await page.goto('/rules');
      const rule = page.getByRole('listitem').filter({ hasText: s.email });
      await expect(rule).toHaveCount(1);
      await expect(rule).toContainText(`${s.n} emails`);
      await expect(rule.getByRole('button', { name: `Remove rule ${s.email}` })).toBeVisible();
    });

    test('Undo right after "Important" takes the new rule back', async ({ page }) => {
      const s = big().senders[1];
      await page.goto('/?tab=unsorted');
      const item = suggestions(page).getByRole('listitem').filter({ hasText: s.email });
      await press(item.getByRole('button', { name: 'Important', exact: true }));
      await expect(snackbar(page)).toContainText(`Rule saved: Always important (VIP) for ${s.email}.`);
      await press(snackbar(page).getByRole('button', { name: 'Undo' }));
      await expect(snackbar(page)).toHaveText(/^Undone/);
      await page.goto('/rules');
      await expect(page.getByRole('heading', { name: 'Always important (VIP)' })).toBeVisible();
      await expect(page.getByRole('listitem').filter({ hasText: s.email })).toHaveCount(0);
    });

    // APP BUG: a rule made from a suggestion sorts nothing: the sender's mail stays in Not sorted and the sender stays suggested.
    test('"Low" on a suggested sender sorts their waiting mail now, and they leave the suggestions', async ({ page }) => {
      const { senders, unsorted, fromSender } = big();
      const s = senders[0];
      await page.goto('/?tab=unsorted');
      await press(suggestions(page).getByRole('listitem').filter({ hasText: s.email }).getByRole('button', { name: 'Low', exact: true }));
      await expect(snackbar(page)).toContainText('Rule saved');
      // "a rule sorts their mail now … without the AI": their emails are no longer waiting
      await expect(suggestions(page)).not.toContainText(s.email);
      await expect(tabLink(page, 'Not sorted')).toHaveAccessibleName(`Not sorted ${unsorted - s.n} waiting`);
      await expect(suggestions(page).getByRole('listitem')).toHaveCount(5);
      await expect(suggestions(page).getByRole('listitem').last()).toContainText(senders[5].email);
      // and after a reload they are in Later
      await page.reload();
      await expect(suggestions(page)).not.toContainText(s.email);
      await page.goto(`/?view=all&q=${encodeURIComponent(s.email)}`);
      await expect(subjects(page)).toHaveText(fromSender[s.email]);
      for (const subject of fromSender[s.email]) {
        await expect(rows(page).filter({ hasText: subject })).toContainText('Later');
      }
    });

    // APP BUG: after "Important" the sender's row stays, still offering Important and Low (a second tap can add a contradicting rule).
    test('"Important" on a suggested sender takes them off the suggestions', async ({ page }) => {
      const s = big().senders[2];
      await page.goto('/?tab=unsorted');
      await press(suggestions(page).getByRole('listitem').filter({ hasText: s.email }).getByRole('button', { name: 'Important', exact: true }));
      await expect(snackbar(page)).toContainText(`Rule saved: Always important (VIP) for ${s.email}.`);
      await expect(suggestions(page)).not.toContainText(s.email);
      await page.reload();
      await expect(suggestions(page)).not.toContainText(s.email);
    });

    test('the suggestions fit the screen, with full-size buttons on touch', async ({ page }) => {
      await page.goto('/?tab=unsorted');
      const buttons = suggestions(page).getByRole('button');
      await expect(buttons).toHaveCount(10);
      await expectFitsScreen(page, buttons);
      if (!isDesktop()) {
        for (const b of await buttons.all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
    });
  });
});

// =============================================================================================
test.describe('Search results in a big mailbox', () => {
  test.use({ mailbox: 'big' });

  test('results come 50 at a time with the right range, and no email shows twice', async ({ page }) => {
    const q = 'number 12';
    const want = big().search[q];
    expect(want.length, '"number 12" is in 111 subjects').toBe(111);
    await page.goto('/');
    await markDocument(page);
    await search(page, q);
    await expectFilters(page, { view: 'all', q });
    await expect(rangeText(page)).toHaveText(`1–50 of ${want.length}`);
    if (!onPhone()) await expect(page.getByText(`1–50 of ${want.length}`).first()).toBeVisible();
    await expect(subjects(page)).toHaveText(want.slice(0, 50));
    const seen = [...await subjects(page).allTextContents()];

    await turnPage(page, 'Older');
    await expect(rangeText(page)).toHaveText(`51–100 of ${want.length}`);
    await expect(subjects(page)).toHaveText(want.slice(50, 100));
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe(q);
    seen.push(...await subjects(page).allTextContents());

    await turnPage(page, 'Older');
    await expect(rangeText(page)).toHaveText(`101–111 of ${want.length}`);
    await expect(subjects(page)).toHaveText(want.slice(100));
    seen.push(...await subjects(page).allTextContents());
    await expect(footPager(page).getByRole('link', { name: 'Older emails' }), 'no page after the last').toHaveCount(0);

    expect(seen).toEqual(want);
    expect(new Set(seen).size, 'no email twice').toBe(want.length);
    expect(seen.every((s) => s.includes(q))).toBe(true);
    await expectSameDocument(page);

    // back the way we came: the Newer arrow, then the browser's Back
    await turnPage(page, 'Newer');
    await expect(rangeText(page)).toHaveText(`51–100 of ${want.length}`);
    await expect(subjects(page)).toHaveText(want.slice(50, 100));
    await page.goBack();
    await expect(rangeText(page)).toHaveText(`101–111 of ${want.length}`);
    await page.goBack();
    await page.goBack();
    await expect(rangeText(page)).toHaveText(`1–50 of ${want.length}`);
    await expect(subjects(page)).toHaveText(want.slice(0, 50));
    await expect(searchBox(page)).toHaveValue(q);
  });

  test('Unread on a search pages through only unread matches', async ({ page }) => {
    const q = 'number 1';
    const want = big().searchUnread[q];
    expect(want.length).toBeGreaterThan(100);
    await page.goto('/');
    await search(page, q);
    await expectFilters(page, { view: 'all', q });
    await expect(rangeText(page)).toHaveText(`1–50 of ${big().search[q].length}`);
    await press(unreadChip(page));
    await expectFilters(page, { view: 'all', q, unread: '1' });
    await expect(rangeText(page)).toHaveText(`1–50 of ${want.length}`);
    await expect(subjects(page)).toHaveText(want.slice(0, 50));
    await expect(rows(page).filter({ hasText: 'Unread:' })).toHaveCount(50);
    await turnPage(page, 'Older');
    await expectFilters(page, { view: 'all', q, unread: '1', after: expect.any(String) as unknown as string });
    await expect(rangeText(page)).toHaveText(`51–100 of ${want.length}`);
    await expect(subjects(page)).toHaveText(want.slice(50, 100));
    await expect(rows(page).filter({ hasText: 'Unread:' })).toHaveCount(50);
  });
});
