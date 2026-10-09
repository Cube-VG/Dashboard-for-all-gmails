// The other views, on a desktop, a phone and a tablet: All mail (everything, by priority, 50 per
// page), the Priority matrix (four boxes, Not sorted as a progress strip, the phone dock), Sent
// (empty state, Sending… / Undo / Undone / Edit / Discard, resending an undone email), the sync
// button and status line, the "N newly sorted" pill, and the friendly error page.
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - The sync button is always named "Refresh" (aria-label), so its "Syncing…" / "Up to date" /
//   "Sync now" text (an sr-only span inside it) is never announced; it's read with `.sync-label`.
// - The "N newly sorted · Show" pill is a plain button with no live region: nothing announces it.
// - Rows don't expose their subject separately, so subjects are read from each row's text.
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar } from './fixtures';

// ---------------------------------------------------------------------------------------------
// helpers

const isDesktop = () => test.info().project.name === 'desktop';
/** Phones and tablets are touched, the desktop is clicked. */
async function press(target: Locator) {
  if (isDesktop()) await target.click();
  else await target.tap();
}

const mailboxes = (page: Page) => page.getByRole('navigation', { name: 'Mailboxes' });
const menuButton = (page: Page) => page.getByRole('button', { name: 'Main menu' });

/** The sidebar, opened as a drawer where it is one (phone, tablet). */
async function openSidebar(page: Page) {
  if (!isDesktop()) {
    await press(menuButton(page));
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  }
  return mailboxes(page);
}

/** Close the drawer the way a finger does: a tap on the dimmed page beside it. */
async function closeSidebar(page: Page) {
  if (isDesktop()) return;
  const vp = page.viewportSize()!;
  await page.touchscreen.tap(vp.width - 16, Math.round(vp.height / 2));
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  // and it has finished sliding away (only the full sidebar has the Accounts heading)
  await expect(mailboxes(page).getByRole('heading', { name: 'Accounts' })).toBeHidden();
}

/** The sidebar marks this view as the current page (on a phone, look inside the drawer). */
async function expectCurrentView(page: Page, name: RegExp) {
  if (test.info().project.name !== 'phone') {
    await expect(mailboxes(page).getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    return;
  }
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(mailboxes(page)).toBeHidden(); // the drawer has finished closing
  const nav = await openSidebar(page);
  await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  await closeSidebar(page);
}

/** Choose a view the way each device does: the desktop sidebar, the tablet's icon rail (its links
 *  are named by their title there, e.g. "All mail, by priority"), the phone's drawer. */
async function chooseView(page: Page, name: 'All mail' | 'Priority matrix' | 'Sent') {
  const nav = test.info().project.name === 'phone' ? await openSidebar(page) : mailboxes(page);
  await press(nav.getByRole('link', { name: new RegExp(`^${name}`) }));
}

const allMailList = (page: Page) => page.getByRole('region', { name: 'All email by priority' });
const rowsOf = (list: Locator) => list.getByRole('article');
const row = (page: Page, subject: string) => page.getByRole('article').filter({ hasText: subject });
/** A row of the All mail list (an email open on a phone is an article too, while it slides away). */
const listRow = (page: Page, subject: string) => rowsOf(allMailList(page)).filter({ hasText: subject });
const box = (page: Page, name: 'Do now' | 'Schedule' | 'Quick reply' | 'Later') =>
  page.getByRole('region', { name, exact: true });
const openEmail = (page: Page) => page.getByRole('complementary', { name: 'Selected email' });
const backToList = (page: Page) => page.getByRole('link', { name: 'Back to the list' });
const pager = (page: Page) => page.getByRole('navigation', { name: 'More emails' });
const note = (page: Page, text: string | RegExp) => snackbar(page).filter({ hasText: text });

/** Nothing on the page can be scrolled sideways. */
async function expectNoSidewaysScroll(page: Page) {
  const [scrollW, viewW] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollW, 'page wider than the screen').toBeLessThanOrEqual(viewW);
}

/** The first ancestor that cuts part of this element off (overflow), or the screen edge; null if
 *  the whole element can be seen. */
async function cutOffBy(target: Locator) {
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    if (r.left < -1 || r.right > window.innerWidth + 1) return 'the screen edge';
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = p.getBoundingClientRect();
      if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) {
        return `${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''} (${Math.round(r.right - b.right)}px past its right edge)`;
      }
    }
    return null;
  });
}

/** An email's id, the way another device (or the background sorter) would know it. */
async function idOf(page: Page, subject: string) {
  const html = await (await page.request.get('/?view=all&q=' + encodeURIComponent(subject))).text();
  const m = html.match(/<article class="card row[^"]*" data-id="(\d+)"/);
  expect(m, `email "${subject}" exists`).not.toBeNull();
  return m![1];
}

/** Sort an email out of band, as the AI (or the app on another device) would while you look. */
async function sortElsewhere(page: Page, id: string, move: 'do' | 'schedule' | 'quick' | 'later') {
  const r = await page.request.post(`/message/${id}/score`, { form: { move }, headers: { Accept: 'application/json' } });
  expect(r.ok(), 'sorted in the background').toBe(true);
}

// --- writing mail (Compose is covered in depth by compose.spec.ts; these only get mail onto Sent)

