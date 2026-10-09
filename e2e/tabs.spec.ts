// Inbox tabs, the sidebar views and Gmail's 50-per-page arrows, on a desktop, a phone and a tablet.
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - A row's subject has no accessible name of its own: the row link's name runs sender, labels,
//   subject, summary and time together, so subjects are read from `article .subject`.
// - The "1–50 of 159" range is plain text (no role), so it's found by its text.
// - A disabled ‹ / › arrow is an aria-hidden <span>: screen readers don't hear that there is
//   no newer / older page, they just don't find the link.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar, swipe } from './fixtures';

const TABS = { do: 'Do now', schedule: 'Schedule', quick: 'Quick reply', later: 'Later', unsorted: 'Not sorted' } as const;
type Tab = keyof typeof TABS;
const TAB_KEYS = Object.keys(TABS) as Tab[];

// The demo mailbox (e2e/server.py), per tab in list order: highest priority first, newest first,
// answered mail last. Quadrants follow app/ai/scoring.py (importance/urgency >= 4 is "high").
const DEMO: Record<Tab, string[]> = {
  do: ['Contract renewal needs your signature today', 'Payment failed for velocity.example'],
  schedule: ['Sunday lunch?', 'Q4 planning doc — comments welcome'],
  quick: ['Quick question about the invoice', 'Your OTP is 482913'],
  later: ['Your weekly team digest', 'Top stories for you'],
  unsorted: ['Trip photos', 'Receipt from Velocity Growth'],
};
// What each tab says about itself: unread count ("2 new"), else the total; Not sorted: "N waiting".
const DEMO_TAB_NAMES: Record<Tab, string> = {
  do: 'Do now 2 new', schedule: 'Schedule 1 new', quick: 'Quick reply 2 new', later: 'Later 2', unsorted: 'Not sorted 2 waiting',
};
// All mail order, and which account each email belongs to.
const DEMO_ALL = [
  'Contract renewal needs your signature today', 'Payment failed for velocity.example', 'Sunday lunch?',
  'Quick question about the invoice', 'Your OTP is 482913', 'Your weekly team digest', 'Top stories for you',
  'Trip photos', 'Receipt from Velocity Growth', 'Q4 planning doc — comments welcome',
];
const DEMO_ACCOUNTS = [
  { label: 'Personal', email: 'sam@gmail.com', unread: 3,
    subjects: ['Sunday lunch?', 'Your OTP is 482913', 'Top stories for you', 'Trip photos'] },
  { label: 'Velocity', email: 'sam@velocity.example', unread: 2,
    subjects: ['Payment failed for velocity.example', 'Quick question about the invoice', 'Receipt from Velocity Growth'] },
  { label: 'Work', email: 'sam.work@gmail.com', unread: 1,
    subjects: ['Contract renewal needs your signature today', 'Your weekly team digest', 'Q4 planning doc — comments welcome'] },
];

// --- the 'big' mailbox, worked out independently of the web app ----------------------------
// Seeds the same 1,500 emails into a scratch database with e2e/server.py's own seed_big() and
// sorts them into tabs with app/ai/scoring.quadrant(), so the pages can be checked email by email.
type Big = {
  all: string[];
  tabs: Record<Tab, { subjects: string[]; unread: number; unreadSubjects: string[] }>;
  accounts: Record<string, string[]>;
};
const ROOT = join(__dirname, '..');
const PYTHON = process.env.PYTHON
  || (existsSync(join(ROOT, '.venv/bin/python')) ? join(ROOT, '.venv/bin/python') : 'python3');
const ORACLE = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("e2e_seed", "e2e/server.py")
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)
from app import db
from app.ai.scoring import quadrant
path = seed.WORK / "oracle.db"
seed.seed_big(path)
c = db.connect(path)
rows = c.execute("""SELECT m.subject, m.importance, m.urgency, m.is_read, a.email AS account
    FROM messages m JOIN accounts a ON a.id = m.account_id
    ORDER BY m.answered_at IS NOT NULL, m.priority_score IS NULL, m.priority_score DESC,
             m.received_at DESC, m.id DESC""").fetchall()
tabs = {k: {"subjects": [], "unread": 0, "unreadSubjects": []} for k in ("do", "schedule", "quick", "later", "unsorted")}
accounts = {}
for r in rows:
    t = tabs[quadrant(r["importance"], r["urgency"]) or "unsorted"]
    t["subjects"].append(r["subject"])
    if not r["is_read"]:
        t["unread"] += 1
        t["unreadSubjects"].append(r["subject"])
    accounts.setdefault(r["account"], []).append(r["subject"])
c.close()
sys.stdout.write("ORACLE " + json.dumps({"all": [r["subject"] for r in rows], "tabs": tabs, "accounts": accounts}))
`;
let bigCache: Big | undefined;
function big(): Big {
  if (!bigCache) {
    const out = execFileSync(PYTHON, ['-c', ORACLE], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    bigCache = JSON.parse(out.slice(out.lastIndexOf('ORACLE ') + 7)) as Big;
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
const tabBar = (page: Page) => page.getByRole('navigation', { name: 'Inbox tabs' });
const tabLink = (page: Page, tab: Tab) => tabBar(page).getByRole('link', { name: new RegExp(`^${TABS[tab]}\\b`) });
const subjectsShown = (page: Page) => page.locator('#board article .subject');
const rows = (page: Page) => page.locator('#board').getByRole('article');
/** "1–50 of 159" (the top one on wide screens; the one under the list on a phone). */
const range = (page: Page) => page.getByText(/^\d+–\d+ of \d+$/).filter({ visible: true }).first();
const olderLink = (page: Page) => page.getByRole('link', { name: 'Older emails' }).filter({ visible: true }).first();
const newerLink = (page: Page) => page.getByRole('link', { name: 'Newer emails' }).filter({ visible: true }).first();
const footPager = (page: Page) => page.getByRole('navigation', { name: 'More emails' });
const pane = (page: Page) => page.getByRole('complementary', { name: 'Selected email' });

async function markDocument(page: Page) {
  await page.evaluate(() => { (window as unknown as { __marker: number }).__marker = 1; });
}
/** The page was changed in place: the document (and the marker set on it) is still the same. */
async function expectSameDocument(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker),
    'switched in place, without loading a new page').toBe(1);
}

/** The tab is open: chosen in the tab bar, named in the heading, and listing exactly `subjects`. */
async function expectTab(page: Page, tab: Tab, subjects: string[]) {
  await expect(tabLink(page, tab)).toHaveAttribute('aria-current', 'page');
  await expect(tabBar(page).locator('[aria-current]')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Inbox: ${TABS[tab]}`);
  await expect(subjectsShown(page)).toHaveText(subjects);
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
async function chooseInSidebar(page: Page, name: RegExp) {
  const nav = await sidebar(page);
  await press(nav.getByRole('link', { name }));
  if (!isDesktop()) await expect(page.getByRole('button', { name: 'Main menu' })).toHaveAttribute('aria-expanded', 'false');
}

