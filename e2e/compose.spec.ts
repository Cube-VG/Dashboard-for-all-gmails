// Writing new mail and Undo send, on a desktop, a phone and a tablet: the Compose window (a
// floating window on desktop and tablet, a full-screen sheet on a phone), From / To / Cc / Bcc,
// the checks before sending, drafts kept on this device, minimise / full screen / close, and
// Send → "Sending… Undo" → "Message sent", checked against what the fake mail server received.
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - "Draft saved" / "Draft restored" is a bare <span aria-live>: found by its text.
// - The minimised window's title bar brings it back on click, but it isn't a button (no role,
//   not focusable): keyboard users have to use Minimize again.
// - Whether the page behind the phone's full-screen sheet is reachable is read from `inert`.
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar } from './fixtures';

// ---------------------------------------------------------------------------------------------
// helpers

/** Phones and tablets are touched, the desktop is clicked. */
const touch = () => test.info().project.name !== 'desktop';
async function press(target: Locator) {
  if (touch()) await target.tap();
  else await target.click();
}

/** The Compose control a user sees: the button bottom right (phone), the top of the sidebar
 * (desktop) or of the tablet's icon rail ("Compose (c)", named by its title there). */
const composeControl = (page: Page) =>
  page.getByRole('link', { name: /^Compose\b/ }).filter({ visible: true }).first();

const newMessage = (page: Page) => page.getByRole('form', { name: 'New message' });

function fields(form: Locator) {
  return {
    from: form.getByLabel('From'),
    to: form.getByRole('textbox', { name: 'To', exact: true }),
    cc: form.getByRole('textbox', { name: 'Cc', exact: true }),
    bcc: form.getByRole('textbox', { name: 'Bcc', exact: true }),
    subject: form.getByRole('textbox', { name: 'Subject', exact: true }),
    body: form.getByRole('textbox', { name: 'Message', exact: true }),
  };
}
const sendButton = (form: Locator) => form.getByRole('button', { name: 'Send', exact: true });
const ccLink = (form: Locator) => form.getByRole('button', { name: 'Cc', exact: true });
const bccLink = (form: Locator) => form.getByRole('button', { name: 'Bcc', exact: true });
/** A snackbar saying `text` (several can be up at once: "Sending…" stays while others come). */
const note = (page: Page, text: string | RegExp) => snackbar(page).filter({ hasText: text });
const sendingUndo = (page: Page) => note(page, 'Sending…').getByRole('button', { name: 'Undo' });

/** The window / sheet has finished rising into place. */
async function atRest(form: Locator) {
  await expect.poll(() => form.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
}

async function openNewMessage(page: Page) {
  await press(composeControl(page));
  const form = newMessage(page);
  await expect(form).toBeVisible();
  await atRest(form);
  return form;
}

/** Compose again while a message is already open (minimised): on a phone the floating button
 * is under the minimised bar, so it's the menu's Compose there. */
async function composeAgain(page: Page, isPhone: boolean) {
  if (isPhone) {
    await press(page.getByRole('button', { name: 'Main menu' }));
    await press(page.getByRole('navigation', { name: 'Mailboxes' }).getByRole('link', { name: /^Compose\b/ }));
  } else {
    await press(composeControl(page));
  }
}

type Draft = { from?: string; to?: string; cc?: string; bcc?: string; subject?: string; body?: string };
async function fillIn(form: Locator, d: Draft) {
  const f = fields(form);
  if (d.from) await f.from.selectOption(d.from);
  if (d.to !== undefined) await f.to.fill(d.to);
  if (d.cc !== undefined || d.bcc !== undefined) {
    if (!(await f.cc.isVisible())) await press(ccLink(form));
    if (d.cc !== undefined) await f.cc.fill(d.cc);
    if (d.bcc !== undefined) await f.bcc.fill(d.bcc);
  }
  if (d.subject !== undefined) await f.subject.fill(d.subject);
  if (d.body !== undefined) await f.body.fill(d.body);
}
async function expectFilledIn(form: Locator, d: Draft) {
  const f = fields(form);
  if (d.from) await expect(f.from).toHaveValue(d.from);
  for (const k of ['to', 'cc', 'bcc', 'subject', 'body'] as const) {
    if (d[k] === undefined) continue;
    await expect(f[k], `${k} is still there`).toBeVisible();
    await expect(f[k], `${k} is still there`).toHaveValue(d[k]!);
  }
}

/** Mail written here, as the Sent page lists it (newest first): what was queued, sent or undone. */
async function outbox(page: Page) {
  const html = await (await page.request.get('/sent')).text();
  return [...html.matchAll(/<li class="sent-item (\w+)" id="s\d+">[\s\S]*?<b>([^<]*)<\/b>/g)]
    .map((m) => ({ status: m[1], subject: m[2] }));
}

/** Answers every confirm() the page asks; `accept` can be flipped mid-test. */
function dialogs(page: Page, accept = false) {
  const d = { accept, asked: [] as string[] };
  page.on('dialog', (dialog) => {
    d.asked.push(dialog.message());
    void (d.accept ? dialog.accept() : dialog.dismiss());
  });
  return d;
}

const isInert = (l: Locator) => l.evaluate((el) => !!el.closest('[inert]'));
const storedDraft = (page: Page) => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('draft:new:new') || 'null'); } catch { return 'unreadable'; }
});