const composeControl = (page: Page) =>
  page.getByRole('link', { name: /^Compose\b/ }).filter({ visible: true }).first();
const newMessage = (page: Page) => page.getByRole('form', { name: 'New message' });
function fields(form: Locator) {
  return {
    to: form.getByRole('textbox', { name: 'To', exact: true }),
    subject: form.getByRole('textbox', { name: 'Subject', exact: true }),
    body: form.getByRole('textbox', { name: 'Message', exact: true }),
  };
}
type Mail = { to: string; subject: string; body: string };
const MAIL: Mail = { to: 'alex@client.example', subject: 'Invoice hours', body: 'Yes, the extra design hours are on it.' };

async function composeAndSend(page: Page, mail: Mail = MAIL) {
  await press(composeControl(page));
  const form = newMessage(page);
  await expect(form).toBeVisible();
  const f = fields(form);
  await f.to.fill(mail.to);
  await f.subject.fill(mail.subject);
  await f.body.fill(mail.body);
  await press(form.getByRole('button', { name: 'Send', exact: true }));
  await expect(note(page, 'Sending…')).toBeVisible();
}

/** Close a compose window that came back with an undone email (its text stays as a draft). */
async function closeCompose(page: Page) {
  const form = newMessage(page);
  await press(form.getByRole('button', { name: 'Save & close' }));
  await expect(form).toBeHidden();
}

/** Send, then Undo from the "Sending…" snackbar; the compose window that reopens is closed. */
async function sendThenUndo(page: Page, mail: Mail = MAIL) {
  await composeAndSend(page, mail);
  await press(note(page, 'Sending…').getByRole('button', { name: 'Undo' }));
  await expect(note(page, 'Sending undone')).toBeVisible();
  await expect(fields(newMessage(page)).body).toHaveValue(mail.body);
  await closeCompose(page);
}

const sentList = (page: Page) => page.getByRole('main').getByRole('list');
const sentRow = (page: Page, subject: string) => page.getByRole('main').getByRole('listitem').filter({ hasText: subject });
const outboxStatus = async (page: Page, id: string) =>
  (await (await page.request.get(`/api/outbox/${id}`, { headers: { Accept: 'application/json' } })).json()).status;

// ---------------------------------------------------------------------------------------------
// All mail

// What ORDER in app/web/main.py gives for the demo mailbox: answered mail sinks to the bottom, then
// mail not sorted yet; otherwise the highest priority score first (0.6 × importance + 0.4 ×
// urgency, +1 for a deadline within 2 days, +0.5 when action is needed), newest first on a tie.
const ALL_MAIL_ORDER: [subject: string, label: string][] = [
  ['Contract renewal needs your signature today', 'Do now'], // 5/5 + deadline + action: 6.5
  ['Payment failed for velocity.example', 'Do now'], // 5/4 + action: 5.1
  ['Sunday lunch?', 'Schedule'], // 4/3 + action: 4.1
  ['Quick question about the invoice', 'Quick reply'], // 3/4 + action: 3.9
  ['Your OTP is 482913', 'Quick reply'], // 2/5: 3.2
  ['Your weekly team digest', 'Later'], // 1/2: 1.4
  ['Top stories for you', 'Later'], // 1/1: 1.0
  ['Trip photos', 'Not sorted'], // not sorted yet, newer
  ['Receipt from Velocity Growth', 'Not sorted'], // not sorted yet, older
  ['Q4 planning doc — comments welcome', 'Schedule'], // answered: last
];
const RANK: Record<string, number> = { 'Do now': 0, Schedule: 1, 'Quick reply': 2, Later: 3, 'Not sorted': 4 };

/** The priority label and subject of every row in a list, top to bottom. */
async function labelsAndSubjects(list: Locator) {
  const texts = await rowsOf(list).allTextContents();
  return texts.map((t) => ({
    label: t.match(/Do now|Schedule|Quick reply|Later|Not sorted/)?.[0] ?? '?',
    subject: t.match(/Subject number \d+ about something/)?.[0] ?? '?',
  }));
}

