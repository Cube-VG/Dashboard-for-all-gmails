// Reading and organising mail: opening an email on each device, what an open email shows,
// marking read, closing, the expandable panels, Move to (menu, buttons, keys 1–4, Undo / z),
// "Rules for this sender", the desktop keyboard shortcuts, and the side-by-side reading pane.
//
// Layouts (app/web/static/style.css §15 and §22, app.js openMessage/closePane):
// - desktop (1440px) and tablet (810px): an email takes the list's place in the main column
//   (Gmail's default); the sidebar (desktop) or its icon rail (tablet) stays.
// - phone (390px): the email covers the whole screen and the page behind it is inert.
// - desktop with Settings › "Reading pane on the right" (>= 1280px only): list left, email right.
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - The "Move to" button in the email's top bar is a <summary>: it has no button role in the
//   accessibility tree Playwright sees, so it is found by its title "Move to (1–4)". The list it
//   opens is not a menu (no menu / menuitem roles), so it is scoped with `details.move-wrap`.
// - A row's subject has no role of its own; its bold "unread" weight is read from `.subject`.
// - The list (#board) has no accessible name; whether it is inert behind a phone email is read
//   from #board.
// - The row of the email open in the side-by-side pane is only marked with a class (.active):
//   no aria-current / aria-selected, so screen readers don't hear which email is open.
// - The rule groups on the Rules page are plain <div>s (not named sections), so a group is found
//   as `.rule-group` that has the heading.
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar } from './fixtures';

// The demo mailbox (e2e/server.py), sorted into tabs by app/ai/scoring.quadrant().
const CONTRACT = 'Contract renewal needs your signature today'; // Do now, unread, attachment, Work
const PAYMENT = 'Payment failed for velocity.example'; // Do now, unread, Velocity (not Gmail)
const Q4 = 'Q4 planning doc — comments welcome'; // Schedule, read, answered
const SUNDAY = 'Sunday lunch?'; // Schedule, unread
const OTP = 'Your OTP is 482913'; // Quick reply, unread, alerts@bank.example
const TRIP = 'Trip photos'; // Not sorted, unread
const RECEIPT = 'Receipt from Velocity Growth'; // Not sorted, read, Velocity

/** Each Inbox tab's list (a <section aria-label>) and its address. */
const TABS = {
  'Do now': '/', Schedule: '/?tab=schedule', 'Quick reply': '/?tab=quick', Later: '/?tab=later',
  'Not sorted yet': '/?tab=unsorted',
} as const;
type Tab = keyof typeof TABS;

const KEYBOARD_ONLY = 'Keyboard shortcuts are a desktop feature: the phone and tablet projects have no '
  + 'hardware keyboard (the touch equivalents are tested in the other groups)';

// --- helpers ---------------------------------------------------------------------------------

const isTouch = () => !!test.info().project.use.hasTouch;

/** A finger tap on touch devices, a mouse click on the desktop. */
async function press(target: Locator) {
  if (isTouch()) await target.tap();
  else await target.click();
}

const list = (page: Page, tab: Tab = 'Do now') => page.getByRole('region', { name: tab, exact: true });
const row = (page: Page, subject: string, tab: Tab = 'Do now') =>
  list(page, tab).getByRole('article').filter({ hasText: subject });
const rowLink = (page: Page, subject: string, tab: Tab = 'Do now') => row(page, subject, tab).getByRole('link');
const tabsNav = (page: Page) => page.getByRole('navigation', { name: 'Inbox tabs' });
const tabLink = (page: Page, name: string) => tabsNav(page).getByRole('link', { name: new RegExp(`^${name}`) });
const sidebarLink = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Mailboxes' }).getByRole('link', { name: new RegExp(`^${name}`) });

const pane = (page: Page) => page.getByRole('complementary', { name: 'Selected email' });
const subjectOf = (page: Page) => pane(page).getByRole('heading', { level: 2 });
const backLink = (page: Page) => pane(page).getByRole('link', { name: 'Back to the list' });
const aiCard = (page: Page) => pane(page).getByRole('region', { name: 'AI summary and priority' });
/** The Move to buttons in the email's summary card ("Do now 1", "Schedule 2", …). */
const moveButton = (page: Page, label: string) =>
  aiCard(page).getByRole('group', { name: 'Move to' }).getByRole('button', { name: new RegExp(`^${label}`) });
const moveMenu = (page: Page) => pane(page).locator('details.move-wrap'); // no menu role: see the top
const undoButton = (page: Page) => snackbar(page).getByRole('button', { name: 'Undo' });

async function openEmail(page: Page, subject: string, tab: Tab = 'Do now') {
  await press(rowLink(page, subject, tab));
  await expect(subjectOf(page)).toHaveText(subject);
}

async function backToList(page: Page) {
  await press(backLink(page));
  await expect(pane(page)).toBeHidden();
  await expect(tabsNav(page)).toBeVisible();
}

async function openRulesPanel(page: Page) {
  await press(pane(page).getByText('Rules for this sender'));
  await expect(pane(page).getByRole('combobox', { name: 'Apply to' })).toBeVisible();
}

/** Settings (gear, top right) › a switch. Leaves the menu closed again. */
async function flipSetting(page: Page, name: string, to: 'true' | 'false') {
  const gear = page.getByLabel('Settings', { exact: true });
  await press(gear);
  const sw = page.getByRole('switch', { name });
  await expect(sw).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', to === 'true' ? 'false' : 'true');
  await press(sw);
  await expect(sw).toHaveAttribute('aria-checked', to);
  await press(gear);
  await expect(sw).toBeHidden();
}

/** A rule group on the Rules page ("Always important (VIP)", …). */
const ruleGroup = (page: Page, heading: string) =>
  page.locator('.rule-group').filter({ has: page.getByRole('heading', { name: heading, exact: true }) });

const idOf = async (link: Locator) => Number(new URL((await link.getAttribute('href'))!, 'http://x').searchParams.get('open'));

// ---------------------------------------------------------------------------------------------