/** Scroll to the very end of a long list. Rows off screen only have an estimated height until
 *  they're drawn, so keep going until the end stops moving for a few frames. */
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
/** The email row at the top of the screen (just under the top bar) and where it sits. */
function topRow(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.top')?.getBoundingClientRect().bottom ?? 0;
    const card = [...document.querySelectorAll<HTMLElement>('#board article')]
      .find((c) => c.getBoundingClientRect().bottom > bar + 1);
    return { y: Math.round(window.scrollY), id: card?.dataset.id ?? null,
             top: Math.round(card?.getBoundingClientRect().top ?? 0) };
  });
}
/** Turn to the older/newer page with the arrows a user would reach first on this screen. */
async function turnPage(page: Page, dir: 'older' | 'newer') {
  const link = dir === 'older' ? olderLink(page) : newerLink(page);
  if (onPhone()) await scrollToEnd(page); // a phone has the arrows only under the list
  await press(link);
}
async function expectPage(page: Page, first: number, last: number, total: number, subjects: string[]) {
  await expect(range(page)).toHaveText(`${first}–${last} of ${total}`);
  await expect(subjectsShown(page)).toHaveText(subjects);
}

// =============================================================================================
test.describe('Inbox tabs', () => {
  test('each tab lists exactly its own emails, highest priority first', async ({ page, isPhone }) => {
    await page.goto('/');
    await expectTab(page, 'do', DEMO.do);
    for (const tab of ['schedule', 'quick', 'later', 'unsorted', 'do'] as Tab[]) {
      await press(tabLink(page, tab));
      await expect(page).toHaveURL(tab === 'do' ? /\/$/ : new RegExp(`/\\?tab=${tab}$`));
      await expectTab(page, tab, DEMO[tab]);
      await expect(page.getByRole('region', { name: tab === 'unsorted' ? 'Not sorted yet' : TABS[tab], exact: true })
        .getByRole('article')).toHaveCount(DEMO[tab].length);
      // a phone has no room for the range over a one-page list; wider screens show it
      if (isPhone) await expect(page.getByText(/^\d+–\d+ of \d+$/)).toBeHidden();
      else await expect(range(page)).toHaveText(`1–${DEMO[tab].length} of ${DEMO[tab].length}`);
    }
  });

  test('each tab says how many emails wait in it', async ({ page, isPhone }) => {
    await page.goto('/');
    for (const tab of TAB_KEYS) {
      // phones show only the "new" badges: a tab with no unread mail (Later) is just its name, by design
      const name = isPhone && tab === 'later' ? 'Later' : DEMO_TAB_NAMES[tab];
      await expect(tabLink(page, tab)).toHaveAccessibleName(name);
    }
  });

  test('only the open tab is marked as the current page', async ({ page }) => {
    await page.goto('/');
    await expect(tabLink(page, 'do')).toHaveAttribute('aria-current', 'page');
    for (const tab of ['schedule', 'quick', 'later', 'unsorted'] as Tab[]) await expect(tabLink(page, tab)).not.toHaveAttribute('aria-current');
    await press(tabLink(page, 'quick'));
    await expect(tabLink(page, 'quick')).toHaveAttribute('aria-current', 'page');
    await expect(tabLink(page, 'do')).not.toHaveAttribute('aria-current');
    await expect(tabBar(page).locator('[aria-current]')).toHaveCount(1);
  });

  test('switching tabs swaps the list in place and updates the address', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);
    await press(tabLink(page, 'quick'));
    await expect(page).toHaveURL(/\/\?tab=quick$/);
    await expectTab(page, 'quick', DEMO.quick);
    await press(tabLink(page, 'unsorted'));
    await expect(page).toHaveURL(/\/\?tab=unsorted$/);
    await expectTab(page, 'unsorted', DEMO.unsorted);
    await press(tabLink(page, 'do'));
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/$/); // Do now is the plain inbox address
    await expectTab(page, 'do', DEMO.do);
    await expect(page).toHaveTitle('(2) Inbox · Unified Inbox');
    await expectSameDocument(page);
  });

  test('Back and Forward walk through the tabs you visited', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);
    for (const tab of ['schedule', 'later', 'unsorted'] as Tab[]) {
      await press(tabLink(page, tab));
      await expectTab(page, tab, DEMO[tab]);
    }
    await page.goBack();
    await expect(page).toHaveURL(/\?tab=later$/);
    await expectTab(page, 'later', DEMO.later);
    await page.goBack();
    await expect(page).toHaveURL(/\?tab=schedule$/);
    await expectTab(page, 'schedule', DEMO.schedule);
    await page.goForward();
    await expect(page).toHaveURL(/\?tab=later$/);
    await expectTab(page, 'later', DEMO.later);
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expectTab(page, 'do', DEMO.do);
    await expectSameDocument(page);
  });

  test('reloading keeps the open tab', async ({ page }) => {
    await page.goto('/');
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', DEMO.later);
    await page.reload();
    await expect(page).toHaveURL(/\?tab=later$/);
    await expectTab(page, 'later', DEMO.later);
  });

  test('a link to a tab opens that tab; an unknown tab falls back to Do now', async ({ page }) => {
    await page.goto('/?tab=quick');
    await expectTab(page, 'quick', DEMO.quick);
    await page.goto('/?tab=nonsense');
    await expectTab(page, 'do', DEMO.do);
  });

  test('Review in the "Sorting your mail" strip opens Not sorted', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);
    await press(page.getByRole('region', { name: 'Sorting your mail' }).getByRole('link', { name: 'Review' }));
    await expect(page).toHaveURL(/\?tab=unsorted$/);
    await expectTab(page, 'unsorted', DEMO.unsorted);
    await expectSameDocument(page);
  });

  // APP BUG: on a phone the tab strip jumps back to its start after every tab change or reload, so the chosen tab is off screen
  test('the chosen tab stays in view in the tab strip', async ({ page }) => {
    await page.goto('/');
    for (const tab of ['later', 'unsorted'] as Tab[]) {
      await press(tabLink(page, tab)); // a tap scrolls the strip to it first, like a finger would
      await expectTab(page, tab, DEMO[tab]);
      await expect(tabLink(page, tab), `${TABS[tab]} is still visible after choosing it`).toBeInViewport({ ratio: 0.9 });
    }
    await page.reload();
    await expect(tabLink(page, 'unsorted'), 'the chosen tab is visible after a reload').toBeInViewport({ ratio: 0.9 });
  });

  test('every tab can be reached: side by side on wide screens, a finger swipe away on a phone', async ({ page, isPhone }) => {
    await page.goto('/');
    if (!isPhone) {
      for (const tab of TAB_KEYS) await expect(tabLink(page, tab)).toBeInViewport({ ratio: 1 });
      return;
    }
    await expect(tabLink(page, 'unsorted'), 'the last tab starts off screen').not.toBeInViewport();
    const bar = await tabBar(page).boundingBox();
    const y = bar!.y + bar!.height / 2;
    await swipe(page, 360, y, 40, y, { ms: 300 });
    await swipe(page, 360, y, 40, y, { ms: 300 });
    await expect(tabLink(page, 'unsorted')).toBeInViewport({ ratio: 0.9 });
    await expect(page, 'a sideways swipe on the tabs is not a tap').toHaveURL(/\/$/);
    await press(tabLink(page, 'unsorted'));
    await expectTab(page, 'unsorted', DEMO.unsorted);
  });

  test('the page never scrolls sideways, even with all five tabs', async ({ page }) => {
    await page.goto('/?tab=unsorted');
    await expectTab(page, 'unsorted', DEMO.unsorted);
    const { scrollW, viewW } = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, viewW: window.innerWidth }));
    expect(scrollW).toBeLessThanOrEqual(viewW);
  });

  test('keyboard: choosing a tab with Enter keeps focus on that tab', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, 'keyboard navigation; the phone and tablet here are touch-only');
    await page.goto('/');
    await tabLink(page, 'schedule').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\?tab=schedule$/);
    await expectTab(page, 'schedule', DEMO.schedule);
    await expect(tabLink(page, 'schedule')).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expectTab(page, 'quick', DEMO.quick);
    await expect(tabLink(page, 'quick')).toBeFocused();
  });
});