test.describe('All mail', () => {
  test('lists every email from every account, highest priority first and answered mail last', async ({ page }) => {
    await page.goto('/');
    await chooseView(page, 'All mail');
    await expect(page).toHaveURL(/\/\?view=all$/);
    await expectCurrentView(page, /^All mail/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('All mail');

    const rows = rowsOf(allMailList(page));
    await expect(rows).toHaveCount(ALL_MAIL_ORDER.length);
    await expect(rows).toContainText(ALL_MAIL_ORDER.map(([subject]) => subject));
    for (const [i, [subject, label]] of ALL_MAIL_ORDER.entries()) {
      await expect(rows.nth(i), `${subject} is labelled ${label}`).toContainText(label);
    }
    await expect(listRow(page, 'Q4 planning doc')).toContainText('Replied');
    // all three accounts are in the one list
    for (const account of ['Work', 'Velocity', 'Personal']) await expect(rows.filter({ hasText: account }).first()).toBeVisible();
    // no inbox tabs here: it's one list
    await expect(page.getByRole('navigation', { name: 'Inbox tabs' })).toHaveCount(0);
    await expectNoSidewaysScroll(page);
  });

  test('g then a opens All mail from the keyboard', async ({ page }) => {
    test.skip(!isDesktop(), 'single-key shortcuts are for a hardware keyboard (desktop)');
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Inbox tabs' })).toBeVisible();
    await page.keyboard.press('g');
    await page.keyboard.press('a');
    await expect(page).toHaveURL(/\/\?view=all$/);
    await expect(rowsOf(allMailList(page))).toHaveCount(10);
  });

  test('an account in the sidebar narrows All mail to that account', async ({ page }) => {
    await page.goto('/?view=all');
    const nav = await openSidebar(page);
    await press(nav.getByRole('link', { name: /^Velocity/ }));
    await expect(page).toHaveURL(/\/\?view=all&account=sam%40velocity\.example$/);
    const rows = rowsOf(allMailList(page));
    await expect(rows).toHaveCount(3);
    await expect(rows).toContainText(['Payment failed for velocity.example', 'Quick question about the invoice', 'Receipt from Velocity Growth']);
    await expect(page.getByRole('link', { name: 'Remove filter Velocity' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('All mail');
  });

  test('opening an email from All mail shows it, marks it read, and Back returns to All mail', async ({ page, isPhone }) => {
    await page.goto('/?view=all');
    const lunch = listRow(page, 'Sunday lunch?');
    await expect(lunch).toContainText('Unread:'); // read out before the sender
    await press(lunch.getByRole('link'));

    await expect(page).toHaveURL(/\/\?view=all&open=\d+$/);
    const email = openEmail(page);
    await expect(email.getByRole('heading', { name: 'Sunday lunch?' })).toBeVisible();
    await expect(email).toContainText('Are you coming on Sunday?');
    if (isPhone) {
      // the email covers the whole screen; the list beneath is out of reach
      const r = (await email.boundingBox())!;
      const vp = page.viewportSize()!;
      expect(Math.round(r.width)).toBe(vp.width);
      expect(Math.round(r.height)).toBeGreaterThanOrEqual(vp.height - 1);
      await expect(page.locator('#board')).toHaveJSProperty('inert', true);
    } else {
      // without the reading pane on the right, the email takes the list's place (like Gmail)
      await expect(allMailList(page)).toBeHidden();
    }

    await press(backToList(page));
    await expect(page).toHaveURL(/\/\?view=all$/);
    await expect(allMailList(page)).toBeVisible();
    await expect(lunch).not.toContainText('Unread:');
    await page.reload();
    await expect(lunch).not.toContainText('Unread:'); // the server remembers
  });

  test.describe('with 1,500 emails', () => {
    test.use({ mailbox: 'big' });

    test('shows 50 at a time; Older and Newer page through in priority order', async ({ page }) => {
      await page.goto('/?view=all');
      const list = allMailList(page);
      await expect(pager(page)).toContainText('1–50 of 1500');
      await expect(rowsOf(list)).toHaveCount(50);
      const first = await labelsAndSubjects(list);
      expect(first.every((r) => r.label === 'Do now'), 'page 1 is all Do now').toBe(true);

      // phones only have the arrows under the list; elsewhere the toolbar's come first
      await press(page.getByRole('link', { name: 'Older emails' }).filter({ visible: true }).first());
      await expect(page).toHaveURL(/\/\?view=all&after=\d+$/);
      await expect(pager(page)).toContainText('51–100 of 1500');
      await expect(rowsOf(list)).toHaveCount(50);
      const second = await labelsAndSubjects(list);
      // no email shows on both pages, and priority keeps going down across the page break
      const seen = new Set(first.map((r) => r.subject));
      expect(second.filter((r) => seen.has(r.subject)), 'emails on both pages').toEqual([]);
      const ranks = [...first, ...second].map((r) => RANK[r.label]);
      expect(ranks, 'priority never goes up').toEqual([...ranks].sort((a, b) => a - b));
      expect(second.some((r) => r.label === 'Schedule'), 'page 2 reaches Schedule').toBe(true);

      await press(page.getByRole('link', { name: 'Newer emails' }).filter({ visible: true }).first());
      await expect(page).toHaveURL(/\/\?view=all$/);
      await expect(pager(page)).toContainText('1–50 of 1500');
      await expect(rowsOf(list).first()).toContainText(first[0].subject);

      // the browser's Back goes back a page too
      await page.goBack();
      await expect(page).toHaveURL(/\/\?view=all&after=\d+$/);
      await expect(pager(page)).toContainText('51–100 of 1500');
      await expect(rowsOf(list).first()).toContainText(second[0].subject);
    });

    test('j on the last email of a page opens the first email of the next page', async ({ page }) => {
      test.skip(!isDesktop(), 'j / k are hardware-keyboard shortcuts (desktop)');
      await page.goto('/?view=all');
      const list = allMailList(page);
      await expect(rowsOf(list)).toHaveCount(50);
      const last = rowsOf(list).last();
      const lastSubject = (await labelsAndSubjects(list))[49].subject;
      await last.getByRole('link').click();
      await expect(openEmail(page).getByRole('heading', { name: lastSubject })).toBeVisible();

      await page.keyboard.press('j');
      await expect(page).toHaveURL(/\/\?view=all&open=\d+&after=\d+$/);
      const heading = openEmail(page).getByRole('heading', { level: 2 });
      await expect(heading).not.toHaveText(lastSubject);
      const opened = await heading.innerText();

      await page.keyboard.press('u');
      await expect(page).toHaveURL(/\/\?view=all&after=\d+$/);
      await expect(pager(page)).toContainText('51–100 of 1500');
      await expect(rowsOf(list).first()).toContainText(opened);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Priority matrix

// app/ai/scoring.py quadrant(): importance ≥ 4 is important, urgency ≥ 4 is urgent.
const BOXES = {
  'Do now': ['Contract renewal needs your signature today', 'Payment failed for velocity.example'], // 5/5, 5/4
  Schedule: ['Sunday lunch?', 'Q4 planning doc — comments welcome'], // 4/3, 4/2
  'Quick reply': ['Quick question about the invoice', 'Your OTP is 482913'], // 3/4, 2/5
  Later: ['Your weekly team digest', 'Top stories for you'], // 1/2, 1/1
} as const;
const NOT_SORTED = ['Trip photos', 'Receipt from Velocity Growth'];

test.describe('Priority matrix', () => {
  test('the four boxes hold the right emails, with their counts', async ({ page, isPhone }) => {
    await page.goto('/');
    await chooseView(page, 'Priority matrix');
    await expect(page).toHaveURL(/\/\?view=matrix$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Priority matrix');
    await expectCurrentView(page, /^Priority matrix/);

    // Later starts folded: open it to see its emails
    await press(box(page, 'Later').getByRole('heading', { name: 'Later' }));
    for (const [name, subjects] of Object.entries(BOXES) as [keyof typeof BOXES, readonly string[]][]) {
      const cards = box(page, name).getByRole('article');
      await expect(cards, name).toHaveCount(subjects.length);
      await expect(cards, name).toContainText([...subjects]);
      for (const s of NOT_SORTED) await expect(box(page, name)).not.toContainText(s);
    }
    // "2 new · 2": unread of total, spelled out for screen readers
    await expect(box(page, 'Do now').getByText(/unread of/)).toHaveText('2 unread of 2');
    await expect(box(page, 'Schedule').getByText(/unread of/)).toHaveText('1 unread of 2');
    await expect(box(page, 'Quick reply').getByText(/unread of/)).toHaveText('2 unread of 2');
    await expect(box(page, 'Later').getByText(/unread of/)).toHaveText('0 unread of 2');
    // the toolbar counts every email, sorted or not (phones leave the count out)
    if (isPhone) await expect(page.getByText('10 emails')).toBeHidden();
    else await expect(page.getByText('10 emails')).toBeVisible();
  });

  test('mail not sorted yet is a progress strip, and Review lists it', async ({ page }) => {
    await page.goto('/?view=matrix');
    const strip = page.getByRole('region', { name: 'Sorting your mail' });
    await expect(strip).toBeVisible();
    await expect(strip.getByRole('progressbar', { name: 'Sorting progress' })).toHaveAttribute('aria-valuetext', '8 of 10 sorted');
    await expect(strip).toContainText('Needs ≈1 AI call · 50 left today');

    await press(strip.getByRole('link', { name: 'Review' }));
    await expect(page).toHaveURL(/\/\?tab=unsorted$/);
    const tab = page.getByRole('navigation', { name: 'Inbox tabs' }).getByRole('link', { name: /Not sorted/ });
    await expect(tab).toHaveAttribute('aria-current', 'page');
    const list = page.getByRole('region', { name: 'Not sorted yet' }).getByRole('article');
    await expect(list).toHaveCount(2);
    await expect(list).toContainText(NOT_SORTED);
  });

  test('Later starts folded; opening it is remembered after a reload', async ({ page }) => {
    await page.goto('/?view=matrix');
    const later = box(page, 'Later');
    const header = later.getByRole('heading', { name: 'Later' });
    await expect(later.getByRole('group')).not.toHaveAttribute('open');
    await expect(later.getByRole('article')).toHaveCount(0); // folded away
    await press(header);
    await expect(later.getByRole('article')).toHaveCount(2);

    await page.reload();
    await expect(later.getByRole('article')).toHaveCount(2);
    await press(header);
    await expect(later.getByRole('article')).toHaveCount(0);
    await page.reload();
    await expect(later.getByRole('article')).toHaveCount(0);
    await expect(box(page, 'Do now').getByRole('article')).toHaveCount(2); // the others stay open
  });

  test('a card opens its email, and Back returns to the matrix', async ({ page, isPhone }) => {
    await page.goto('/?view=matrix');
    const card = box(page, 'Quick reply').getByRole('article').filter({ hasText: 'Your OTP is 482913' });
    await press(card.getByRole('link'));
    await expect(page).toHaveURL(/\/\?view=matrix&open=\d+$/);
    const email = openEmail(page);
    await expect(email.getByRole('heading', { name: 'Your OTP is 482913' })).toBeVisible();
    await expect(email).toContainText('482913 is your one-time password');
    if (!isPhone) await expect(box(page, 'Do now')).toBeHidden(); // the email takes the board's place

    await press(backToList(page));
    await expect(page).toHaveURL(/\/\?view=matrix$/);
    await expect(box(page, 'Do now')).toBeVisible();
    await expect(box(page, 'Quick reply').getByRole('article').filter({ hasText: 'Your OTP' })).toBeVisible();
  });

  test('reading an email updates the box\'s unread count, for screen readers too', async ({ page, isPhone }) => {
    await page.goto('/?view=matrix');
    const doNow = box(page, 'Do now');
    await press(doNow.getByRole('article').filter({ hasText: 'Contract renewal' }).getByRole('link'));
    await expect(openEmail(page).getByRole('heading', { name: 'Contract renewal needs your signature today' })).toBeVisible();
    await press(backToList(page));
    await expect(doNow).toBeVisible();
    await expect(doNow.getByText('1 new')).toBeVisible(); // what you see
    await expect(doNow.getByText(/unread of/)).toHaveText('1 unread of 2'); // what VoiceOver says
    if (isPhone) {
      await expect(page.getByRole('navigation', { name: 'Quadrants' }).getByRole('link', { name: /^Do now, / }))
        .toHaveAccessibleName('Do now, 1 unread of 2');
    }
    await page.reload();
    await expect(doNow.getByText(/unread of/)).toHaveText('1 unread of 2');
  });

  test('phone: one column that fits the screen, with the Quadrants dock; wider screens: two columns', async ({ page, isPhone }) => {
    await page.goto('/?view=matrix');
    const boxes = (['Do now', 'Schedule', 'Quick reply', 'Later'] as const).map((n) => box(page, n));
    const rects = [];
    for (const b of boxes) rects.push((await b.boundingBox())!);
    const vw = page.viewportSize()!.width;
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(vw);
    }
    await expectNoSidewaysScroll(page);
    const dock = page.getByRole('navigation', { name: 'Quadrants' });
    if (isPhone) {
      // stacked: same left edge and width, each below the one before
      for (const r of rects.slice(1)) {
        expect(Math.round(r.x)).toBe(Math.round(rects[0].x));
        expect(Math.round(r.width)).toBe(Math.round(rects[0].width));
      }
      for (let i = 1; i < rects.length; i++) expect(rects[i].y).toBeGreaterThan(rects[i - 1].y);
      // nothing in the cards is cut off
      for (const card of await page.getByRole('article').all()) expect(await cutOffBy(card)).toBeNull();

      await expect(dock).toBeVisible();
      const later = dock.getByRole('link', { name: /^Later, / });
      await expect(later).toHaveAccessibleName('Later, 0 unread of 2');
      await press(later);
      await expect(page).toHaveURL(/\/\?view=matrix#col-later$/);
      await expect(later).toHaveAttribute('aria-current', 'location');
      await expect(box(page, 'Later').getByRole('article')).toHaveCount(2); // the folded box opens
      await expect(box(page, 'Later').getByRole('heading', { name: 'Later' })).toBeInViewport();
    } else {
      // Do now | Schedule on top, Quick reply | Later below
      expect(Math.round(rects[1].y)).toBe(Math.round(rects[0].y));
      expect(rects[1].x).toBeGreaterThan(rects[0].x + rects[0].width - 1);
      expect(Math.round(rects[2].x)).toBe(Math.round(rects[0].x));
      expect(rects[2].y).toBeGreaterThan(rects[0].y);
      await expect(dock).toBeHidden();
    }
  });

  test.describe('with 1,500 emails', () => {
    test.use({ mailbox: 'big' });

    test('a full box shows six, opens the rest with "Show N more", and links to the full list', async ({ page }) => {
      await page.goto('/?view=matrix');
      const schedule = box(page, 'Schedule');
      const cards = schedule.getByRole('article');
      await expect(cards).toHaveCount(6);
      await expect(schedule).toContainText(/Showing 100 of \d+/);

      const more = schedule.getByText(/^Show \d+ more$/).filter({ visible: true }); // wide and narrow wordings
      const n = Number((await more.innerText()).match(/\d+/)![0]);
      await press(more);
      await expect(cards).toHaveCount(6 + n);
      await expect(schedule.getByText('Show fewer')).toBeVisible();

      await press(schedule.getByRole('link', { name: 'See all in List' }));
      await expect(page).toHaveURL(/\/\?view=list$/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('All mail');
      await expect(pager(page)).toContainText('1–50 of 1500');
      await expectNoSidewaysScroll(page);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Sent

test.describe('Sent', () => {
  test('starts empty, with a way to write an email', async ({ page, isPhone }) => {
    await page.goto('/');
    await chooseView(page, 'Sent');
    await expect(page).toHaveURL(/\/sent$/);
    await expect(page).toHaveTitle(/Sent · Unified Inbox$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sent' })).toBeVisible();
    await expectCurrentView(page, /^Sent/);
    await expect(page.getByRole('heading', { name: 'Nothing sent yet' })).toBeVisible();
    await expect(page.getByText('Write a new email with Compose, or open an email and press Reply.')).toBeVisible();
    // the page's own Compose button, or (phone) the round one bottom right
    const compose = page.getByRole('main').getByRole('link', { name: 'Compose' });
    if (isPhone) await expect(compose).toBeHidden();
    else await expect(compose).toBeVisible();
    await press(composeControl(page));
    await expect(newMessage(page)).toBeVisible();
    await expectNoSidewaysScroll(page);
  });

  test('an email shows on Sent as "Sending…" with Undo, then plainly once it has gone', async ({ page, sentMail }) => {
    await page.goto('/');
    await composeAndSend(page);
    await chooseView(page, 'Sent');
    await expect(page).toHaveURL(/\/sent$/);
    const item = sentRow(page, MAIL.subject);
    await expect(item).toContainText('To: alex@client.example');
    await expect(item).toContainText('from sam@gmail.com');
    await expect(item).toContainText(MAIL.body);
    await expect(item).toContainText('Sending…');
    await expect(item.getByRole('button', { name: 'Undo' })).toBeVisible();

    const id = (await item.getAttribute('id'))!.replace(/^s/, '');
    await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
    const [m] = await sentMail();
    expect(m).toMatchObject({ from: 'sam@gmail.com', to: 'alex@client.example', subject: MAIL.subject, in_reply_to: null });
    expect(m.body.trim()).toBe(MAIL.body);

    await expect.poll(() => outboxStatus(page, id)).toBe('sent');
    await page.reload();
    await expect(item).toBeVisible();
    await expect(item).not.toContainText('Sending…');
    await expect(item.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Nothing sent yet' })).toHaveCount(0);
    // opening the row shows the whole email
    await press(item.getByText(MAIL.subject));
    await expect(item.getByText(MAIL.body, { exact: true })).toBeVisible();
  });

  // APP BUG: sending from the Sent page's own Compose leaves "Nothing sent yet" until a reload
  test('an email written on Sent appears in the list straight away', async ({ page }) => {
    await page.goto('/sent');
    await expect(page.getByRole('heading', { name: 'Nothing sent yet' })).toBeVisible();
    await composeAndSend(page);
    const item = sentRow(page, MAIL.subject);
    await expect(item).toBeVisible({ timeout: 4_000 });
    await expect(item).toContainText('Sending…');
    await expect(page.getByRole('heading', { name: 'Nothing sent yet' })).toHaveCount(0);
  });

  // APP BUG: on Sent, a row keeps saying "Sending…" with Undo after "Message sent"
  test('the Sent list stops saying "Sending…" once the email has gone', async ({ page, sentMail }) => {
    await page.goto('/');
    await composeAndSend(page);
    await press(note(page, 'Sending…').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const item = sentRow(page, MAIL.subject);
    await expect(item).toContainText('Sending…');

    await expect(note(page, 'Message sent')).toBeVisible({ timeout: 20_000 });
    expect(await sentMail()).toHaveLength(1);
    await expect(item).not.toContainText('Sending…');
    await expect(item.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  });

  test('View in the "Sending…" snackbar opens that email on Sent', async ({ page }) => {
    await page.goto('/');
    await composeAndSend(page);
    await press(note(page, 'Sending…').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const item = sentRow(page, MAIL.subject);
    await expect(item.getByRole('group')).toHaveAttribute('open');
    await expect(item.getByText(MAIL.body, { exact: true })).toBeVisible(); // the full text
    await expect(item).toBeInViewport();
    // the Undo time carries on here
    await expect(note(page, 'Sending…').getByRole('button', { name: 'Undo' })).toBeVisible();
  });

  // APP BUG: "View" focuses the opened email, but the browser's jump to #sN takes focus away again
  test('View in the "Sending…" snackbar puts keyboard focus on the opened email', async ({ page }) => {
    await page.goto('/');
    await composeAndSend(page);
    await press(note(page, 'Sending…').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const item = sentRow(page, MAIL.subject);
    await expect(item.getByRole('group')).toHaveAttribute('open');
    // <summary> has no role Playwright can find it by
    await expect(item.locator('summary')).toBeFocused();
  });

  test('Undo on the Sent page stops the email and brings it back to edit', async ({ page, sentMail }) => {
    await page.goto('/');
    await composeAndSend(page);
    await press(note(page, 'Sending…').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const id = page.url().match(/#s(\d+)$/)![1];
    const item = sentRow(page, MAIL.subject);
    await press(item.getByRole('button', { name: 'Undo' }));

    await expect(note(page, 'Sending undone')).toBeVisible();
    await expect(note(page, 'Sending…')).toHaveCount(0);
    // the email comes back in a compose window, ready to change
    const f = fields(newMessage(page));
    await expect(f.to).toHaveValue(MAIL.to);
    await expect(f.subject).toHaveValue(MAIL.subject);
    await expect(f.body).toHaveValue(MAIL.body);
    expect(await outboxStatus(page, id)).toBe('cancelled');

    await closeCompose(page);
    await expect(item).toContainText('Undone');
    await expect(item.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await expect(item.getByRole('link', { name: 'Edit' })).toBeVisible();
    await expect(item.getByRole('button', { name: 'Discard' })).toBeVisible();
    await page.reload();
    await expect(item).toContainText('Undone');
    expect(await sentMail()).toEqual([]);
  });

  test('z on the Sent page undoes the email still waiting to go', async ({ page }) => {
    test.skip(!isDesktop(), 'z is a hardware-keyboard shortcut (desktop)');
    await page.goto('/');
    await composeAndSend(page);
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/sent$/);
    const item = sentRow(page, MAIL.subject);
    await expect(item).toContainText('Sending…');
    await page.keyboard.press('z');
    await expect(note(page, 'Sending undone')).toBeVisible();
    await expect(fields(newMessage(page)).body).toHaveValue(MAIL.body);
    await page.keyboard.press('Escape'); // closes the window, keeping the text
    await expect(newMessage(page)).toBeHidden();
    await expect(item).toContainText('Undone');
  });

  test('an undone email can be edited from Sent and sent again', async ({ page, sentMail }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await sendThenUndo(page);
    await chooseView(page, 'Sent');
    const item = sentRow(page, MAIL.subject);
    await expect(item).toContainText('Undone');
    const edit = item.getByRole('link', { name: 'Edit' });
    await expect(edit).toHaveAttribute('href', /^\/compose\?draft=\d+&next=\/sent$/);
    await press(edit);

    const form = newMessage(page);
    const f = fields(form);
    await expect(f.to).toHaveValue(MAIL.to);
    await expect(f.subject).toHaveValue(MAIL.subject);
    await expect(f.body).toHaveValue(MAIL.body);
    await f.body.fill('Second version: the extra hours are on it.');
    await press(form.getByRole('button', { name: 'Send', exact: true }));
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(note(page, 'Message sent')).toBeVisible({ timeout: 20_000 });

    // only the second version ever went out
    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: MAIL.to, subject: MAIL.subject });
    expect(sent[0].body.trim()).toBe('Second version: the extra hours are on it.');
    // and Sent lists it once, sent, with the undone copy gone
    await page.reload();
    await expect(sentRow(page, MAIL.subject)).toHaveCount(1);
    await expect(item).not.toContainText('Undone');
    await expect(item).toContainText('Second version');
  });

  test('/compose?draft=ID opens an undone email as a full page to fix and resend', async ({ page, sentMail }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await sendThenUndo(page);
    await page.goto('/sent');
    const href = await sentRow(page, MAIL.subject).getByRole('link', { name: 'Edit' }).getAttribute('href');
    const draftId = href!.match(/draft=(\d+)/)![1];

    await page.goto(`/compose?draft=${draftId}&next=/sent`);
    await expect(page.getByRole('heading', { level: 1, name: 'New message' })).toBeVisible();
    const form = newMessage(page);
    const f = fields(form);
    await expect(f.to).toHaveValue(MAIL.to);
    await expect(f.body).toHaveValue(MAIL.body);
    await f.subject.fill('Invoice hours (fixed)');
    await press(form.getByRole('button', { name: 'Send', exact: true }));

    await expect(page).toHaveURL(/\/sent$/);
    const resent = sentRow(page, 'Invoice hours (fixed)');
    await expect(resent).toContainText('Sending…');
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(sentRow(page, MAIL.subject)).toHaveCount(1); // the undone copy was replaced
    await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
    expect((await sentMail())[0]).toMatchObject({ to: MAIL.to, subject: 'Invoice hours (fixed)' });

    // the old draft is gone: its link now opens an empty message
    await page.goto(`/compose?draft=${draftId}&next=/sent`);
    await expect(fields(newMessage(page)).to).toHaveValue('');
    await expect(fields(newMessage(page)).body).toHaveValue('');
  });

  test('Discard removes an undone email for good', async ({ page, sentMail }) => {
    await page.goto('/');
    await sendThenUndo(page);
    await chooseView(page, 'Sent');
    const item = sentRow(page, MAIL.subject);
    const id = (await item.getByRole('link', { name: 'Edit' }).getAttribute('href'))!.match(/draft=(\d+)/)![1];
    await press(item.getByRole('button', { name: 'Discard' }));
    await expect(note(page, 'Discarded')).toBeVisible();
    await expect(item).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Nothing sent yet' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Nothing sent yet' })).toBeVisible();
    const gone = await page.request.get(`/api/outbox/${id}`, { headers: { Accept: 'application/json' } });
    expect(gone.status()).toBe(404);
    expect(await sentMail()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Sync now and the status line

test.describe('Sync', () => {
  test('Refresh syncs: busy while it runs, then "Up to date" and a note, with the list kept', async ({ page }) => {
    await page.goto('/?view=all');
    const btn = page.getByRole('button', { name: 'Refresh' });
    const label = page.locator('.sync-label'); // no accessible name of its own (see top)
    await press(btn);
    await expect(btn).toHaveAttribute('aria-busy', 'true');
    await expect(label).toHaveText('Syncing…');
    await expect(note(page, /^Sync done/)).toBeVisible();
    await expect(btn).not.toHaveAttribute('aria-busy');
    await expect(label).toHaveText('Up to date');
    await expect(label).toHaveText('Sync now', { timeout: 5_000 });
    // the page is refreshed in place and still shows the same mail
    await expect(page).toHaveURL(/\/\?view=all$/);
    await expect(rowsOf(allMailList(page))).toHaveCount(10);
  });

  test('after a sync, the status line says when each account last synced and the AI budget', async ({ page }) => {
    await page.goto('/');
    await press(page.getByRole('button', { name: 'Refresh' }));
    await expect(note(page, /^Sync done/)).toBeVisible();

    const nav = await openSidebar(page);
    // (the fake sync doesn't change when the accounts last synced, so the time stays as seeded)
    const status = nav.getByText(/^Updated \d+ min ago$/);
    await expect(status).toBeVisible();
    await press(status);
    const menu = page.locator('#status'); // the summary's pop-up has no accessible name
    await expect(menu).toBeVisible();
    for (const account of ['Personal', 'Work', 'Velocity']) {
      await expect(menu.getByRole('listitem').filter({ hasText: account })).toContainText(/synced \d+ min ago/);
    }
    await expect(menu).toContainText('AI calls today: 0 / 50');
    await expect(nav.getByText(/problem/)).toHaveCount(0); // no account failed
  });

  // APP BUG: the status pop-up is wider than the sidebar it sits in, so its right side is cut off
  test('the status pop-up fits inside the sidebar', async ({ page }) => {
    await page.goto('/');
    const nav = await openSidebar(page);
    await press(nav.getByText(/^Updated \d+ min ago$/));
    const menu = page.locator('#status');
    await expect(menu).toBeVisible();
    await expect(menu.getByText('AI calls today: 0 / 50')).toBeVisible();
    expect(await cutOffBy(menu), 'the status pop-up is cut off').toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// "N newly sorted" pill (app.js applyStats: /api/stats every 2 s after load, then every 15 s
// while mail waits to be sorted)

test.describe('Newly sorted pill', () => {
  test('mail sorted in the background shows "1 newly sorted · Show", and Show brings it in', async ({ page }) => {
    test.setTimeout(60_000);
    const trip = await idOf(page, 'Trip photos');
    await page.goto('/?view=matrix');
    const strip = page.getByRole('region', { name: 'Sorting your mail' });
    await expect(strip.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '8 of 10 sorted');
    await sortElsewhere(page, trip, 'later');

    // the board isn't swapped under the reader: a pill offers the change
    const pill = page.getByRole('button', { name: '1 newly sorted · Show' });
    await expect(pill).toBeVisible({ timeout: 20_000 });
    expect(await cutOffBy(pill)).toBeNull();
    await expect(box(page, 'Later').getByText(/unread of/)).toHaveText('0 unread of 2'); // not yet
    await press(pill);
    await expect(pill).toBeHidden();
    await expect(strip.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '9 of 10 sorted');
    await expect(box(page, 'Later').getByText(/unread of/)).toHaveText('1 unread of 3');
    await press(box(page, 'Later').getByRole('heading', { name: 'Later' }));
    await expect(box(page, 'Later').getByRole('article').filter({ hasText: 'Trip photos' })).toBeVisible();
  });

  test('when the last email is sorted, the strip goes and "All 10 emails sorted" shows', async ({ page }) => {
    test.setTimeout(60_000);
    const ids = [await idOf(page, 'Trip photos'), await idOf(page, 'Receipt from Velocity Growth')];
    const firstPoll = page.waitForResponse((r) => r.url().endsWith('/api/stats'));
    await page.goto('/?view=matrix');
    await firstPoll; // the page has seen 2 waiting
    for (const id of ids) await sortElsewhere(page, id, 'later');

    await expect(note(page, 'All 10 emails sorted')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('region', { name: 'Sorting your mail' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /newly sorted/ })).toBeHidden();
    await expect(box(page, 'Later').getByText(/unread of/)).toHaveText('1 unread of 4');
  });
});

// ---------------------------------------------------------------------------------------------
// Error page

test.describe('Error page', () => {
  test('an unknown address shows a friendly 404 with a way back to the inbox', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 404/);
    const res = await page.goto('/no/such/page');
    expect(res!.status()).toBe(404);
    await expect(page).toHaveTitle('404 · Unified Inbox');
    await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
    await expect(page.getByText('Not Found')).toBeVisible();
    await expectNoSidewaysScroll(page);
    await press(page.getByRole('link', { name: 'Back to the inbox' }));
    await expect(page).toHaveURL(/\/$/);
    await expect(row(page, 'Contract renewal needs your signature today')).toBeVisible();
  });

  test('a missing email (/message/999999) shows "Message not found" with a way back', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 404/);
    const res = await page.goto('/message/999999');
    expect(res!.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: '404' })).toBeVisible();
    await expect(page.getByText('Message not found')).toBeVisible();
    await expectNoSidewaysScroll(page);
    await press(page.getByRole('link', { name: 'Back to the inbox' }));
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('navigation', { name: 'Inbox tabs' })).toBeVisible();
    // programs asking for JSON get JSON, not the page
    const api = await page.request.get('/message/999999', { headers: { Accept: 'application/json' } });
    expect(api.status()).toBe(404);
    expect(await api.json()).toEqual({ detail: 'Message not found' });
  });

  test('an email that exists still opens on its own page', async ({ page }) => {
    const id = await idOf(page, 'Sunday lunch?');
    const res = await page.goto(`/message/${id}`);
    expect(res!.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Sunday lunch?' })).toBeVisible();
    await press(page.getByRole('link', { name: 'Back to Inbox' }));
    await expect(page).toHaveURL(/\/$/);
  });

  // APP BUG: a malformed email address (/message/abc) shows raw JSON instead of the error page
  test('a malformed email link (/message/abc) shows the friendly error page too', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 4\d\d/);
    const res = await page.goto('/message/abc');
    expect([404, 422]).toContain(res!.status());
    await expect(page.getByRole('link', { name: 'Back to the inbox' })).toBeVisible();
    await expect(page.getByText('int_parsing')).toHaveCount(0);
  });
});