test.describe('Opening an email', () => {
  test('tapping or clicking an email opens it: in place of the list on desktop and tablet, full screen on a phone', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    const id = await idOf(rowLink(page, CONTRACT));
    await openEmail(page, CONTRACT);
    await expect(page).toHaveURL(new RegExp(`/\\?open=${id}$`));

    if (isPhone) {
      // the email slides in over everything and the page behind it is out of reach
      await expect.poll(() => pane(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
      await expect(subjectOf(page)).toBeFocused();
      await expect(page.locator('#board')).toHaveJSProperty('inert', true);
      await expect(page.getByRole('banner')).toHaveJSProperty('inert', true);
    } else {
      // Gmail's default: the email replaces the list; the sidebar (tablet: its icon rail) stays
      await expect(tabsNav(page)).toBeHidden();
      const side = page.getByRole('navigation', { name: 'Mailboxes' });
      await expect(side).toBeVisible();
      const s = (await side.boundingBox())!;
      const p = (await pane(page).boundingBox())!;
      expect(p.x).toBeGreaterThanOrEqual(s.x + s.width - 1);
      if (isTablet) expect(s.width).toBeLessThan(100); // the icon rail, not the full sidebar
      expect(p.x + p.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await expect(page.locator('#board')).toHaveJSProperty('inert', false);
    }
  });

  test('the open email shows its summary, AI reason, deadline, sender, account, attachment note and text', async ({ page, isPhone }) => {
    await page.goto('/');
    // the list row already hints at most of it
    const r = row(page, CONTRACT);
    await expect(r.getByRole('img', { name: 'Has attachments' })).toBeVisible();
    await expect(r.getByText('Work', { exact: true })).toBeVisible();
    await expect(r).toContainText('Sign the Acme renewal contract by 5 pm today');
    if (!isPhone) await expect(r.getByText('due today')).toBeVisible(); // phones leave the chip out of the row

    await openEmail(page, CONTRACT);
    const p = pane(page);
    await expect(p.getByTitle('Urgent + important')).toHaveText('Do now');
    await expect(p.getByTitle('sam.work@gmail.com')).toHaveText('Work');
    const ai = aiCard(page);
    await expect(ai.getByText('Sign the Acme renewal contract by 5 pm today')).toBeVisible();
    await expect(ai.getByText('Why: Client deadline today · scored by Gemma')).toBeVisible();
    await expect(ai.getByRole('img', { name: 'Importance 5 of 5' })).toBeVisible();
    await expect(ai.getByRole('img', { name: 'Urgency 5 of 5' })).toBeVisible();
    await expect(ai.getByText('due today', { exact: true })).toBeVisible();
    await expect(ai.getByText('client', { exact: true })).toBeVisible();
    await expect(moveButton(page, 'Do now')).toHaveAttribute('aria-pressed', 'true');
    await expect(moveButton(page, 'Later')).toHaveAttribute('aria-pressed', 'false');
    await expect(p.getByText('Priya Raman <priya@acme.example>')).toBeVisible();
    await expect(p.getByText('to sam.work@gmail.com')).toBeVisible();
    await expect(p.getByText('Has attachments: open the email in Gmail or your webmail to see them.')).toBeVisible();
    await expect(p.getByText(/Legal needs it signed by 5 pm today so we can keep the current pricing/)).toBeVisible();
    const gmail = p.getByRole('link', { name: 'Open in Gmail' });
    await expect(gmail).toBeVisible();
    await expect(gmail).toHaveAttribute('href', 'https://mail.google.com/mail/u/sam.work@gmail.com/#search/rfc822msgid:m1%40demo');
    await expect(gmail).toHaveAttribute('target', '_blank');
    // and the way to answer it
    for (const name of ['Reply all', 'Forward']) await expect(p.getByRole('link', { name, exact: true })).toBeVisible();
  });

  test('an email the AI has not sorted yet says so; a non-Gmail account has no "Open in Gmail"', async ({ page }) => {
    await page.goto(TABS['Not sorted yet']);
    await openEmail(page, RECEIPT, 'Not sorted yet');
    const ai = aiCard(page);
    await expect(ai.getByText('Not sorted yet')).toBeVisible();
    await expect(ai.getByText(/^Why:/)).toHaveCount(0);
    await expect(ai.getByRole('img', { name: /^Importance/ })).toHaveCount(0);
    await expect(aiCard(page).getByRole('group', { name: 'Move to' }).getByRole('button', { pressed: true })).toHaveCount(0);
    await expect(pane(page).getByTitle('sam@velocity.example')).toHaveText('Velocity');
    await expect(pane(page).getByText('Stripe <receipts@stripe.example>')).toBeVisible();
    await expect(pane(page).getByText('Payment received: ₹12,400.')).toBeVisible();
    await expect(pane(page).getByRole('link', { name: 'Open in Gmail' })).toHaveCount(0);
    await expect(pane(page).getByText(/^Has attachments/)).toHaveCount(0);
  });

  test('an email you already answered is labelled "Replied" in the list and when open', async ({ page }) => {
    await page.goto(TABS.Schedule);
    await expect(row(page, Q4, 'Schedule').getByText('Replied', { exact: true })).toBeVisible();
    await openEmail(page, Q4, 'Schedule');
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
    await expect(aiCard(page).getByText('Why: Important, not urgent · scored by Gemma')).toBeVisible();
  });

  test('the address of an open email (/?open=N) shows that email again after a reload', async ({ page, isPhone }) => {
    await page.goto('/');
    const id = await idOf(rowLink(page, PAYMENT));
    await openEmail(page, PAYMENT);
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/\\?open=${id}$`));
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    if (isPhone) {
      await expect(subjectOf(page)).toBeFocused();
      await expect.poll(() => pane(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
    } else {
      await expect(tabsNav(page)).toBeHidden();
    }
    await backToList(page);
    await expect(rowLink(page, PAYMENT)).toBeVisible();
  });

  test('an email opened from All mail goes back to All mail', async ({ page }) => {
    await page.goto('/?view=all');
    const all = page.getByRole('region', { name: 'All email by priority' });
    const link = all.getByRole('article').filter({ hasText: SUNDAY }).getByRole('link');
    const id = await idOf(link);
    await press(link);
    await expect(subjectOf(page)).toHaveText(SUNDAY);
    await expect(page).toHaveURL(new RegExp(`/\\?view=all&open=${id}$`));
    await press(backLink(page));
    await expect(page).toHaveURL(/\/\?view=all$/);
    await expect(link).toBeFocused();
    await expect(link).not.toHaveAccessibleName(/^Unread: /);
  });

  test('the Older and Newer buttons in the email bar step through the list', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(pane(page).getByRole('button', { name: 'Older email' }));
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    // opened this way it is read too
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await press(pane(page).getByRole('button', { name: 'Newer email' }));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await backToList(page);
    await expect(rowLink(page, PAYMENT)).not.toHaveAccessibleName(/^Unread: /);
  });
});

test.describe('Marking as read', () => {
  test('opening an unread email marks it read: the row, the tab, the sidebar and the title follow, also after a reload', async ({ page, isPhone, isTablet }) => {
    const desktop = !isPhone && !isTablet; // the sidebar counts only show on the full sidebar
    await page.goto('/');
    const link = rowLink(page, CONTRACT);
    const subject = row(page, CONTRACT).locator('.subject');
    await expect(link).toHaveAccessibleName(/^Unread: Priya Raman/);
    await expect(subject).toHaveCSS('font-weight', '700');
    await expect(tabLink(page, 'Do now')).toHaveAccessibleName('Do now 2 new');
    await expect(page).toHaveTitle('(2) Inbox · Unified Inbox');
    if (desktop) {
      await expect(sidebarLink(page, 'Inbox')).toHaveAccessibleName('Inbox 6 unread');
      await expect(sidebarLink(page, 'Work')).toHaveAccessibleName('Work 1 unread');
    }

    await openEmail(page, CONTRACT);
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await expect(page).toHaveTitle('(1) Inbox · Unified Inbox');
    await backToList(page);

    const readNow = async () => {
      await expect(link).toHaveAccessibleName(/^Priya Raman/);
      await expect(subject).not.toHaveCSS('font-weight', '700');
      await expect(tabLink(page, 'Do now')).toHaveAccessibleName('Do now 1 new');
      await expect(page).toHaveTitle('(1) Inbox · Unified Inbox');
      if (desktop) {
        await expect(sidebarLink(page, 'Inbox')).toHaveAccessibleName('Inbox 5 unread');
        await expect(sidebarLink(page, 'Work')).toHaveAccessibleName('Work');
        // the row's own read toggle (shown on hover) now offers the opposite
        await expect(row(page, CONTRACT).getByRole('button', { name: `Mark as unread: ${CONTRACT}`, includeHidden: true })).toBeAttached();
      }
    };
    await readNow();
    await page.reload();
    await readNow();
  });

  test('under the Unread filter, an email you open stays in the list until you leave the page', async ({ page }) => {
    await page.goto('/?unread=1');
    await expect(list(page).getByRole('article')).toHaveCount(2);
    await openEmail(page, CONTRACT);
    await backToList(page);
    await expect(page).toHaveURL(/\/\?unread=1$/);
    // like any mail app, reading it doesn't pull it out from under you
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Priya Raman/);
    await expect(rowLink(page, PAYMENT)).toHaveAccessibleName(/^Unread: /);
    await page.reload();
    await expect(row(page, CONTRACT)).toHaveCount(0);
    await expect(row(page, PAYMENT)).toBeVisible();
  });

  test('opening an email that was already read changes no counts', async ({ page }) => {
    await page.goto(TABS.Schedule);
    await expect(tabLink(page, 'Schedule')).toHaveAccessibleName('Schedule 1 new');
    await openEmail(page, Q4, 'Schedule');
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await backToList(page);
    await expect(tabLink(page, 'Schedule')).toHaveAccessibleName('Schedule 1 new');
    await expect(rowLink(page, SUNDAY, 'Schedule')).toHaveAccessibleName(/^Unread: /);
    await expect(page).toHaveTitle('(2) Inbox · Unified Inbox');
  });

  test('"Mark as unread" in the open email makes it unread again, and Undo takes that back', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(pane(page).getByRole('button', { name: 'Mark as unread' }));
    await expect(snackbar(page)).toContainText('Marked as unread');
    await expect(pane(page).getByRole('button', { name: 'Mark as read' })).toBeVisible();
    await expect(subjectOf(page)).toHaveText(CONTRACT); // still reading it
    await backToList(page);
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Unread: /);
    await expect(tabLink(page, 'Do now')).toHaveAccessibleName('Do now 2 new');

    await press(undoButton(page));
    await expect(snackbar(page)).toContainText('Undone');
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Priya Raman/);
    await page.reload();
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Priya Raman/);
    await expect(tabLink(page, 'Do now')).toHaveAccessibleName('Do now 1 new');
  });

  test('only the dashboard itself can mark an email read: a plain link to the email pane cannot', async ({ page }) => {
    await page.goto('/');
    const id = await idOf(rowLink(page, CONTRACT));
    const url = `/message/${id}?partial=1&mark_read=1`;
    // what another site's link or <img> could do: no custom header
    expect((await page.request.get(url)).ok()).toBe(true);
    await page.reload();
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Unread: /);
    // what app.js sends when you open it
    const res = await page.request.get(url, { headers: { 'X-Inbox-Open': '1' } });
    expect(res.ok()).toBe(true);
    expect(await res.text()).toContain('data-read="1"');
    await page.reload();
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Priya Raman/);
  });

  // Was a bug, now fixed: when the last new email in a tab is read, the tab loses its number instead of showing its total (as it does after a reload)
  test('after reading every new email in a tab, the tab reads the same as after a reload', async ({ page, isPhone }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await backToList(page);
    await openEmail(page, PAYMENT);
    await backToList(page);
    // phones hide the total ("2") in tabs; elsewhere a tab with nothing new shows how many it has
    const settled = isPhone ? 'Do now' : 'Do now 2';
    await expect(tabLink(page, 'Do now')).toHaveAccessibleName(settled);
    await page.reload();
    await expect(tabLink(page, 'Do now')).toHaveAccessibleName(settled);
  });
});

test.describe('Closing an email', () => {
  test('"Back to the list" returns to the list with focus on the email you had open', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, PAYMENT);
    await press(backLink(page));
    await expect(page).toHaveURL(/\/$/);
    await expect(pane(page)).toBeHidden();
    await expect(tabsNav(page)).toBeVisible();
    await expect(rowLink(page, PAYMENT)).toBeFocused();
    await expect(page.locator('#board')).toHaveJSProperty('inert', false);
  });

  test('the browser Back button closes the email', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(pane(page)).toBeHidden();
    await expect(rowLink(page, CONTRACT)).toBeVisible();
    // and Forward opens it again
    await page.goForward();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
  });
});

test.describe('In a long list', () => {
  test.use({ mailbox: 'big' });

  // Was a bug, now fixed: on desktop and tablet an email opened far down a long list shows scrolled to its end: subject, summary and Move to are off the top of the screen
  test('an email opened from far down a long list starts at its top', async ({ page }) => {
    await page.goto('/');
    const target = list(page).getByRole('article').nth(39);
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    const subject = (await target.locator('.subject').textContent())!;
    await press(target.getByRole('link'));
    await expect(subjectOf(page)).toHaveText(subject);
    await expect(subjectOf(page)).toBeInViewport();
    // and not tucked under the email's own sticky bar (Back, Move to, …) either
    await expect.poll(async () => {
      const bar = (await backLink(page).boundingBox())!;
      return (await subjectOf(page).boundingBox())!.y - (bar.y + bar.height);
    }).toBeGreaterThanOrEqual(0);
    await expect(aiCard(page).getByRole('group', { name: 'Move to' })).toBeInViewport();
  });

  // Was a bug, now fixed: on desktop and tablet, closing that email leaves its row at the bottom edge of the screen instead of where it was (only with Reduce Motion is it right)
  test('closing an email puts you back at the same place in the list', async ({ page }) => {
    await page.goto('/');
    const target = list(page).getByRole('article').nth(39);
    await target.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
    const y0 = (await target.boundingBox())!.y;
    const subject = (await target.locator('.subject').textContent())!;
    await press(target.getByRole('link'));
    await expect(subjectOf(page)).toHaveText(subject);
    await press(backLink(page));
    await expect(pane(page)).toBeHidden();
    await expect.poll(async () => Math.abs((await target.boundingBox())!.y - y0)).toBeLessThan(4);
    await expect(target.getByRole('link')).toBeFocused();
  });
});

test.describe('Expandable panels in an email', () => {
  test('"Fine-tune the score" and "Rules for this sender" open and close', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const p = pane(page);
    const importance = p.getByRole('combobox', { name: 'Importance' });
    const applyTo = p.getByRole('combobox', { name: 'Apply to' });
    await expect(importance).toBeHidden();
    await expect(applyTo).toBeHidden();

    await press(p.getByText('Fine-tune the score'));
    await expect(importance).toBeVisible();
    await expect(importance).toHaveValue('5');
    await expect(p.getByRole('combobox', { name: 'Urgency' })).toHaveValue('5');
    await expect(p.getByRole('combobox', { name: 'Category' })).toHaveValue('client');
    await expect(p.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await press(p.getByText('Fine-tune the score'));
    await expect(importance).toBeHidden();

    await press(p.getByText('Rules for this sender'));
    await expect(applyTo).toBeVisible();
    for (const name of ['Always important (VIP)', 'Always low priority', 'Private — never send to AI']) {
      await expect(p.getByRole('button', { name, exact: true })).toBeVisible();
    }
    await press(p.getByText('Rules for this sender'));
    await expect(applyTo).toBeHidden();
  });

  test('Fine-tune: saving new scores moves the email to the matching tab', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const p = pane(page);
    await press(p.getByText('Fine-tune the score'));
    await p.getByRole('combobox', { name: 'Importance' }).selectOption('4');
    await p.getByRole('combobox', { name: 'Urgency' }).selectOption('1');
    await press(p.getByRole('button', { name: 'Save', exact: true }));
    await expect(snackbar(page)).toContainText('Saved — now in Schedule');
    await expect(undoButton(page)).toBeVisible();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(aiCard(page).getByRole('img', { name: 'Importance 4 of 5' })).toBeVisible();
    await expect(aiCard(page).getByRole('img', { name: 'Urgency 1 of 5' })).toBeVisible();
    await expect(aiCard(page).getByText('scored by you')).toBeVisible();
    await expect(moveButton(page, 'Schedule')).toHaveAttribute('aria-pressed', 'true');

    await page.goto(TABS.Schedule);
    await expect(row(page, CONTRACT, 'Schedule')).toBeVisible();
    await page.goto('/');
    await expect(row(page, CONTRACT)).toHaveCount(0);
  });
});

test.describe('Move to', () => {
  test('Move to › Later from the menu: the email leaves Do now, shows in Later, and stays there after a reload', async ({ page }) => {
    // let the background fetch of the other tabs finish first: a move while it runs can leave a
    // stale copy of the target tab behind (an app race, shown by its own test below)
    const warmed = page.waitForResponse((r) => r.url().endsWith('/?tab=unsorted'));
    await page.goto('/');
    await warmed;
    await openEmail(page, CONTRACT);
    await press(moveMenu(page).getByTitle('Move to (1–4)'));
    const later = moveMenu(page).getByRole('button', { name: /^Later/ });
    await expect(later).toBeVisible();
    await expect(moveMenu(page).getByRole('button', { name: /^Do now/ })).toHaveAttribute('aria-pressed', 'true');
    // the whole menu is on screen, nothing cut off at the edge
    const m = (await moveMenu(page).getByRole('group', { name: 'Move to' }).boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(m.y + m.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await press(later);

    // a mouse user gets a tip about the key for next time (only on a fine pointer)
    if (isTouch()) await expect(snackbar(page)).not.toContainText('Tip');
    else await expect(snackbar(page)).toContainText('Moved to Later · Tip: press 4 next time');
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(undoButton(page)).toBeVisible();
    // "Open next email after an action" is on by default
    await expect(subjectOf(page)).toHaveText(PAYMENT);

    await backToList(page);
    await expect(row(page, CONTRACT)).toHaveCount(0);
    await expect(row(page, PAYMENT)).toBeVisible();
    await press(tabLink(page, 'Later'));
    await expect(page).toHaveURL(/\?tab=later$/);
    await expect(row(page, CONTRACT, 'Later')).toBeVisible();
    await page.reload();
    await expect(row(page, CONTRACT, 'Later')).toBeVisible();
    await page.goto('/');
    await expect(row(page, PAYMENT)).toBeVisible();
    await expect(row(page, CONTRACT)).toHaveCount(0);
  });

  // Was a bug, now fixed: a tab fetched in the background while a move is on its way is kept from before the move: switching to it right after shows the moved email missing
  test('right after a move, the target tab lists the email even if it was fetched in the background meanwhile', async ({ page }) => {
    // A slow connection: the move takes a moment to reach the server, and meanwhile the dashboard
    // fetches the other tabs in the background (app.js warm()). The routes only fix the order:
    // the background fetch waits for the move to be sent, the move waits for the Later tab fetch.
    let sent!: () => void;
    const moveSent = new Promise<void>((r) => { sent = r; });
    const laterFetched = page.waitForResponse((r) => r.url().endsWith('/?tab=later'));
    await page.route(/\/\?tab=schedule$/, async (route) => { await moveSent; await route.continue(); });
    await page.route(/\/message\/\d+\/score$/, async (route) => { sent(); await laterFetched; await route.continue(); });
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Later'));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await backToList(page);
    await expect(row(page, CONTRACT)).toHaveCount(0);
    await press(tabLink(page, 'Later'));
    await expect(page).toHaveURL(/\?tab=later$/);
    await expect(row(page, CONTRACT, 'Later')).toBeVisible();
    await expect(tabLink(page, 'Later')).toHaveAccessibleName(isTouch() ? /^Later/ : 'Later 3');
  });

  test('the Move to buttons in the summary card move the email too', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Quick reply'));
    await expect(snackbar(page)).toContainText('Moved to Quick reply');
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await page.goto(TABS['Quick reply']);
    await expect(row(page, CONTRACT, 'Quick reply')).toBeVisible();
    await openEmail(page, CONTRACT, 'Quick reply');
    await expect(moveButton(page, 'Quick reply')).toHaveAttribute('aria-pressed', 'true');
    await expect(aiCard(page).getByText('scored by you')).toBeVisible();
  });

  test('Undo in the snackbar puts the email back where it was, also after a reload', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Schedule'));
    await expect(snackbar(page)).toContainText('Moved to Schedule');
    await expect(subjectOf(page)).toHaveText(PAYMENT);

    await press(undoButton(page));
    await expect(snackbar(page)).toContainText('Undone');
    // the whole prior state comes back: the email is open again, in Do now
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(moveButton(page, 'Do now')).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/');
    await expect(row(page, CONTRACT)).toBeVisible();
    await page.goto(TABS.Schedule);
    await expect(row(page, CONTRACT, 'Schedule')).toHaveCount(0);
  });

  test('moving every email out of a tab closes the email and shows the empty tab', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Later'));
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await press(moveButton(page, 'Later'));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(pane(page)).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    // Do now is empty; with mail still waiting for the AI it points there instead of "You're clear"
    await expect(page.getByText('Nothing here yet — 2 still being sorted.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'See them' })).toHaveAttribute('href', '/?tab=unsorted');
    await expect(list(page)).toHaveCount(0);
    await page.goto(TABS.Later);
    await expect(row(page, CONTRACT, 'Later')).toBeVisible();
    await expect(row(page, PAYMENT, 'Later')).toBeVisible();
  });

  test('moving an email the AI has not sorted offers Open instead of Undo', async ({ page }) => {
    await page.goto(TABS['Not sorted yet']);
    await openEmail(page, TRIP, 'Not sorted yet');
    await press(moveButton(page, 'Schedule'));
    await expect(snackbar(page)).toContainText('Moved to Schedule');
    // "not sorted" can't be put back, so the snackbar offers to open it again instead
    await expect(undoButton(page)).toHaveCount(0);
    const open = snackbar(page).getByRole('button', { name: 'Open' });
    await expect(open).toBeVisible();
    await expect(subjectOf(page)).toHaveText(RECEIPT); // the next one waiting
    await press(open);
    await expect(subjectOf(page)).toHaveText(TRIP);
    await expect(moveButton(page, 'Schedule')).toHaveAttribute('aria-pressed', 'true');
    await page.goto(TABS.Schedule);
    await expect(row(page, TRIP, 'Schedule')).toBeVisible();
  });

  // Was a bug, now fixed: the email opened automatically after a move ("Open next email after an action") stays unread
  test('after a move, the next email that opens is marked read like any email you open', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Later'));
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await backToList(page);
    await expect(rowLink(page, PAYMENT)).toHaveAccessibleName(/^Hostinger/);
    await expect(tabLink(page, 'Do now')).not.toHaveAccessibleName(/new$/);
  });

  test('with "Open next email after an action" off, the moved email stays open; the choice survives a reload', async ({ page }) => {
    await page.goto('/');
    await flipSetting(page, 'Open next email after an action', 'false');
    await openEmail(page, CONTRACT);
    await press(moveButton(page, 'Later'));
    await expect(snackbar(page)).toContainText('Moved to Later');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(moveButton(page, 'Later')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/\?open=\d+$/);

    await page.goto('/');
    await press(page.getByLabel('Settings', { exact: true }));
    await expect(page.getByRole('switch', { name: 'Open next email after an action' })).toHaveAttribute('aria-checked', 'false');
  });

  test.describe('with the keyboard', () => {
    test.beforeEach(({}, info) => { test.skip(info.project.name !== 'desktop', KEYBOARD_ONLY); });

    test('keys 1–4 move the open email, and z undoes the move', async ({ page }) => {
      await page.goto('/');
      await openEmail(page, CONTRACT);
      await page.keyboard.press('4');
      await expect(snackbar(page)).toContainText('Moved to Later');
      await expect(snackbar(page)).not.toContainText('Tip'); // they already used the key
      await expect(subjectOf(page)).toHaveText(PAYMENT);

      await page.keyboard.press('z');
      await expect(snackbar(page)).toContainText('Undone');
      await expect(subjectOf(page)).toHaveText(CONTRACT);
      await expect(moveButton(page, 'Do now')).toHaveAttribute('aria-pressed', 'true');

      await page.keyboard.press('2');
      await expect(snackbar(page)).toContainText('Moved to Schedule');
      await page.goto(TABS.Schedule);
      await expect(row(page, CONTRACT, 'Schedule')).toBeVisible();
      await page.goto('/');
      await expect(row(page, CONTRACT)).toHaveCount(0);
    });

    test('keys 1–4 also move the focused email in the list without opening it', async ({ page }) => {
      await page.goto('/');
      await page.keyboard.press('j');
      await expect(rowLink(page, CONTRACT)).toBeFocused();
      await page.keyboard.press('3');
      await expect(snackbar(page)).toContainText('Moved to Quick reply');
      await expect(row(page, CONTRACT)).toHaveCount(0);
      await expect(rowLink(page, PAYMENT)).toBeFocused(); // the cursor moves on, like Gmail
      await expect(pane(page)).toBeHidden();
      await expect(page).toHaveURL(/\/$/);
      await page.keyboard.press('z');
      await expect(snackbar(page)).toContainText('Undone');
      await expect(row(page, CONTRACT)).toBeVisible();
    });
  });
});

test.describe('Rules for this sender', () => {
  test('VIP for this sender: the rule shows on the email, stays after a reload, and is on the Rules page', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await openRulesPanel(page);
    await expect(pane(page).getByRole('combobox', { name: 'Apply to' })).toHaveValue('priya@acme.example');
    await press(pane(page).getByRole('button', { name: 'Always important (VIP)', exact: true }));
    await expect(snackbar(page)).toContainText(
      "Rule saved: Always important (VIP) for priya@acme.example. It applies to their new mail from now on.");
    await expect(undoButton(page)).toBeVisible();
    const active = pane(page).getByRole('list', { name: 'Active rules' });
    await expect(active.getByRole('listitem')).toHaveText(['Always important (VIP) · priya@acme.example']);
    await expect(active.getByRole('button', { name: 'Remove rule Always important (VIP) for priya@acme.example' })).toBeVisible();

    await page.reload();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    // an email with rules shows its rules panel already open
    await expect(active.getByRole('listitem')).toHaveText(['Always important (VIP) · priya@acme.example']);

    await press(pane(page).getByRole('link', { name: 'Rules', exact: true }));
    await expect(page).toHaveURL(/\/rules$/);
    await expect(page.getByRole('heading', { name: 'Sender rules', level: 1 })).toBeVisible();
    const vip = ruleGroup(page, 'Always important (VIP)');
    await expect(vip.getByRole('listitem')).toHaveCount(1);
    await expect(vip.getByRole('listitem')).toContainText('priya@acme.example');
    await expect(vip.getByRole('listitem')).toContainText(/1 email · added \d{4}-\d{2}-\d{2}/);
    await expect(ruleGroup(page, 'Always low priority').getByText('None yet.')).toBeVisible();
  });

  test('Always low for the whole domain counts every email from that domain', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await openRulesPanel(page);
    await pane(page).getByRole('combobox', { name: 'Apply to' }).selectOption('@acme.example');
    await press(pane(page).getByRole('button', { name: 'Always low priority', exact: true }));
    await expect(snackbar(page)).toContainText('Rule saved: Always low priority for @acme.example.');
    await expect(pane(page).getByRole('list', { name: 'Active rules' }).getByRole('listitem'))
      .toHaveText(['Always low priority · @acme.example']);
    await page.goto('/rules');
    const low = ruleGroup(page, 'Always low priority');
    await expect(low.getByRole('listitem')).toContainText('@acme.example');
    await expect(low.getByRole('listitem')).toContainText('2 emails'); // Priya's contract and Dev's Q4 plan
    // the rule shows on the other email from that domain too
    await page.goto(TABS.Schedule);
    await openEmail(page, Q4, 'Schedule');
    await expect(pane(page).getByRole('list', { name: 'Active rules' }).getByRole('listitem'))
      .toHaveText(['Always low priority · @acme.example']);
  });

  test('Private for this sender, removed from the email with its ✕, and Undo brings it back', async ({ page }) => {
    await page.goto(TABS['Quick reply']);
    await openEmail(page, OTP, 'Quick reply');
    await openRulesPanel(page);
    await press(pane(page).getByRole('button', { name: 'Private — never send to AI', exact: true }));
    await expect(snackbar(page)).toContainText('Rule saved: Private — never send to AI for alerts@bank.example.');
    const active = pane(page).getByRole('list', { name: 'Active rules' });
    await expect(active.getByRole('listitem')).toHaveText(['Private — never send to AI · alerts@bank.example']);

    await press(active.getByRole('button', { name: 'Remove rule Private — never send to AI for alerts@bank.example' }));
    await expect(snackbar(page)).toContainText('Rule removed');
    await expect(active).toHaveCount(0);
    await press(undoButton(page));
    await expect(snackbar(page)).toContainText('Undone');
    await expect(active.getByRole('listitem')).toHaveText(['Private — never send to AI · alerts@bank.example']);

    await page.goto('/rules');
    await expect(ruleGroup(page, 'Private — never send to AI').getByRole('listitem')).toContainText('alerts@bank.example');
  });

  test('Private takes effect at once: "Help me write" will not send that sender\'s email to the AI', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 422/); // the refusal is a 422 the browser logs
    await page.goto(TABS['Quick reply']);
    await openEmail(page, OTP, 'Quick reply');
    await openRulesPanel(page);
    await press(pane(page).getByRole('button', { name: 'Private — never send to AI', exact: true }));
    await expect(snackbar(page)).toContainText('Rule saved');

    await press(pane(page).getByRole('link', { name: 'Reply', exact: true }).last());
    const reply = pane(page).getByRole('form', { name: 'Reply' });
    await expect(reply).toBeVisible();
    await press(reply.getByRole('button', { name: 'Help me write' }));
    await reply.getByRole('textbox', { name: 'Help me write' }).fill('say thanks');
    await press(reply.getByRole('button', { name: 'Create' }));
    await expect(page.getByRole('alert')).toContainText('This sender is marked “Private — never send to AI”');
    await expect(reply.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  test('Undo right after adding a rule removes it again', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await openRulesPanel(page);
    await press(pane(page).getByRole('button', { name: 'Always important (VIP)', exact: true }));
    await expect(snackbar(page)).toContainText('Rule saved');
    await press(undoButton(page));
    await expect(snackbar(page)).toContainText('Undone');
    await expect(pane(page).getByRole('list', { name: 'Active rules' })).toHaveCount(0);
    await page.goto('/rules');
    await expect(ruleGroup(page, 'Always important (VIP)').getByText('None yet.')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'priya@acme.example' })).toHaveCount(0);
  });
});

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(({}, info) => { test.skip(info.project.name !== 'desktop', KEYBOARD_ONLY); });

  test('j and k move through the list; Enter and o open the email under the cursor', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('j');
    await expect(rowLink(page, CONTRACT)).toBeFocused();
    await page.keyboard.press('j');
    await expect(rowLink(page, PAYMENT)).toBeFocused();
    await page.keyboard.press('j'); // the last one in the tab: stays put
    await expect(rowLink(page, PAYMENT)).toBeFocused();
    await page.keyboard.press('k');
    await expect(rowLink(page, CONTRACT)).toBeFocused();
    await expect(pane(page)).toBeHidden(); // moving the cursor opens nothing

    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(subjectOf(page)).toBeFocused(); // opened from the keyboard: focus goes into the email
    await page.keyboard.press('u');
    await expect(rowLink(page, CONTRACT)).toBeFocused();
    await page.keyboard.press('j');
    await expect(rowLink(page, PAYMENT)).toBeFocused();
    await page.keyboard.press('o');
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await expect(subjectOf(page)).toBeFocused();
  });

  test('with an email open, j and k open the older and newer email (and mark it read)', async ({ page }) => {
    await page.goto('/');
    const [c, p] = [await idOf(rowLink(page, CONTRACT)), await idOf(rowLink(page, PAYMENT))];
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await page.keyboard.press('j');
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await expect(page).toHaveURL(new RegExp(`\\?open=${p}$`));
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await page.keyboard.press('k');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(page).toHaveURL(new RegExp(`\\?open=${c}$`));
    await expect(page).toHaveTitle('Inbox · Unified Inbox'); // both of Do now's emails are read
  });

  test('u and Esc go back to the list, with focus on the email that was open', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await page.keyboard.press('Escape');
    await expect(pane(page)).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await expect(rowLink(page, PAYMENT)).toBeFocused();

    await page.keyboard.press('o');
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await page.keyboard.press('u');
    await expect(pane(page)).toBeHidden();
    await expect(rowLink(page, PAYMENT)).toBeFocused();
  });

  test('Esc closes an open Move to menu first, then the email', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const summary = moveMenu(page).getByTitle('Move to (1–4)');
    await summary.click();
    const later = moveMenu(page).getByRole('button', { name: /^Later/ });
    await expect(later).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(later).toBeHidden();
    await expect(summary).toBeFocused();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await page.keyboard.press('Escape');
    await expect(pane(page)).toBeHidden();
    await expect(rowLink(page, CONTRACT)).toBeFocused();
  });

  test('e on an email in the list marks it read and moves the cursor to the next one', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('j');
    await expect(rowLink(page, CONTRACT)).toBeFocused();
    await page.keyboard.press('e');
    await expect(snackbar(page)).toContainText('Marked as read');
    await expect(undoButton(page)).toBeVisible();
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Priya Raman/);
    await expect(rowLink(page, PAYMENT)).toBeFocused();
    await expect(pane(page)).toBeHidden();
    await expect(tabLink(page, 'Do now')).toHaveAccessibleName('Do now 1 new');
    await page.keyboard.press('z');
    await expect(snackbar(page)).toContainText('Undone');
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Unread: /);
  });

  test('e in an open email marks it read and opens the next one, which is then read too', async ({ page }) => {
    await page.goto('/');
    const p = await idOf(rowLink(page, PAYMENT));
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await page.keyboard.press('e');
    // both Do now emails are read now, so the "Do now is clear" moment may take the note's place
    await expect(snackbar(page)).toContainText(/Marked as read|Do now is clear/);
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await expect(page).toHaveURL(new RegExp(`\\?open=${p}$`));
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
  });

  test('Shift+U and Shift+I mark the open email unread and read again', async ({ page }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await page.keyboard.press('Shift+U');
    await expect(snackbar(page)).toContainText('Marked as unread');
    await expect(pane(page).getByRole('button', { name: 'Mark as read' })).toBeVisible();
    await page.keyboard.press('Shift+I');
    await expect(snackbar(page)).toContainText('Marked as read');
    await expect(pane(page).getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await page.keyboard.press('u');
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Priya Raman/);
  });

  test.describe('across pages', () => {
    test.use({ mailbox: 'big' });

    test('j past the last email of a page opens the first one on the next page, and k comes back', async ({ page }) => {
      await page.goto('/');
      const rows = list(page).getByRole('article');
      await expect(rows).toHaveCount(50);
      await expect(page.getByText(/^1–50 of \d+$/).first()).toBeVisible();
      const lastOnFirst = (await rows.nth(49).locator('.subject').textContent())!;
      await rows.nth(49).getByRole('link').click();
      await expect(subjectOf(page)).toHaveText(lastOnFirst);

      await page.keyboard.press('j');
      await expect(page).toHaveURL(/[?&]after=\d+/);
      await expect(page).toHaveURL(/[?&]open=\d+/);
      await expect(subjectOf(page)).not.toHaveText(lastOnFirst);
      await expect(subjectOf(page)).toHaveText(/^Subject number \d+ about something$/);
      await expect(subjectOf(page)).toBeFocused();
      const firstOnSecond = (await subjectOf(page).textContent())!;

      await page.keyboard.press('k');
      await expect(subjectOf(page)).toHaveText(lastOnFirst);
      await expect(page).not.toHaveURL(/after=/);

      await page.keyboard.press('j');
      await expect(subjectOf(page)).toHaveText(firstOnSecond);
      await page.keyboard.press('u');
      // back on the second page's list, with the cursor on the email that was open
      await expect(page.getByText(/^51–\d+ of \d+$/).first()).toBeVisible();
      await expect(rows.first()).toContainText(firstOnSecond);
      await expect(rows.first().getByRole('link')).toBeFocused();
    });
  });

  test('? opens the list of shortcuts and Esc closes it', async ({ page }) => {
    await page.goto('/');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeHidden();
    await page.keyboard.press('?');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Mark read, open the next email')).toBeVisible();
    await expect(sheet.getByText('Move to Do now · Schedule · Quick reply · Later')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Close' })).toBeFocused();
    // other shortcuts wait while it is open
    await page.keyboard.press('j');
    await expect(rowLink(page, CONTRACT)).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    await page.keyboard.press('?');
    await expect(sheet).toBeVisible();
    await page.keyboard.press('?');
    await expect(sheet).toBeHidden();
    // also from Settings
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
  });

  test('shortcuts do nothing while typing in the search box or in a field of the email', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('searchbox', { name: 'Search mail' });
    await search.click();
    await page.keyboard.type('je1?uz');
    await expect(search).toHaveValue('je1?uz');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
    await expect(snackbar(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(rowLink(page, CONTRACT)).toHaveAccessibleName(/^Unread: /);

    await openEmail(page, CONTRACT);
    await press(pane(page).getByText('Fine-tune the score'));
    const category = pane(page).getByRole('combobox', { name: 'Category' });
    await category.click();
    await category.press('End');
    await page.keyboard.type('4ujk');
    await expect(category).toHaveValue('client4ujk');
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(pane(page)).toBeVisible();
    await expect(snackbar(page)).toHaveCount(0);
    await expect(moveButton(page, 'Do now')).toHaveAttribute('aria-pressed', 'true');
  });

  test('turning off single-key shortcuts stops them, and the choice is remembered', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    const sw = sheet.getByRole('switch', { name: 'Single-key shortcuts' });
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();

    await page.keyboard.press('j');
    await expect(rowLink(page, CONTRACT)).not.toBeFocused();
    await page.reload();
    await page.keyboard.press('j');
    await page.keyboard.press('?');
    await expect(rowLink(page, CONTRACT)).not.toBeFocused();
    await expect(sheet).toBeHidden();
    // switched back on from Settings › Keyboard shortcuts
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(sw).toHaveAttribute('aria-checked', 'false');
    await sw.click();
    await page.keyboard.press('Escape');
    await page.keyboard.press('j');
    await expect(rowLink(page, CONTRACT)).toBeFocused();
  });
});

test.describe('Reading pane on the right', () => {
  test('the setting is only offered where the window is wide enough', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    await press(page.getByLabel('Settings', { exact: true }));
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeVisible();
    const split = page.getByRole('switch', { name: 'Reading pane on the right' });
    if (isPhone || isTablet) await expect(split).toBeHidden(); // it needs >= 1280px
    else await expect(split).toBeVisible();
  });

  test.describe('on a wide screen', () => {
    test.beforeEach(({}, info) => {
      test.skip(info.project.name !== 'desktop', 'The side-by-side pane needs a window at least 1280px wide; phones and tablets never offer it (checked above)');
    });

    test('the list and the email sit side by side, and j / k change the open email', async ({ page }) => {
      await page.goto('/');
      await flipSetting(page, 'Reading pane on the right', 'true');
      await openEmail(page, CONTRACT);
      const [c, p] = [await idOf(rowLink(page, CONTRACT)), await idOf(rowLink(page, PAYMENT))];
      await expect(tabsNav(page)).toBeVisible();
      await expect(rowLink(page, PAYMENT)).toBeVisible();
      const board = (await list(page).boundingBox())!;
      const email = (await pane(page).boundingBox())!;
      expect(email.x).toBeGreaterThanOrEqual(board.x + board.width - 1);
      expect(email.x + email.width).toBeLessThanOrEqual(1440);
      expect(email.width).toBeGreaterThanOrEqual(440);
      await expect(row(page, CONTRACT)).toHaveClass(/\bactive\b/); // no aria-current: see the top

      await page.keyboard.press('j');
      await expect(subjectOf(page)).toHaveText(PAYMENT);
      await expect(page).toHaveURL(new RegExp(`\\?open=${p}$`));
      await expect(rowLink(page, PAYMENT)).toBeFocused(); // the cursor stays in the list
      await expect(row(page, PAYMENT)).toHaveClass(/\bactive\b/);
      await expect(row(page, CONTRACT)).not.toHaveClass(/\bactive\b/);
      await expect(rowLink(page, PAYMENT)).toHaveAccessibleName(/^Hostinger/); // read now
      await page.keyboard.press('k');
      await expect(subjectOf(page)).toHaveText(CONTRACT);
      await expect(page).toHaveURL(new RegExp(`\\?open=${c}$`));
      await expect(rowLink(page, CONTRACT)).toBeFocused();

      // a move takes the email out of the list beside it
      await page.keyboard.press('4');
      await expect(snackbar(page)).toContainText('Moved to Later');
      await expect(row(page, CONTRACT)).toHaveCount(0);
      await expect(subjectOf(page)).toHaveText(PAYMENT);
    });

    test('the side-by-side layout survives a reload, and closing the email gives the list the room back', async ({ page }) => {
      await page.goto('/');
      await flipSetting(page, 'Reading pane on the right', 'true');
      await openEmail(page, CONTRACT);
      await page.reload();
      await expect(subjectOf(page)).toHaveText(CONTRACT);
      await expect(tabsNav(page)).toBeVisible();
      const narrow = (await list(page).boundingBox())!.width;
      await press(page.getByLabel('Settings', { exact: true }));
      await expect(page.getByRole('switch', { name: 'Reading pane on the right' })).toHaveAttribute('aria-checked', 'true');
      await press(page.getByLabel('Settings', { exact: true }));

      await press(backLink(page));
      await expect(pane(page)).toBeHidden();
      await expect(rowLink(page, CONTRACT)).toBeFocused();
      await expect.poll(async () => (await list(page).boundingBox())!.width).toBeGreaterThan(narrow + 300);
    });
  });
});