// =============================================================================================
test.describe('Rapid tab switching', () => {
  test('five quick taps in a row end on the last tab, with its own list', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);
    for (const tab of ['schedule', 'quick', 'later', 'unsorted', 'do'] as Tab[]) await press(tabLink(page, tab));
    await expect(page).toHaveURL(/\/$/);
    await expectTab(page, 'do', DEMO.do);
    // each tap is one step back
    await page.goBack();
    await expect(page).toHaveURL(/\?tab=unsorted$/);
    await expectTab(page, 'unsorted', DEMO.unsorted);
    await page.goBack();
    await expectTab(page, 'later', DEMO.later);
    await expectSameDocument(page);
  });

  test('Back while a slow tab is still loading shows the tab you went back to', async ({ page }) => {
    await page.goto('/?tab=quick');
    await markDocument(page);
    let waiting = 0;
    await page.route(/\?tab=later/, async (route) => {
      waiting++;
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue().catch(() => {});
      waiting--;
    });
    await press(tabLink(page, 'later'));
    await expect(page).toHaveURL(/\?tab=later$/);
    await page.goBack();
    await expect(page).toHaveURL(/\?tab=quick$/);
    await expectTab(page, 'quick', DEMO.quick);
    await expect.poll(() => waiting, { message: 'the slow Later page has arrived' }).toBe(0);
    await expectTab(page, 'quick', DEMO.quick); // and didn't replace it
    await expectSameDocument(page);
  });

  test.describe('with 1,500 emails', () => {
    test.use({ mailbox: 'big' });

    test('slow answers arriving out of order never replace the last tab chosen', async ({ page }) => {
      const want = big().tabs.unsorted.subjects;
      await page.goto('/');
      // the tabs chosen first answer last
      const delay: Record<string, number> = { schedule: 1200, quick: 900, later: 600, '': 300, unsorted: 0 };
      let waiting = 0;
      await page.route((url) => url.pathname === '/', async (route) => {
        waiting++;
        await new Promise((r) => setTimeout(r, delay[new URL(route.request().url()).searchParams.get('tab') ?? ''] ?? 0));
        await route.continue().catch(() => {});
        waiting--;
      });
      for (const tab of ['schedule', 'quick', 'later', 'do', 'unsorted'] as Tab[]) await press(tabLink(page, tab));
      await expect(page).toHaveURL(/\?tab=unsorted$/);
      await expectTab(page, 'unsorted', want.slice(0, 50));
      await expect.poll(() => waiting, { message: 'every slow answer has come back' }).toBe(0);
      await expectTab(page, 'unsorted', want.slice(0, 50));
      await expect(range(page)).toHaveText(`1–50 of ${want.length}`);
    });
  });
});