const LETTER: Required<Draft> = {
  from: 'sam.work@gmail.com',
  to: 'Pat Doe <pat@example.com>, lee@example.com',
  cc: 'kim@example.com',
  bcc: 'boss@example.com',
  subject: 'Plans for Friday',
  body: 'Hi both,\n\nLunch at 1 on Friday?\n\nSam',
};

// ---------------------------------------------------------------------------------------------
// opening a new message

test.describe('Opening a new message', () => {
  test('Compose opens a floating window on desktop and tablet, a full-screen sheet on a phone', async ({ page, isPhone }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await expect(form.getByText('New message', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(fields(form).to).toBeFocused();
    const { width, height } = page.viewportSize()!;
    const box = (await form.boundingBox())!;
    const behind = page.getByRole('searchbox', { name: 'Search mail' });
    if (isPhone) {
      // the whole screen, sliding up from the bottom; the inbox behind can't be reached
      expect(box).toEqual({ x: 0, y: 0, width, height });
      await expect(form.getByRole('button', { name: 'Full screen' })).toBeHidden();
      expect(await isInert(behind), 'the page behind the sheet is out of reach').toBe(true);
    } else {
      // Gmail's window: 560 wide, bottom right, the inbox still usable beside it
      expect(box.width).toBe(560);
      expect(box.x + box.width).toBeCloseTo(width - 16, 0);
      expect(box.y + box.height).toBeCloseTo(height, 0);
      await expect(form.getByRole('button', { name: 'Full screen' })).toBeVisible();
      expect(await isInert(behind), 'the page next to the window still works').toBe(false);
      await expect(page.getByRole('article').filter({ hasText: 'Contract renewal needs your signature today' })).toBeVisible();
    }
    for (const name of ['Minimize', 'Save & close', 'Discard draft']) {
      await expect(form.getByRole('button', { name })).toBeVisible();
    }
    await expect(sendButton(form)).toBeVisible();
    // nothing sticks out sideways
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth)).toBeLessThanOrEqual(width);
  });

  test('the c key opens a new message, and what you type straight away lands in To', async ({ page, isPhone }) => {
    test.skip(isPhone, 'Single-key shortcuts need a keyboard; on a phone it is the Compose button (tested above)');
    await page.goto('/');
    await expect(page.getByRole('article').first()).toBeVisible();
    await page.keyboard.press('c');
    await page.keyboard.type('pat@example.com'); // typed before the window has arrived
    const form = newMessage(page);
    await expect(form).toBeVisible();
    await expect(fields(form).to).toHaveValue('pat@example.com');
    await expect(fields(form).to).toBeFocused();
    await expect(page).toHaveURL(/\/$/);
  });

  test('From offers every account, the first one picked', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const from = fields(form).from;
    await expect(from.locator('option')).toHaveText([
      'Personal <sam@gmail.com>', 'Work <sam.work@gmail.com>', 'Velocity <sam@velocity.example>']);
    await expect(from).toHaveValue('sam@gmail.com');
    await from.selectOption({ label: 'Velocity <sam@velocity.example>' });
    await expect(from).toHaveValue('sam@velocity.example');
  });

  test('the Cc link reveals the Cc and Bcc fields and puts the cursor in Cc', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await expect(f.cc).toBeHidden();
    await expect(f.bcc).toBeHidden();
    await press(ccLink(form));
    await expect(f.cc).toBeVisible();
    await expect(f.bcc).toBeVisible();
    await expect(f.cc).toBeFocused();
    await expect(ccLink(form)).toBeHidden(); // the links have done their job
    await expect(bccLink(form)).toBeHidden();
  });

  // Was a bug, now fixed: the Bcc link puts the cursor in Cc, so a "hidden" address typed next goes to Cc, visible to everyone
  test('the Bcc link puts the cursor in Bcc', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await press(bccLink(form));
    await expect(f.bcc).toBeVisible();
    await expect(f.bcc).toBeFocused();
    await page.keyboard.type('secret@example.com');
    await expect(f.bcc).toHaveValue('secret@example.com');
    await expect(f.cc).toHaveValue('');
  });
});

// ---------------------------------------------------------------------------------------------
// checks before sending

test.describe('Checks before sending', () => {
  test('no recipient: it says so, points at To, sends nothing and keeps the text', async ({ page, sentMail }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await fillIn(form, { subject: 'Hello', body: 'Nobody to send this to yet' });
    await press(sendButton(form));
    const err = note(page, 'Add at least one recipient.');
    await expect(err).toBeVisible();
    await expect(err).toHaveRole('alert');
    await expect(f.to).toHaveAttribute('aria-invalid', 'true');
    await expect(f.to).toBeFocused();
    await expectFilledIn(form, { subject: 'Hello', body: 'Nobody to send this to yet' });
    expect(await outbox(page)).toEqual([]);
    expect(await sentMail()).toEqual([]);
    // typing an address clears the mark
    await f.to.fill('pat@example.com');
    await expect(f.to).not.toHaveAttribute('aria-invalid', 'true');
  });

  test("an address that isn't one: it names it, points at the field, sends nothing", async ({ page, sentMail, allowErrors }) => {
    allowErrors.push(/status of 400/); // the server turns it down (400), which the browser logs
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await fillIn(form, { to: 'pat@example', subject: 'Hello', body: 'Typo in the address' });
    await press(sendButton(form));
    const err = note(page, 'To: “pat@example” isn\'t an email address.');
    await expect(err).toBeVisible();
    await expect(err).toHaveRole('alert');
    await expect(f.to).toHaveAttribute('aria-invalid', 'true');
    await expect(f.to).toBeFocused();
    await expectFilledIn(form, { to: 'pat@example', subject: 'Hello', body: 'Typo in the address' });
    expect(await outbox(page)).toEqual([]);
    expect(await sentMail()).toEqual([]);
  });

  test('a bad Cc address opens the Cc field and points at it', async ({ page, sentMail, allowErrors }) => {
    allowErrors.push(/status of 400/);
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await fillIn(form, { to: 'pat@example.com', cc: 'lee@example', subject: 'Hello', body: 'One bad copy' });
    await press(sendButton(form));
    await expect(note(page, 'Cc: “lee@example” isn\'t an email address.')).toBeVisible();
    await expect(f.cc).toBeVisible();
    await expect(f.cc).toHaveAttribute('aria-invalid', 'true');
    await expect(f.cc).toBeFocused();
    await expect(f.to).not.toHaveAttribute('aria-invalid', 'true');
    await expectFilledIn(form, { to: 'pat@example.com', cc: 'lee@example', subject: 'Hello', body: 'One bad copy' });
    expect(await outbox(page)).toEqual([]);
    expect(await sentMail()).toEqual([]);
  });

  test('no subject and no text: it asks first; Cancel keeps everything, OK sends it', async ({ page }) => {
    const ask = dialogs(page, false);
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com' });
    await press(sendButton(form));
    await expect.poll(() => ask.asked).toEqual(['Send this message without a subject?']);
    // Cancel: still writing, nothing queued
    await expect(form).toBeVisible();
    await expectFilledIn(form, { to: 'pat@example.com', subject: '', body: '' });
    await expect(note(page, 'Sending…')).toHaveCount(0);
    expect(await outbox(page)).toEqual([]);
    // OK: it goes, as "(no subject)"
    ask.accept = true;
    await press(sendButton(form));
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(form).toHaveCount(0);
    expect(await outbox(page)).toEqual([{ status: 'queued', subject: '(no subject)' }]);
  });

  test('Enter in a field never sends', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await fillIn(form, { to: 'pat@example.com', subject: 'Not yet', body: 'Still writing' });
    await f.to.press('Enter');
    await f.subject.press('Enter');
    await page.waitForTimeout(300); // a send would have closed the window by now
    await expect(form).toBeVisible();
    await expect(note(page, 'Sending…')).toHaveCount(0);
    expect(await outbox(page)).toEqual([]);
    await expectFilledIn(form, { to: 'pat@example.com', subject: 'Not yet', body: 'Still writing' });
  });

  test('pressing Send twice quickly sends it once', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Only once', body: 'Impatient finger' });
    // a slow connection: the second press comes while the first is still on its way
    await page.route('**/compose/send', async (route) => {
      await new Promise((r) => setTimeout(r, 500));
      await route.continue();
    });
    if (touch()) {
      await sendButton(form).tap();
      await sendButton(form).tap({ force: true }); // it no longer takes presses: force the finger down
    } else {
      await sendButton(form).dblclick();
    }
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(form).toHaveCount(0);
    await expect(note(page, 'Sending…')).toHaveCount(1);
    expect(await outbox(page)).toEqual([{ status: 'queued', subject: 'Only once' }]);
  });
});