// =============================================================================================
test.describe('Sidebar', () => {
  test('Inbox, All mail and Priority matrix open in place and mark where you are', async ({ page }) => {
    await page.goto('/');
    await markDocument(page);

    await chooseInSidebar(page, /^All mail/);
    await expect(page).toHaveURL(/\?view=all$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('All mail');
    await expect(page).toHaveTitle('(2) All mail · Unified Inbox');
    await expect(subjectsShown(page)).toHaveText(DEMO_ALL);
    await expect(tabBar(page)).toHaveCount(0);
    let nav = await sidebar(page);
    await expect(nav.getByRole('link', { name: /^All mail/ })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /^Inbox/ })).not.toHaveAttribute('aria-current');

    await chooseInSidebar(page, /^Priority matrix/);
    await expect(page).toHaveURL(/\?view=matrix$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Priority matrix');
    for (const tab of ['do', 'schedule', 'quick', 'later'] as Tab[]) {
      const box = page.getByRole('region', { name: TABS[tab], exact: true });
      await expect(box.getByRole('heading', { level: 2 })).toHaveText(TABS[tab]);
      if (tab !== 'later') await expect(box.locator('article .subject')).toHaveText(DEMO[tab]); // Later starts folded
    }
    if (!onPhone()) await expect(page.getByText(/^10 emails$/)).toBeVisible(); // phones hide the range
    nav = await sidebar(page);
    await expect(nav.getByRole('link', { name: /^Priority matrix/ })).toHaveAttribute('aria-current', 'page');

    await chooseInSidebar(page, /^Inbox/);
    await expect(page).toHaveURL(/\/$/);
    await expectTab(page, 'do', DEMO.do);
    nav = await sidebar(page);
    await expect(nav.getByRole('link', { name: /^Inbox/ })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: /^Priority matrix/ })).not.toHaveAttribute('aria-current');

    // Back walks through the views too
    if (!isDesktop()) await page.reload(); // put the drawer away
    await page.goBack();
    await expect(page).toHaveURL(/\?view=matrix$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Priority matrix');
    await page.goBack();
    await expect(page).toHaveURL(/\?view=all$/);
    await expect(subjectsShown(page)).toHaveText(DEMO_ALL);
    await page.goForward();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Priority matrix');
    if (isDesktop()) await expectSameDocument(page);
  });

  test('keyboard: g then i / a / m / t goes to Inbox, All mail, the matrix and Sent', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, 'single-key shortcuts; the phone and tablet here are touch-only');
    await page.goto('/?tab=later');
    await markDocument(page);
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await expect(page).toHaveURL(/\?view=all$/);
    await expect(subjectsShown(page)).toHaveText(DEMO_ALL);
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await expect(page).toHaveURL(/\?view=matrix$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Priority matrix');
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await expect(page).toHaveURL(/\/$/);
    await expectTab(page, 'do', DEMO.do);
    await expectSameDocument(page);
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/sent$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sent');
  });

  test('Sent and Sender rules open their own pages', async ({ page }) => {
    await page.goto('/');
    await chooseInSidebar(page, /^Sent/);
    await expect(page).toHaveURL(/\/sent$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sent');
    await expect((await sidebar(page)).getByRole('link', { name: /^Sent/ })).toHaveAttribute('aria-current', 'page');
    await chooseInSidebar(page, /^Sender rules/);
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sender rules');
    await expect((await sidebar(page)).getByRole('link', { name: /^Sender rules/ })).toHaveAttribute('aria-current', 'page');
    await chooseInSidebar(page, /^Inbox/);
    await expectTab(page, 'do', DEMO.do);
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sender rules');
    await page.goBack();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sent');
  });

  test("each account label shows only that account's mail", async ({ page, isPhone }) => {
    await page.goto('/?view=all');
    for (const acct of DEMO_ACCOUNTS) {
      await chooseInSidebar(page, new RegExp(`^${acct.label}\\b`));
      await expect(page).toHaveURL(`/?view=all&account=${encodeURIComponent(acct.email)}`);
      await expect(subjectsShown(page)).toHaveText(acct.subjects);
      // every row is that account's (rows have no accessible account name once filtered: data attribute)
      for (const account of await rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.account))) {
        expect(account).toBe(acct.email);
      }
      await expect(page.getByRole('link', { name: `Remove filter ${acct.label}` })).toBeVisible();
      if (!isPhone) await expect(range(page)).toHaveText(`1–${acct.subjects.length} of ${acct.subjects.length}`);
      // the unread rows match the account's unread count in the sidebar
      await expect(rows(page).filter({ hasText: /Unread: / })).toHaveCount(acct.unread);
      await expect((await sidebar(page)).getByRole('link', { name: new RegExp(`^${acct.label}\\b`) }))
        .toHaveAttribute('aria-current', 'true');
    }
    await page.reload();
    await expect(subjectsShown(page)).toHaveText(DEMO_ACCOUNTS[2].subjects);
  });

  test('choosing the account again, or its chip, removes the filter', async ({ page }) => {
    await page.goto('/?view=all');
    await markDocument(page);
    await chooseInSidebar(page, /^Velocity\b/);
    await expect(subjectsShown(page)).toHaveText(DEMO_ACCOUNTS[1].subjects);
    await chooseInSidebar(page, /^Velocity\b/);
    await expect(page).toHaveURL(/\?view=all$/);
    await expect(subjectsShown(page)).toHaveText(DEMO_ALL);
    await chooseInSidebar(page, /^Work\b/);
    await expect(subjectsShown(page)).toHaveText(DEMO_ACCOUNTS[2].subjects);
    await press(page.getByRole('link', { name: 'Remove filter Work' }));
    await expect(page).toHaveURL(/\?view=all$/);
    await expect(subjectsShown(page)).toHaveText(DEMO_ALL);
    await expectSameDocument(page);
  });

  test('an account filter narrows every inbox tab and its count', async ({ page, isPhone }) => {
    await page.goto('/?tab=schedule');
    await chooseInSidebar(page, /^Personal\b/);
    await expect(page).toHaveURL(`/?tab=schedule&account=${encodeURIComponent('sam@gmail.com')}`);
    await expectTab(page, 'schedule', ['Sunday lunch?']);
    await expect(tabLink(page, 'do')).toHaveAccessibleName('Do now');
    await expect(tabLink(page, 'schedule')).toHaveAccessibleName('Schedule 1 new');
    await expect(tabLink(page, 'quick')).toHaveAccessibleName('Quick reply 1 new');
    await expect(tabLink(page, 'later')).toHaveAccessibleName(isPhone ? 'Later' : 'Later 1');
    await expect(tabLink(page, 'unsorted')).toHaveAccessibleName('Not sorted 1 waiting');
    await press(tabLink(page, 'quick'));
    await expectTab(page, 'quick', ['Your OTP is 482913']);
    await press(tabLink(page, 'unsorted'));
    await expectTab(page, 'unsorted', ['Trip photos']);
    await press(tabLink(page, 'do'));
    await expect(tabLink(page, 'do')).toHaveAttribute('aria-current', 'page');
    await expect(subjectsShown(page)).toHaveCount(0);
    await expect(page.getByText('Nothing here yet — 1 still being sorted.')).toBeVisible();
  });

  test('the unread counts add up across the inbox, tabs and accounts', async ({ page }) => {
    await page.goto('/?view=all');
    const nav = await sidebar(page);
    await expect(nav.getByRole('link', { name: /^Inbox/ })).toHaveAccessibleName('Inbox 6 unread');
    for (const a of DEMO_ACCOUNTS) await expect(nav.getByRole('link', { name: new RegExp(`^${a.label}\\b`) })).toHaveAccessibleName(`${a.label} ${a.unread} unread`);
    await page.reload(); // closes the drawer
    await expect(rows(page).filter({ hasText: /Unread: / })).toHaveCount(6);

    // reading "Sunday lunch?" (Personal, Schedule) takes one off the inbox, its account and its tab
    await page.goto('/?tab=schedule');
    await press(rows(page).filter({ hasText: 'Sunday lunch?' }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: 'Sunday lunch?' })).toBeVisible();
    await page.goto('/?tab=schedule');
    await expect(tabLink(page, 'schedule')).toHaveAccessibleName(onPhone() ? 'Schedule' : 'Schedule 2');
    const nav2 = await sidebar(page);
    await expect(nav2.getByRole('link', { name: /^Inbox/ })).toHaveAccessibleName('Inbox 5 unread');
    await expect(nav2.getByRole('link', { name: /^Personal\b/ })).toHaveAccessibleName('Personal 2 unread');
    await expect(nav2.getByRole('link', { name: /^Work\b/ })).toHaveAccessibleName('Work 1 unread');
  });

  // APP BUG: on a tablet the Inbox logo link in the top bar has no accessible name (its text is hidden below 1024px)
  test('every link in the top bar has a name screen readers can read', async ({ page }) => {
    await page.goto('/');
    const links = page.getByRole('banner').getByRole('link');
    for (const link of await links.all()) {
      if (!(await link.isVisible())) continue;
      await expect(link, `link to ${await link.getAttribute('href')}`).toHaveAccessibleName(/\S/);
    }
  });
});