// ---------------------------------------------------------------------------------------------
// drafts kept on this device

test.describe('Drafts', () => {
  test('what you write is saved as a draft and comes back after a reload', async ({ page }) => {
    const draft: Draft = { ...LETTER, from: 'sam@velocity.example' };
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, draft);
    await expect(form.getByText('Draft saved', { exact: true })).toBeVisible();
    expect(await storedDraft(page)).toMatchObject({
      from: 'sam@velocity.example', to: LETTER.to, cc: LETTER.cc, bcc: LETTER.bcc, subject: LETTER.subject, body: LETTER.body });

    await page.reload();
    await expect(page.getByRole('article').first()).toBeVisible();
    await expect(newMessage(page)).toHaveCount(0); // the window doesn't pop up by itself
    const again = await openNewMessage(page);
    await expect(again.getByText('Draft restored', { exact: true })).toBeVisible();
    await expectFilledIn(again, draft); // Cc and Bcc shown again too
  });

  test('text typed just before a reload is not lost', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', body: 'Typed in a hurry' });
    await page.reload(); // before the half-second autosave
    await expect(page.getByRole('article').first()).toBeVisible();
    const again = await openNewMessage(page);
    await expectFilledIn(again, { to: 'pat@example.com', body: 'Typed in a hurry' });
  });

  // Was a bug, now fixed: "Draft saved" shows for an address + subject without text, but such a draft never comes back
  test('an address and a subject without any text yet come back too', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Agenda to follow' });
    await expect(form.getByText('Draft saved', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('article').first()).toBeVisible();
    const again = await openNewMessage(page);
    await expectFilledIn(again, { to: 'pat@example.com', subject: 'Agenda to follow' });
  });

  test('Discard asks first, then throws the draft away for good', async ({ page }) => {
    const ask = dialogs(page, false);
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Maybe not', body: 'Second thoughts' });
    await expect(form.getByText('Draft saved', { exact: true })).toBeVisible();

    await press(form.getByRole('button', { name: 'Discard draft' }));
    await expect.poll(() => ask.asked).toEqual(['Discard this draft?']);
    await expect(form).toBeVisible(); // Cancel: nothing lost
    await expectFilledIn(form, { to: 'pat@example.com', subject: 'Maybe not', body: 'Second thoughts' });

    ask.accept = true;
    await press(form.getByRole('button', { name: 'Discard draft' }));
    await expect(form).toHaveCount(0);
    await expect(note(page, 'Draft discarded')).toBeVisible();
    expect(await storedDraft(page)).toBeNull();
    await page.reload();
    await expect(page.getByRole('article').first()).toBeVisible();
    const again = await openNewMessage(page);
    await expectFilledIn(again, { to: '', subject: '', body: '' });
    await expect(again.getByText('Draft restored', { exact: true })).toHaveCount(0);
  });

  test('an empty message closes without a word and leaves no draft', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await press(form.getByRole('button', { name: 'Save & close' }));
    await expect(form).toHaveCount(0);
    await expect(snackbar(page)).toHaveCount(0);
    expect(await storedDraft(page)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the window: minimise, full screen, close, one at a time

test.describe('The compose window', () => {
  test('Minimize tucks it into its title bar; the title bar brings it back as it was', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const f = fields(form);
    await fillIn(form, { to: 'pat@example.com', body: 'Half written' });
    await press(form.getByRole('button', { name: 'Minimize' }));
    await expect(f.body).toBeHidden();
    await expect(form.getByText('New message', { exact: true })).toBeVisible();
    await expect.poll(async () => (await form.boundingBox())!.height).toBeLessThanOrEqual(52);
    // the page around it works again (on a phone too)
    expect(await isInert(page.getByRole('searchbox', { name: 'Search mail' }))).toBe(false);

    await press(form.getByText('New message', { exact: true }));
    await expect(f.body).toBeVisible();
    await expectFilledIn(form, { to: 'pat@example.com', body: 'Half written' });
    await expect(f.subject).toBeFocused(); // the first thing still to fill in
  });

  test('Full screen enlarges the window and back; a phone sheet is already full screen', async ({ page, isPhone }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { body: 'Needs room' });
    const { width, height } = page.viewportSize()!;
    const full = form.getByRole('button', { name: 'Full screen' });
    if (isPhone) {
      await expect(full).toBeHidden();
      expect(await form.boundingBox()).toEqual({ x: 0, y: 0, width, height });
      return;
    }
    const small = (await form.boundingBox())!;
    await press(full);
    await expect.poll(async () => (await form.boundingBox())!.width).toBeGreaterThan(small.width + 100);
    await atRest(form);
    const big = (await form.boundingBox())!;
    expect(big.height).toBeGreaterThan(small.height);
    // centred, inside the window
    expect(big.x).toBeGreaterThan(0);
    expect(big.x + big.width).toBeLessThan(width);
    expect(Math.abs(big.x - (width - big.x - big.width))).toBeLessThan(2);
    expect(big.y + big.height).toBeLessThan(height);
    await expect(fields(form).body).toHaveValue('Needs room');

    await press(full);
    await expect.poll(async () => (await form.boundingBox())!.width).toBe(560);
  });

  // Was a bug, now fixed: Minimize and Full screen are toggles that never say they're on (no aria-pressed/expanded, same name)
  test('Minimize and Full screen tell screen readers when they are on', async ({ page, isPhone }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    // found by data attribute: what a screen reader hears for them is what's under test
    const toggles: [string, Locator][] = [['Minimize', form.locator('[data-compose-min]')]];
    if (!isPhone) toggles.push(['Full screen', form.locator('[data-compose-max]')]);
    for (const [name, button] of toggles) {
      const off = await button.ariaSnapshot();
      expect(off).toContain(name);
      await press(button);
      await expect.poll(() => button.ariaSnapshot(), `${name} sounds different once it's on`).not.toBe(off);
      await press(button);
      await expect.poll(() => button.ariaSnapshot()).toBe(off);
    }
  });

  test('one message at a time: Compose again brings back the one being written', async ({ page, isPhone }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', body: 'The first one' });
    await press(form.getByRole('button', { name: 'Minimize' }));
    await expect(fields(form).body).toBeHidden();

    await composeAgain(page, isPhone);
    await expect(note(page, "Finish or close the message you're writing first")).toBeVisible();
    await expect(page.getByRole('form', { name: /message/i })).toHaveCount(1);
    await expect(fields(form).body).toBeVisible();
    await expectFilledIn(form, { to: 'pat@example.com', body: 'The first one' });
  });

  // Was a bug, now fixed: on a phone, a minimised message brought back with Compose covers the screen but the page behind stays reachable
  test('a message brought back with Compose covers the page again on a phone, like when it opened', async ({ page, isPhone }) => {
    await page.goto('/');
    const behind = page.getByRole('searchbox', { name: 'Search mail' });
    const form = await openNewMessage(page);
    const coveredWhenOpened = await isInert(behind);
    expect(coveredWhenOpened).toBe(isPhone);
    await fillIn(form, { body: 'Back and forth' });
    await press(form.getByRole('button', { name: 'Minimize' }));
    await expect.poll(() => isInert(behind)).toBe(false);

    await composeAgain(page, isPhone);
    await expect(fields(form).body).toBeVisible();
    await atRest(form);
    if (isPhone) expect(await form.boundingBox()).toEqual({ x: 0, y: 0, ...page.viewportSize()! });
    await expect.poll(() => isInert(behind), 'the page behind is out of reach exactly when it was at first')
      .toBe(coveredWhenOpened);
  });

  test('Esc puts the window away and keeps the draft', async ({ page, isPhone }) => {
    test.skip(isPhone, 'Phones have no Esc key: there, Back puts the sheet away (next test)');
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Later', body: 'Esc should keep this' });
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    await expect(note(page, 'Draft saved on this device')).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    const again = await openNewMessage(page);
    await expect(again.getByText('Draft restored', { exact: true })).toBeVisible();
    await expectFilledIn(again, { to: 'pat@example.com', subject: 'Later', body: 'Esc should keep this' });
  });

  test("a phone's Back puts the sheet away and keeps the draft", async ({ page, isPhone }) => {
    test.skip(!isPhone, 'Only the phone sheet is a step in the history; elsewhere Back leaves the page (the window is not a page)');
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', body: 'Back should keep this' });
    await page.goBack();
    await expect(form).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('article').filter({ hasText: 'Contract renewal needs your signature today' })).toBeVisible();
    const again = await openNewMessage(page);
    await expectFilledIn(again, { to: 'pat@example.com', body: 'Back should keep this' });
  });

  // Was a bug, now fixed: closing a new message drops keyboard focus to the page body instead of returning it to Compose
  test('closing a new message puts focus back on Compose', async ({ page }) => {
    await page.goto('/');
    const control = composeControl(page);
    const form = await openNewMessage(page);
    await fillIn(form, { body: 'Back in a minute' });
    await press(form.getByRole('button', { name: 'Save & close' }));
    await expect(form).toHaveCount(0);
    await expect(control).toBeFocused();
  });

  test('switching inbox tabs keeps the message being written', async ({ page, isPhone }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Across tabs', body: 'Still here?' });
    // on a phone the sheet covers the tabs: tuck it away first
    if (isPhone) await press(form.getByRole('button', { name: 'Minimize' }));
    await press(page.getByRole('link', { name: /^Later\b/ }).filter({ visible: true }).first());
    await expect(page).toHaveURL(/[?&]tab=later/);
    await expect(page.getByRole('article').filter({ hasText: 'Top stories for you' })).toBeVisible();
    await expect(page.getByRole('article').filter({ hasText: 'Contract renewal needs your signature today' })).toHaveCount(0);
    await expect(form).toHaveCount(1);
    if (isPhone) await press(form.getByText('New message', { exact: true }));
    await expectFilledIn(form, { to: 'pat@example.com', subject: 'Across tabs', body: 'Still here?' });
    // and it still sends from there
    await press(sendButton(form));
    await expect(note(page, 'Sending…')).toBeVisible();
    expect(await outbox(page)).toEqual([{ status: 'queued', subject: 'Across tabs' }]);
  });

  test('shortcut letters typed into a message are just text', async ({ page }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    const body = fields(form).body;
    await body.click();
    await body.pressSequentially('c j k z e u ? g t 1');
    await expect(body).toHaveValue('c j k z e u ? g t 1');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('form', { name: /message/i })).toHaveCount(1);
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
    await expect(snackbar(page)).toHaveCount(0);
  });

  test('Help me write drafts the text for you to edit', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 422/); // asking with nothing to go on is turned down (422)
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Invoice' });
    await press(form.getByRole('button', { name: 'Help me write' }));
    const ask = form.getByRole('textbox', { name: 'Help me write' });
    await expect(ask).toBeFocused();
    // nothing to go on: it says what to do
    await press(form.getByRole('button', { name: 'Create' }));
    await expect(note(page, 'Tell the AI what to write first')).toBeVisible();
    await expect(fields(form).body).toHaveValue('');

    await ask.fill('Politely decline the meeting');
    await ask.press('Enter');
    await expect(fields(form).body).toHaveValue(/can't make it this time/);
    await expect(fields(form).body).toBeFocused();
    await expect(note(page, 'Draft ready: read it and edit before sending')).toBeVisible();
    await expect(form).toBeVisible(); // nothing was sent: you read it first
    expect(await outbox(page)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// sending and Undo send

test.describe('Sending and Undo send', () => {
  test('send, Undo brings it all back, send again: one email goes out with everything you wrote', async ({ page, sentMail }) => {
    test.slow(); // the real 10-second Undo window
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, LETTER);
    // desktop: ⌘/Ctrl+Enter from the text; phone and tablet: the Send button
    if (touch()) await press(sendButton(form));
    else await fields(form).body.press('Control+Enter');

    await expect(form).toHaveCount(0);
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(sendingUndo(page)).toBeFocused();
    if (touch()) await press(sendingUndo(page));
    else await page.keyboard.press('Enter'); // Undo has the focus

    await expect(note(page, 'Sending undone')).toBeVisible();
    const again = newMessage(page);
    await expect(again).toBeVisible();
    await expectFilledIn(again, LETTER);
    await expect(fields(again).body).toBeFocused(); // back to writing
    expect(await outbox(page)).toEqual([{ status: 'cancelled', subject: LETTER.subject }]);
    expect(await sentMail()).toEqual([]);

    await press(sendButton(again));
    const sentAt = Date.now();
    await expect(again).toHaveCount(0);
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(note(page, 'Message sent')).toBeVisible({ timeout: 25_000 });
    expect(Date.now() - sentAt, 'it waited out the 10-second Undo time').toBeGreaterThan(9_500);
    await expect(note(page, 'Sending…')).toHaveCount(0);

    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam.work@gmail.com', to: LETTER.to, cc: LETTER.cc, subject: LETTER.subject, in_reply_to: null });
    expect([...sent[0].rcpt].sort()).toEqual(['boss@example.com', 'kim@example.com', 'lee@example.com', 'pat@example.com']);
    expect(sent[0].body.trimEnd()).toBe(LETTER.body);
    expect(await storedDraft(page)).toBeNull(); // a sent message leaves no draft behind

    // View: the Sent page lists it once (the undone copy is gone), sent
    await press(note(page, 'Message sent').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const item = page.getByRole('listitem').filter({ hasText: LETTER.subject });
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('To: Pat Doe, lee@example.com, kim@example.com');
    await expect(item).toContainText('from sam.work@gmail.com');
    await expect(item).toContainText('Lunch at 1 on Friday?');
    await expect(item).not.toContainText('Sending…');
    await expect(item).not.toContainText('Undone');
  });

  test('z undoes a send that is still waiting', async ({ page, sentMail, isPhone }) => {
    test.skip(isPhone, 'Single-key shortcuts need a keyboard; on a phone it is the Undo button (tested above)');
    await page.goto('/');
    const form = await openNewMessage(page);
    const draft = { to: 'pat@example.com', subject: 'Oops', body: 'Sent too soon' };
    await fillIn(form, draft);
    await fields(form).subject.press('Meta+Enter'); // ⌘ Enter works from any field
    await expect(note(page, 'Sending…')).toBeVisible();
    await page.keyboard.press('z');
    await expect(note(page, 'Sending undone')).toBeVisible();
    await expectFilledIn(newMessage(page), draft);
    expect(await outbox(page)).toEqual([{ status: 'cancelled', subject: 'Oops' }]);
    expect(await sentMail()).toEqual([]);
  });

  test('an email waiting to go has its own Undo on the Sent page', async ({ page, sentMail }) => {
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Undo from Sent', body: 'Changed my mind' });
    await press(sendButton(form));
    await press(note(page, 'Sending…').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const item = page.getByRole('listitem').filter({ hasText: 'Undo from Sent' });
    await expect(item).toContainText('Sending…');
    await expect(note(page, 'Sending…')).toBeVisible(); // the snackbar came along

    await press(item.getByRole('button', { name: 'Undo' }));
    await expect(note(page, 'Sending undone')).toBeVisible();
    await expectFilledIn(newMessage(page), { to: 'pat@example.com', subject: 'Undo from Sent', body: 'Changed my mind' });
    await expect(item).toContainText('Undone');
    await expect(item.getByRole('link', { name: 'Edit' })).toBeVisible();
    expect(await outbox(page)).toEqual([{ status: 'cancelled', subject: 'Undo from Sent' }]);
    expect(await sentMail()).toEqual([]);
  });

  // Was a bug, now fixed: the Sent page never updates by itself: a sent email keeps "Sending…" and its Undo, and one written there isn't listed
  test('the Sent page keeps up: "Sending…" goes once it is sent, and a new email shows up', async ({ page, sentMail }) => {
    test.slow();
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Watch it go', body: 'Off it goes' });
    await press(sendButton(form));
    await press(note(page, 'Sending…').getByRole('button', { name: 'View' }));
    await expect(page).toHaveURL(/\/sent#s\d+$/);
    const item = page.getByRole('listitem').filter({ hasText: 'Watch it go' });
    await expect(item).toContainText('Sending…');
    await expect(item.getByRole('button', { name: 'Undo' })).toBeVisible();

    await expect(note(page, 'Message sent')).toBeVisible({ timeout: 25_000 });
    expect(await sentMail()).toHaveLength(1);
    await expect.soft(item, 'no longer "Sending…" once it has gone').not.toContainText('Sending…');
    await expect.soft(item.getByRole('button', { name: 'Undo' }), 'nothing left to undo').toHaveCount(0);

    // one written on the Sent page itself is listed straight away
    const again = await openNewMessage(page);
    await fillIn(again, { to: 'lee@example.com', subject: 'Written on Sent', body: 'From the Sent page' });
    await press(sendButton(again));
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Written on Sent' }), 'the new email is listed').toBeVisible();
  });

  // Was a bug, now fixed: discarding an undone email in its window leaves it on the Sent page as "Undone" (with Edit / Discard)
  test('Discard on an undone email takes it off the Sent page too', async ({ page }) => {
    const ask = dialogs(page, true);
    await page.goto('/');
    const form = await openNewMessage(page);
    await fillIn(form, { to: 'pat@example.com', subject: 'Never mind', body: 'Forget it' });
    await press(sendButton(form));
    await press(sendingUndo(page));
    await expect(note(page, 'Sending undone')).toBeVisible();
    const again = newMessage(page);
    await expectFilledIn(again, { subject: 'Never mind' });
    await press(again.getByRole('button', { name: 'Discard draft' }));
    await expect.poll(() => ask.asked).toEqual(['Discard this draft?']);
    await expect(note(page, 'Draft discarded')).toBeVisible();
    await expect(again).toHaveCount(0);
    expect(await outbox(page), 'nothing left on the Sent page').toEqual([]);
  });
});