// =============================================================================================
test.describe('Pages of 50', () => {
  test.use({ mailbox: 'big' });

  test('the first page lists 50 emails, reads "1–50 of N", and every tab has its count', async ({ page }) => {
    const b = big();
    await page.goto('/');
    await expectPage(page, 1, 50, b.tabs.do.subjects.length, b.tabs.do.subjects.slice(0, 50));
    await expect(rows(page)).toHaveCount(50);
    for (const tab of ['do', 'schedule', 'quick', 'later'] as Tab[]) {
      await expect(tabLink(page, tab)).toHaveAccessibleName(`${TABS[tab]} ${b.tabs[tab].unread} new`);
    }
    await expect(tabLink(page, 'unsorted')).toHaveAccessibleName(`Not sorted ${b.tabs.unsorted.subjects.length} waiting`);
    const sum = TAB_KEYS.reduce((n, t) => n + b.tabs[t].subjects.length, 0);
    expect(sum, 'the tabs hold every email once').toBe(1500);
    // first page: no newer page; older is there
    await expect(page.getByRole('link', { name: 'Newer emails' })).toHaveCount(0);
    await expect(olderLink(page)).toBeVisible();
  });

  test('the arrows walk every page of a tab exactly once, and stop at both ends', async ({ page }) => {
    const want = big().tabs.schedule.subjects; // 159: four pages
    const n = want.length;
    expect(n).toBeGreaterThan(150);
    await page.goto('/?tab=schedule');
    await markDocument(page);
    const seen: string[] = [];
    const pages = Math.ceil(n / 50);
    for (let p = 0; p < pages; p++) {
      if (p) await turnPage(page, 'older');
      const last = Math.min(n, (p + 1) * 50);
      await expectPage(page, p * 50 + 1, last, n, want.slice(p * 50, last));
      seen.push(...(await subjectsShown(page).allTextContents()).map((s) => s.trim()));
      await expect(page).toHaveURL(p ? /\?tab=schedule&after=\d+$/ : /\?tab=schedule$/);
    }
    expect(new Set(seen).size, 'no email listed twice').toBe(seen.length);
    expect(seen, 'every email, in order, none skipped').toEqual(want);
    await expect(page.getByRole('link', { name: 'Older emails' }), 'no older page after the last').toHaveCount(0);
    await expect(newerLink(page)).toBeVisible();
    // and back again to the first page
    for (let p = pages - 2; p >= 0; p--) {
      await turnPage(page, 'newer');
      await expectPage(page, p * 50 + 1, (p + 1) * 50, n, want.slice(p * 50, (p + 1) * 50));
    }
    await expect(page).toHaveURL(/\?tab=schedule$/);
    await expect(page.getByRole('link', { name: 'Newer emails' }), 'no newer page before the first').toHaveCount(0);
    await expectSameDocument(page);
  });

  test('All mail pages through all 1,500 by priority', async ({ page }) => {
    const all = big().all;
    await page.goto('/');
    await chooseInSidebar(page, /^All mail/);
    await expectPage(page, 1, 50, 1500, all.slice(0, 50));
    await turnPage(page, 'older');
    await expectPage(page, 51, 100, 1500, all.slice(50, 100));
    await turnPage(page, 'older');
    await expectPage(page, 101, 150, 1500, all.slice(100, 150));
    await expect(page).toHaveURL(/\?view=all&after=\d+$/);
    await turnPage(page, 'newer');
    await expectPage(page, 51, 100, 1500, all.slice(50, 100));
    await expect(page).toHaveURL(/\?view=all&before=\d+$/);
  });

  test("an account's pages hold only that account's mail", async ({ page }) => {
    const mine = big().accounts['b@gmail.com']; // "Work": 375 emails
    await page.goto('/?view=all');
    await chooseInSidebar(page, /^Work\b/);
    await expectPage(page, 1, 50, mine.length, mine.slice(0, 50));
    await turnPage(page, 'older');
    await expectPage(page, 51, 100, mine.length, mine.slice(50, 100));
    await expect(page).toHaveURL(/\?view=all&account=b%40gmail\.com&after=\d+$/);
    for (const account of await rows(page).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.account))) {
      expect(account).toBe('b@gmail.com');
    }
  });

  test('Back after turning a page returns to the same page and the same spot', async ({ page }) => {
    const want = big().tabs.schedule.subjects;
    await page.goto('/?tab=schedule');
    await markDocument(page);
    await scrollToEnd(page);
    const arrow = footPager(page).getByRole('link', { name: 'Older emails' });
    await arrow.scrollIntoViewIfNeeded();
    const before = await topRow(page);
    expect(before.y, 'scrolled down the list').toBeGreaterThan(300);
    await press(arrow);
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: 'a new page starts at the top' }).toBeLessThan(5);

    await page.goBack();
    await expectPage(page, 1, 50, want.length, want.slice(0, 50));
    await expect.poll(async () => (await topRow(page)).id, { message: 'the same email is at the top of the screen' }).toBe(before.id);
    // (scrollY alone can differ: rows not drawn yet only have an estimated height)
    const after = await topRow(page);
    expect(Math.abs(after.top - before.top), 'at the same height on the screen').toBeLessThan(40);
    expect(after.y, 'still scrolled down the list').toBeGreaterThan(300);

    await page.goForward();
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    await expectSameDocument(page);
  });

  test('opening an email on page 2 and going back stays on page 2', async ({ page, isPhone }) => {
    const want = big().tabs.schedule.subjects;
    await page.goto('/?tab=schedule');
    await turnPage(page, 'older');
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    const pageTwo = page.url();
    const subject = want[80]; // 30 rows down: the list has to be scrolled to reach it

    // with the back arrow in the email
    await press(rows(page).filter({ hasText: subject }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: subject })).toBeVisible();
    await expect(page).toHaveURL(/\?tab=schedule&open=\d+&after=\d+$/);
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expect(page).toHaveURL(pageTwo);
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    await expect(rows(page).filter({ hasText: subject }), 'back where you were in the list').toBeInViewport();

    // with the browser's Back
    await press(rows(page).filter({ hasText: subject }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: subject })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(pageTwo);
    await expect(pane(page).getByRole('heading', { name: subject })).toBeHidden();
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));

    // a phone: swipe the email away to the right, like iOS
    if (isPhone) {
      await press(rows(page).filter({ hasText: subject }).getByRole('link'));
      await expect(pane(page).getByRole('heading', { name: subject })).toBeVisible();
      // let it finish sliding in (a finger lands on the email, not on the list still showing beside it)
      await expect.poll(async () => Math.round((await pane(page).boundingBox())?.x ?? -1)).toBe(0);
      await swipe(page, 30, 400, 370, 400, { ms: 250 });
      await expect(page).toHaveURL(pageTwo);
      await expect(pane(page).getByRole('heading', { name: subject })).toBeHidden();
      await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    }

    // the email open in a reloaded page still closes back to page 2
    await press(rows(page).filter({ hasText: subject }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: subject })).toBeVisible();
    await page.reload();
    await expect(pane(page).getByRole('heading', { name: subject })).toBeVisible();
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expect(page).toHaveURL(pageTwo);
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
  });

  test('"Older email" on the last email of a page opens the first email of the next page', async ({ page }) => {
    const want = big().tabs.do.subjects; // 61: two pages
    await page.goto('/');
    await press(rows(page).filter({ hasText: want[49] }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: want[49] })).toBeVisible();
    await press(pane(page).getByRole('button', { name: 'Older email' }));
    await expect(pane(page).getByRole('heading', { name: want[50] })).toBeVisible();
    await expect(page).toHaveURL(/\/\?open=\d+&after=\d+$/);
    await press(pane(page).getByRole('button', { name: 'Newer email' }));
    await expect(pane(page).getByRole('heading', { name: want[49] })).toBeVisible();
    await expect(page).toHaveURL(/\/\?open=\d+$/);
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expectPage(page, 1, 50, want.length, want.slice(0, 50));
  });

  test("reading an email on page 1 of Unread doesn't make page 2 skip or repeat one", async ({ page }) => {
    const want = big().tabs.later.unreadSubjects;
    await page.goto('/?tab=later');
    await press(page.getByRole('link', { name: 'Unread', exact: true }));
    await expect(page).toHaveURL(/\?tab=later&unread=1$/);
    await expectPage(page, 1, 50, want.length, want.slice(0, 50));
    // read the last one on the page: like any mail app it stays in the list until you move on
    const last = want[49];
    await press(rows(page).filter({ hasText: last }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: last })).toBeVisible();
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expect(subjectsShown(page)).toHaveText(want.slice(0, 50));
    await turnPage(page, 'older');
    // the next 50 unread, none skipped; it counts from where the read one was
    await expect(subjectsShown(page)).toHaveText(want.slice(50, 100));
    await expect(range(page)).toHaveText(`50–99 of ${want.length - 1}`);
  });

  test('reloading page 2 keeps page 2', async ({ page }) => {
    const want = big().tabs.later.subjects;
    await page.goto('/?tab=later');
    await turnPage(page, 'older');
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    await page.reload();
    await expectPage(page, 51, 100, want.length, want.slice(50, 100));
    await expect(tabLink(page, 'later')).toHaveAttribute('aria-current', 'page');
  });

  test('a page link whose email is gone shows the first page', async ({ page }) => {
    const want = big().tabs.schedule.subjects;
    await page.goto('/?tab=schedule&after=999999');
    await expectPage(page, 1, 50, want.length, want.slice(0, 50));
    await page.goto('/?tab=schedule&before=999999');
    await expectPage(page, 1, 50, want.length, want.slice(0, 50));
  });

  test('keyboard: j past the last email turns to the next page, k past the first turns back', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, 'j / k are keyboard shortcuts; the phone and tablet here are touch-only');
    const want = big().tabs.do.subjects; // 61: two pages
    await page.goto('/');
    await rows(page).last().getByRole('link').focus();
    await page.keyboard.press('j');
    await expectPage(page, 51, want.length, want.length, want.slice(50));
    await expect(rows(page).first().getByRole('link')).toBeFocused();
    await page.keyboard.press('k');
    await expectPage(page, 1, 50, want.length, want.slice(0, 50));
    await expect(rows(page).last().getByRole('link')).toBeFocused();
  });

  // APP BUG: on a touch tablet the ‹ › page arrows are 36px, below the 44px touch target (only phones get 44px)
  test('the page arrows are big enough to hit', async ({ page, isPhone, isTablet }) => {
    await page.goto('/?tab=schedule');
    await turnPage(page, 'older'); // both arrows are live on page 2
    await expect(range(page)).toHaveText(/^51–100 of/);
    const min = isPhone || isTablet ? 44 : 24; // touch: 44pt (DESIGN.md "Targets"); mouse: WCAG 2.2 minimum
    for (const link of [olderLink(page), newerLink(page)]) {
      if (isPhone) await scrollToEnd(page);
      const box = await link.boundingBox();
      expect(box, 'the arrow is on screen').not.toBeNull();
      expect.soft(Math.round(box!.width), `${await link.getAttribute('aria-label')} width`).toBeGreaterThanOrEqual(min);
      expect.soft(Math.round(box!.height), `${await link.getAttribute('aria-label')} height`).toBeGreaterThanOrEqual(min);
    }
  });
});

// =============================================================================================
test.describe('Fresh data after moving an email', () => {
  test('a moved email shows in its new tab at once, and after a reload', async ({ page, isPhone }) => {
    await page.goto('/');
    // both tabs have been seen (and so are remembered by the page) before the move
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', DEMO.later);
    await press(tabLink(page, 'do'));
    await expectTab(page, 'do', DEMO.do);

    await press(rows(page).filter({ hasText: 'Payment failed for velocity.example' }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: 'Payment failed for velocity.example' })).toBeVisible();
    const moves = pane(page).getByRole('group', { name: 'Move to' }).filter({ visible: true });
    await press(moves.getByRole('button', { name: /^Later/ }));
    await expect(snackbar(page)).toContainText('Moved to Later');
    // "Open next email after an action" (on by default) shows the next one: the contract
    await expect(pane(page).getByRole('heading', { name: 'Contract renewal needs your signature today' })).toBeVisible();
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));

    // all three in Later have been read: the count is the total (phones show only "new" counts)
    const doNow = ['Contract renewal needs your signature today'];
    const later = ['Payment failed for velocity.example', ...DEMO.later];
    await expectTab(page, 'do', doNow);
    await expect(tabLink(page, 'later')).toHaveAccessibleName(isPhone ? 'Later' : 'Later 3');
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', later);
    await press(tabLink(page, 'do'));
    await expectTab(page, 'do', doNow);

    await page.reload();
    await expectTab(page, 'do', doNow);
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', later);
    await page.reload();
    await expectTab(page, 'later', later);
  });

  test('Undo after a move puts the email back in its old tab, in both tabs', async ({ page }) => {
    await page.goto('/');
    await press(tabLink(page, 'later')); // remembered by the page before the move
    await expectTab(page, 'later', DEMO.later);
    await press(tabLink(page, 'do'));
    await press(rows(page).filter({ hasText: 'Payment failed for velocity.example' }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: 'Payment failed for velocity.example' })).toBeVisible();
    await press(pane(page).getByRole('group', { name: 'Move to' }).filter({ visible: true }).getByRole('button', { name: /^Later/ }));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await press(snackbar(page).getByRole('button', { name: 'Undo' }));
    await expect(snackbar(page)).toContainText('Undone');
    // the restored email opens again, back in Do now
    await expect(pane(page).getByRole('heading', { name: 'Payment failed for velocity.example' })).toBeVisible();
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expectTab(page, 'do', DEMO.do);
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', DEMO.later);
    await page.reload();
    await expectTab(page, 'later', DEMO.later);
    await press(tabLink(page, 'do'));
    await expectTab(page, 'do', DEMO.do);
  });

  test('sorting the last unsorted email by hand empties Not sorted, and the tab goes away', async ({ page }) => {
    await page.goto('/?tab=unsorted');
    await expectTab(page, 'unsorted', DEMO.unsorted);
    await press(rows(page).filter({ hasText: 'Trip photos' }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: 'Trip photos' })).toBeVisible();
    const moveToLater = pane(page).getByRole('group', { name: 'Move to' }).filter({ visible: true }).getByRole('button', { name: /^Later/ });
    await press(moveToLater);
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(pane(page).getByRole('heading', { name: 'Receipt from Velocity Growth' })).toBeVisible();
    await press(moveToLater);
    // nothing left to open: back to the (now empty) tab
    await expect(pane(page).getByRole('heading', { name: 'Receipt from Velocity Growth' })).toBeHidden();
    await expect(page).toHaveURL(/\?tab=unsorted$/);
    await expect(page.getByText('Everything is sorted.')).toBeVisible();
    await expect(subjectsShown(page)).toHaveCount(0);
    await expect(tabLink(page, 'unsorted')).toHaveAccessibleName('Not sorted 0 waiting');
    await expect(page.getByRole('region', { name: 'Sorting your mail' })).toHaveCount(0);

    const later = ['Trip photos', 'Receipt from Velocity Growth', ...DEMO.later];
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', later);
    await expect(tabLink(page, 'unsorted'), 'no Not sorted tab once everything is sorted').toHaveCount(0);
    await expect(tabBar(page).getByRole('link')).toHaveCount(4);
    await page.reload();
    await expectTab(page, 'later', later);
    await expect(tabBar(page).getByRole('link')).toHaveCount(4);
  });

  // APP BUG: the email "Open next email after an action" shows after a move is never marked read, so the counts stay up
  test('the email shown next after a move counts as read', async ({ page, isPhone }) => {
    await page.goto('/');
    await press(rows(page).filter({ hasText: 'Payment failed for velocity.example' }).getByRole('link'));
    await expect(pane(page).getByRole('heading', { name: 'Payment failed for velocity.example' })).toBeVisible();
    await press(pane(page).getByRole('group', { name: 'Move to' }).filter({ visible: true }).getByRole('button', { name: /^Later/ }));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(pane(page).getByRole('heading', { name: 'Contract renewal needs your signature today' })).toBeVisible();
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expectTab(page, 'do', ['Contract renewal needs your signature today']);
    // read, like an email opened by hand: no "new" badge, no unread row, one fewer in the inbox count
    await expect(rows(page).filter({ hasText: /Unread: / })).toHaveCount(0);
    await expect(tabLink(page, 'do')).toHaveAccessibleName(isPhone ? 'Do now' : 'Do now 1');
    await page.reload();
    await expect(tabLink(page, 'do')).toHaveAccessibleName(isPhone ? 'Do now' : 'Do now 1');
    await expect((await sidebar(page)).getByRole('link', { name: /^Inbox/ })).toHaveAccessibleName('Inbox 4 unread');
  });

  // APP BUG: a tab prefetched (mouse hover) while a move is still saving is cached with the old list and shown stale for 3 s+
  test('a tab looked at while a move is still saving is not shown out of date', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, 'hover prefetch and the 1–4 keys are mouse/keyboard paths');
    await page.goto('/');
    await expectTab(page, 'do', DEMO.do);
    // a slow connection: the move takes a second to reach the server
    await page.route('**/message/*/score', async (route) => {
      await new Promise((r) => setTimeout(r, 1000));
      await route.continue();
    });
    await rows(page).filter({ hasText: 'Payment failed for velocity.example' }).getByRole('link').focus();
    const saved = page.waitForResponse('**/message/*/score');
    await page.keyboard.press('4'); // Move to Later
    await tabLink(page, 'later').hover(); // on the way to the Later tab while it saves
    await saved;
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(subjectsShown(page)).toHaveText(['Contract renewal needs your signature today']);
    await press(tabLink(page, 'later'));
    await expectTab(page, 'later', ['Payment failed for velocity.example', ...DEMO.later]);
  });

  test.describe('with 1,500 emails', () => {
    test.use({ mailbox: 'big' });

    test("moving an email off page 1 doesn't make page 2 skip or repeat one", async ({ page }) => {
      const all = big().tabs.schedule.subjects;
      await page.goto('/?tab=schedule');
      await expectPage(page, 1, 50, all.length, all.slice(0, 50));
      const moved = all[0];
      await press(rows(page).filter({ hasText: moved }).getByRole('link'));
      await expect(pane(page).getByRole('heading', { name: moved })).toBeVisible();
      await press(pane(page).getByRole('group', { name: 'Move to' }).filter({ visible: true }).getByRole('button', { name: /^Later/ }));
      await expect(snackbar(page)).toContainText('Moved to Later');
      await expect(pane(page).getByRole('heading', { name: all[1] })).toBeVisible(); // the next one opened
      await press(pane(page).getByRole('link', { name: 'Back to the list' }));

      const left = all.slice(1);
      await expectPage(page, 1, 50, left.length, left.slice(0, 50));
      await turnPage(page, 'older');
      await expectPage(page, 51, 100, left.length, left.slice(50, 100));
      await press(tabLink(page, 'later'));
      await expect(subjectsShown(page).filter({ hasText: moved })).toHaveCount(1);
    });
  });
});
