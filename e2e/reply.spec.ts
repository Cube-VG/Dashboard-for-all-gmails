// Replying, forwarding and "Help me write" on a desktop, a phone and a tablet: Reply / Reply all /
// Forward from an open email (prefilled recipients, Re: / Fwd:, the quoted or forwarded text), the
// keyboard shortcuts r / a / f, sending (checked against what the fake mail server received) and
// the "Replied" mark it leaves, Undo send on a reply, AI drafts (busy state, the decline draft,
// Private senders, an empty instruction) and replying from page 2 of a long list.
//
// Where the reply opens (app/web/templates/_detail.html, app.js openReply):
// - desktop (1440px) and tablet (810px): the email takes the list's place and the reply opens
//   inline, under the email's text (Gmail's default).
// - phone (390px): the email covers the screen and the reply opens inline in it too, under the
//   text; the Reply · Reply all · Forward pills stay pinned to the bottom of the screen and the
//   top bar's Reply arrow is left out (style.css, phone section). New mail is the only compose
//   that becomes a full-screen sheet.
// - Undo of a reply brings it back in the Compose window (a full-screen sheet on a phone), still a
//   reply to the same email.
//
// The demo mailbox (e2e/server.py) has no email with other people in To or Cc: every email is
// addressed to just one of my own accounts, so "Reply all" can only be checked for leaving my own
// address out (the "plus everyone else" half is a coverage gap).
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - The Reply · Reply all · Forward pills aren't a named group, and the top bar's Reply arrow has
//   the same name ("Reply"), so the pill is the last link called Reply.
// - The quoted original under a reply is a <details> whose visible summary is just "•••"; it is
//   found by its tooltip ("Show the email you are replying to").
// - An inline reply's subject is a hidden field (like Gmail): it is read from the form and from
//   what was sent.
// - While Help me write is working, the Create button is neither disabled nor aria-busy (it only
//   ignores presses); the busy state is the "Writing…" text in a bare <span aria-live>, found by
//   its text, like "Draft saved" / "Draft restored".
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar, swipe } from './fixtures';

// --- the demo mailbox (e2e/server.py; tabs from app/ai/scoring.quadrant) -----------------------

const CONTRACT = 'Contract renewal needs your signature today'; // Do now, id 1, <m1@demo>, to Work
const PRIYA = 'Priya Raman <priya@acme.example>';
const PAYMENT = 'Payment failed for velocity.example'; // Do now, id 2, <m2@demo>, to Velocity (not Gmail)
const SUNDAY = 'Sunday lunch?'; // Schedule, id 4, <m4@demo>, from Mum <mum@family.example>, to Personal
const Q4 = 'Q4 planning doc — comments welcome'; // Schedule, already answered

const DRAFT_YES = "Hi,\n\nThanks for your note. I've taken care of it and will follow up tomorrow.\n\nBest,\nSam";
const DRAFT_NO = "Hi,\n\nThanks for thinking of me, but I can't make it this time.\n\nBest,\nSam";
const PRIVATE_SAYS = 'This sender is marked “Private — never send to AI”, so their mail stays away from the AI. '
  + 'Write this one yourself.';
const KEYBOARD_ONLY = 'Single-key shortcuts need a hardware keyboard: the phone and tablet projects have none '
  + '(the same actions are tapped in the other tests)';

// --- helpers -----------------------------------------------------------------------------------

const isTouch = () => !!test.info().project.use.hasTouch;

/** A finger tap on the phone and tablet, a mouse click on the desktop. */
async function press(target: Locator) {
  if (isTouch()) await target.tap();
  else await target.click();
}

type Mode = 'Reply' | 'Reply all' | 'Forward';

const pane = (page: Page) => page.getByRole('complementary', { name: 'Selected email' });
const subjectOf = (page: Page) => pane(page).getByRole('heading', { level: 2 });
/** The Reply / Reply all / Forward pill under the email (see the top: the last link of that name). */
const pill = (page: Page, mode: Mode) => pane(page).getByRole('link', { name: mode, exact: true }).last();
/** The Reply arrow in the email's top bar (desktop and tablet). By its tooltip, which the pill
 * shares, so that the left-out arrow can be found on a phone too. */
const topBarReply = (page: Page) => pane(page).getByTitle('Reply (r)').first();
const backLink = (page: Page) => pane(page).getByRole('link', { name: 'Back to the list' });
const replyForm = (page: Page, mode: Mode) => page.getByRole('form', { name: mode, exact: true });
/** A tab's list of emails. */
const list = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

function fields(form: Locator) {
  return {
    from: form.getByRole('combobox', { name: 'From' }),
    to: form.getByRole('textbox', { name: 'To', exact: true }),
    cc: form.getByRole('textbox', { name: 'Cc', exact: true }),
    subject: form.getByRole('textbox', { name: 'Subject', exact: true }), // the Compose window only
    body: form.getByRole('textbox', { name: 'Message', exact: true }),
    send: form.getByRole('button', { name: 'Send', exact: true }),
    help: form.getByRole('button', { name: 'Help me write' }),
    ask: form.getByRole('textbox', { name: 'Help me write' }),
    create: form.getByRole('button', { name: 'Create', exact: true }),
    includeQuote: form.getByRole('checkbox', { name: 'Include the original email below my reply' }),
    discard: form.getByRole('button', { name: 'Discard draft' }),
  };
}
/** An inline reply's subject: kept out of sight, like Gmail (see the top). */
const hiddenSubject = (form: Locator) => form.locator('input[name="subject"]');
/** The "•••" under a reply that shows the email being answered. */
const showOriginal = (form: Locator) => form.getByTitle('Show the email you are replying to');
/** The snackbar saying `text` ("Sending…" stays up while others come and go). */
const note = (page: Page, text: string | RegExp) => snackbar(page).filter({ hasText: text });

async function openEmail(page: Page, subject: string, path = '/') {
  await page.goto(path);
  await press(page.getByRole('article').filter({ hasText: subject }).getByRole('link').first());
  await expect(subjectOf(page)).toHaveText(subject);
}

async function startReply(page: Page, mode: Mode) {
  await press(pill(page, mode));
  const form = replyForm(page, mode);
  await expect(form).toBeVisible();
  return form;
}

/** Send, and see it waiting in its Undo time. */
async function send(page: Page, form: Locator) {
  await press(fields(form).send);
  await expect(form).toHaveCount(0);
  await expect(note(page, 'Sending…')).toBeVisible();
}

/** The real 10-second Undo time, then the worker's send and the page's next check. */
async function messageSent(page: Page) {
  await expect(note(page, 'Message sent')).toBeVisible({ timeout: 25_000 });
}

/** Whether a finger (or the mouse) at the middle of `target` lands on it, not on something on top. */
async function reachable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
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

/** The lines of the original as they sit under a reply: "On …, Priya Raman <…> wrote:" then "> …". */
const CONTRACT_QUOTE = [
  '> Hi Sam,', '>',
  '> The renewal contract for Acme is attached. Legal needs it signed by 5 pm today so we can keep the current pricing.',
  '>', '> Could you sign and send it back?', '>', '> Thanks,', '> Priya',
].join('\n');

// -----------------------------------------------------------------------------------------------

test.describe('Reply, Reply all and Forward open under the email', () => {
  test('Reply opens under the email, to the sender, with "Re:" and the original quoted below', async ({ page, isPhone }) => {
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply');
    const f = fields(form);

    // inline, in the open email, after its text: no separate window or sheet on any device
    await expect(pane(page).getByRole('form', { name: 'Reply', exact: true })).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(1);
    const text = await pane(page).getByText('Could you sign and send it back?').first().elementHandle();
    const gap = await form.evaluate((el, t) => el.getBoundingClientRect().top - t!.getBoundingClientRect().bottom, text);
    expect(gap, 'the reply sits under the email text').toBeGreaterThanOrEqual(0);
    if (isPhone) {
      // the email (and the reply in it) covers the whole screen
      await expect.poll(() => pane(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
    }

    await expect(f.from).toHaveValue('sam.work@gmail.com'); // the address Priya wrote to
    await expect(f.to).toHaveValue(PRIYA);
    await expect(f.cc).toBeHidden(); // nobody else to copy
    await expect(hiddenSubject(form)).toHaveValue(`Re: ${CONTRACT}`);
    await expect(f.body).toHaveValue('');
    await expect(f.body).toBeFocused(); // ready to type the reply

    // the original is quoted below, out of the way until asked for
    const quoted = form.getByText(/On .+, Priya Raman <priya@acme\.example> wrote:/);
    await expect(quoted).toBeHidden();
    await press(showOriginal(form));
    await expect(quoted).toBeVisible();
    await expect(quoted).toContainText('> The renewal contract for Acme is attached. Legal needs it signed by 5 pm today');
    await expect(f.includeQuote).toBeChecked();
  });

  test('Reply all goes to the sender and leaves my own address out', async ({ page }) => {
    await openEmail(page, CONTRACT);
    // the email was sent to me only
    await expect(pane(page).getByText('to sam.work@gmail.com')).toBeVisible();
    const form = await startReply(page, 'Reply all');
    const f = fields(form);
    await expect(form).toContainText('Reply all');
    await expect(f.to).toHaveValue(PRIYA);
    await expect(f.cc).toBeHidden();
    await expect(form.locator('input[name="cc"]'), 'nobody in Cc either').toHaveValue(''); // hidden while empty
    await expect(hiddenSubject(form)).toHaveValue(`Re: ${CONTRACT}`);
    await expect(f.body).toBeFocused();
    await press(showOriginal(form));
    await expect(form.getByText(/Priya Raman <priya@acme\.example> wrote:/)).toBeVisible();
  });

  test('Forward starts with an empty To, a "Fwd:" subject and the whole email below', async ({ page }) => {
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Forward');
    const f = fields(form);
    await expect(f.to).toHaveValue('');
    await expect(f.to).toBeFocused(); // who to send it to comes first
    await expect(f.cc).toBeHidden();
    await expect(hiddenSubject(form)).toHaveValue(`Fwd: ${CONTRACT}`);
    await expect(f.body).toHaveAttribute('placeholder', 'Add a note');
    await expect(f.includeQuote).toHaveCount(0); // a forward always carries the email

    // the forwarded email is already shown in full, headers first
    const block = form.getByText('---------- Forwarded message ---------');
    await expect(block).toBeVisible();
    await expect(block).toContainText(`From: ${PRIYA}`);
    await expect(block).toContainText(`Subject: ${CONTRACT}`);
    await expect(block).toContainText('To: sam.work@gmail.com');
    await expect(block).toContainText('Could you sign and send it back?');
    // the contract has an attachment, which can't go along
    await expect(form.getByText("Attachments aren't forwarded yet: only the text of the email goes along.")).toBeVisible();
  });

  test("the top bar's Reply arrow opens the same reply; on a phone the reply buttons stay at the bottom of the screen instead", async ({ page, isPhone }) => {
    await openEmail(page, CONTRACT);
    if (isPhone) {
      // the arrow is left out on a phone: Reply · Reply all · Forward are pinned to the bottom,
      // within reach of a thumb before scrolling down to them
      await expect(topBarReply(page)).toBeHidden();
      for (const mode of ['Reply', 'Reply all', 'Forward'] as const) {
        await expect(pill(page, mode)).toBeInViewport();
        const b = await pill(page, mode).boundingBox();
        expect(b!.y + b!.height, `${mode} sits near the bottom edge`).toBeGreaterThan(664 - 70);
        expect(b!.height, `${mode} is big enough to tap`).toBeGreaterThanOrEqual(44);
      }
      const form = await startReply(page, 'Reply');
      await expect(fields(form).to).toHaveValue(PRIYA);
      return;
    }
    await expect(topBarReply(page)).toBeVisible();
    await expect(topBarReply(page)).toHaveAttribute('aria-keyshortcuts', 'r');
    await press(topBarReply(page));
    const form = replyForm(page, 'Reply');
    await expect(form).toBeVisible();
    await expect(form).toBeInViewport(); // brought into view under the email
    await expect(fields(form).to).toHaveValue(PRIYA);
    await expect(fields(form).body).toBeFocused();
    await expect(page.getByRole('form')).toHaveCount(1);
  });

  test("pressing Reply again keeps what you wrote; Forward asks before throwing it away", async ({ page }) => {
    const answer = dialogs(page, false);
    await openEmail(page, CONTRACT);
    const reply = await startReply(page, 'Reply');
    await fields(reply).body.fill('Signing it now.');

    // Reply again: the same reply, nothing lost, no question asked
    await press(pill(page, 'Reply'));
    await expect(page.getByRole('form')).toHaveCount(1);
    await expect(fields(reply).body).toHaveValue('Signing it now.');
    await expect(fields(reply).body).toBeFocused();
    expect(answer.asked).toEqual([]);

    // Forward: asks first; Cancel keeps the reply
    await press(pill(page, 'Forward'));
    await expect.poll(() => answer.asked).toEqual(["Discard the reply you're writing?"]);
    await expect(replyForm(page, 'Forward')).toHaveCount(0);
    await expect(fields(reply).body).toHaveValue('Signing it now.');

    // OK: the reply gives way to the forward
    answer.accept = true;
    await press(pill(page, 'Forward'));
    const fwd = replyForm(page, 'Forward');
    await expect(fwd).toBeVisible();
    await expect(reply).toHaveCount(0);
    await expect(fields(fwd).to).toHaveValue('');
    // and the thrown-away reply doesn't come back as a draft
    answer.accept = false;
    await press(pill(page, 'Reply'));
    await expect(fields(replyForm(page, 'Reply')).body).toHaveValue('');
  });

  test('Discard asks, then throws the reply away for good', async ({ page }) => {
    const answer = dialogs(page, true);
    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    await expect(fields(form).to).toHaveValue('Mum <mum@family.example>');
    await fields(form).body.fill("Yes, I'll be there!");
    await expect(form.getByText('Draft saved')).toBeVisible();

    await press(fields(form).discard);
    await expect.poll(() => answer.asked).toEqual(['Discard this draft?']);
    await expect(form).toHaveCount(0);
    await expect(note(page, 'Draft discarded')).toBeVisible();

    await page.reload();
    await expect(subjectOf(page)).toHaveText(SUNDAY);
    const again = await startReply(page, 'Reply');
    await expect(fields(again).body).toHaveValue('');
    await expect(again.getByText('Draft restored')).toHaveCount(0);
  });

  test('a half-written reply is kept on this device: after a reload, Reply brings it back', async ({ page }) => {
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply');
    await fields(form).body.fill('Will sign after lunch.');
    await expect(form.getByText('Draft saved')).toBeVisible();

    await page.reload();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(page.getByRole('form')).toHaveCount(0); // nothing opens by itself
    const again = await startReply(page, 'Reply');
    await expect(fields(again).body).toHaveValue('Will sign after lunch.');
    await expect(fields(again).to).toHaveValue(PRIYA);
    await expect(again.getByText('Draft restored')).toBeVisible();
  });

  test('closing the email straight after typing keeps the reply as a draft', async ({ page }) => {
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply');
    await fields(form).body.fill('Quick note before I go');
    await press(backLink(page)); // at once, before the draft's own save timer
    await expect(pane(page)).toBeHidden();

    await press(list(page, 'Do now').getByRole('article').filter({ hasText: CONTRACT }).getByRole('link'));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    const again = await startReply(page, 'Reply');
    await expect(fields(again).body).toHaveValue('Quick note before I go');
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Swipes while replying', () => {
  test('a sideways swipe across the reply being written never closes the email; on a phone, one across the email does, and the reply waits as a draft', async ({ page, isPhone }) => {
    test.skip(!isTouch(), 'Swipes need a touch screen: the desktop project has none');
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply');
    const body = fields(form).body;
    await body.fill('Selecting a word in here with a finger');
    await expect(body).toBeInViewport();
    const b = (await body.boundingBox())!;
    const y = b.y + Math.min(b.height / 2, 40);
    await swipe(page, b.x + 16, y, b.x + b.width - 8, y, { ms: 240 });
    await page.waitForTimeout(600); // a released swipe-back would be on its way out by now
    await expect(page).toHaveURL(/\/\?open=1$/);
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    if (isPhone) await expect.poll(() => pane(page).boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
    await expect(body).toHaveValue('Selecting a word in here with a finger');
    if (!isPhone) return; // swiping an email back to the list is a phone gesture

    // the same swipe across the email itself goes back to the list (iOS), keeping the reply
    const text = pane(page).getByText('Could you sign and send it back?').first();
    await text.scrollIntoViewIfNeeded();
    const t = (await text.boundingBox())!;
    await swipe(page, 24, t.y + t.height / 2, 370, t.y + t.height / 2, { ms: 240 });
    await expect(pane(page)).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
    await press(list(page, 'Do now').getByRole('article').filter({ hasText: CONTRACT }).getByRole('link'));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    const again = await startReply(page, 'Reply');
    await expect(fields(again).body).toHaveValue('Selecting a word in here with a finger');
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Sending a reply or a forward', () => {
  test('a reply goes to the sender in the same conversation with the original quoted, and the email then shows Replied', async ({ page, sentMail }) => {
    test.slow(); // the real 10-second Undo time
    await openEmail(page, CONTRACT);
    await expect(pane(page).getByText('Replied', { exact: true })).toHaveCount(0);
    const form = await startReply(page, 'Reply');
    await fields(form).body.fill('Signed and sent back. Thanks!');
    await send(page, form);
    expect(await sentMail(), 'nothing goes out during the Undo time').toEqual([]);
    await messageSent(page);

    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam.work@gmail.com', to: PRIYA, cc: null, rcpt: ['priya@acme.example'],
      subject: `Re: ${CONTRACT}`, in_reply_to: '<m1@demo>' });
    expect(sent[0].body).toMatch(/^Signed and sent back\. Thanks!\n\nOn .+, Priya Raman <priya@acme\.example> wrote:\n/);
    expect(sent[0].body).toContain(CONTRACT_QUOTE);

    // the open email now says it was answered, and still does after a reload
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
    await page.reload();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();

    // in the list it's marked Replied and sinks below what still waits for an answer
    await press(backLink(page));
    const rows = list(page, 'Do now').getByRole('article');
    await expect(rows).toHaveCount(2);
    await expect(rows.last()).toContainText(CONTRACT);
    await expect(rows.last()).toContainText('Replied');
    await expect(rows.first()).toContainText(PAYMENT);
    await expect(rows.first()).not.toContainText('Replied');

    // the sent reply left no draft behind
    await press(rows.last().getByRole('link'));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    const again = await startReply(page, 'Reply');
    await expect(fields(again).body).toHaveValue('');
  });

  test('Reply all is sent to the sender only, in the same conversation', async ({ page, sentMail }) => {
    test.slow();
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply all');
    await fields(form).body.fill('Done, see attached.');
    if (isTouch()) {
      await send(page, form);
    } else {
      await fields(form).body.press('Control+Enter'); // ⌘/Ctrl Enter sends from the text
      await expect(form).toHaveCount(0);
      await expect(note(page, 'Sending…')).toBeVisible();
    }
    await messageSent(page);
    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam.work@gmail.com', to: PRIYA, cc: null, rcpt: ['priya@acme.example'],
      subject: `Re: ${CONTRACT}`, in_reply_to: '<m1@demo>' });
    expect(sent[0].body).toMatch(/^Done, see attached\.\n\nOn .+, Priya Raman <priya@acme\.example> wrote:\n/);
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
  });

  test('Forward sends the whole email to the address you type, as a new conversation', async ({ page, sentMail }) => {
    test.slow();
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Forward');
    await fields(form).to.fill('Pat Doe <pat@example.com>');
    await fields(form).body.fill('FYI, can you handle this?');
    await send(page, form);
    await messageSent(page);

    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam.work@gmail.com', to: 'Pat Doe <pat@example.com>', cc: null, rcpt: ['pat@example.com'],
      subject: `Fwd: ${CONTRACT}`, in_reply_to: null });
    const body = sent[0].body;
    expect(body).toMatch(/^FYI, can you handle this\?\n\n---------- Forwarded message ---------\n/);
    expect(body).toContain(`From: ${PRIYA}\n`);
    expect(body).toContain(`Subject: ${CONTRACT}\n`);
    expect(body).toContain('To: sam.work@gmail.com\n');
    expect(body).toContain('Legal needs it signed by 5 pm today so we can keep the current pricing.');
    expect(body).not.toContain('> '); // forwarded as it was, not quoted

    // forwarding isn't answering: the email isn't marked Replied
    await page.reload();
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(pane(page).getByText('Replied', { exact: true })).toHaveCount(0);
  });

  test('a reply goes out from the address the email came to, copies whoever you add in Cc, and carries only your text when the original is left out', async ({ page, sentMail }) => {
    test.slow();
    await openEmail(page, PAYMENT);
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await expect(f.from).toHaveValue('sam@velocity.example');
    await expect(f.to).toHaveValue('Hostinger <billing@hostinger.example>');
    await expect(hiddenSubject(form)).toHaveValue(`Re: ${PAYMENT}`);
    await press(form.getByRole('button', { name: 'Cc', exact: true }));
    await expect(f.cc).toBeFocused();
    await f.cc.fill('Accounts <accounts@velocity.example>');
    await f.body.fill('Card updated.');
    await press(showOriginal(form));
    await press(f.includeQuote);
    await expect(f.includeQuote).not.toBeChecked();
    await send(page, form);
    await messageSent(page);

    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam@velocity.example', to: 'Hostinger <billing@hostinger.example>',
      cc: 'Accounts <accounts@velocity.example>', rcpt: ['billing@hostinger.example', 'accounts@velocity.example'],
      subject: `Re: ${PAYMENT}`, in_reply_to: '<m2@demo>' });
    expect(sent[0].body.trimEnd()).toBe('Card updated.');
  });

  test('a reply whose To was emptied is stopped before anything is sent', async ({ page, sentMail }) => {
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await f.to.fill('');
    await f.body.fill('Hello?');
    await press(f.send);
    await expect(note(page, 'Add at least one recipient.')).toBeVisible();
    await expect(f.to).toBeFocused();
    await expect(f.to).toHaveAttribute('aria-invalid', 'true');
    await expect(form).toBeVisible();
    await expect(f.body).toHaveValue('Hello?');
    await expect(note(page, 'Sending…')).toHaveCount(0);
    expect(await sentMail()).toEqual([]);
  });

  test('the already answered Q4 email shows Replied before anything is sent', async ({ page }) => {
    await page.goto('/?tab=schedule');
    const row = list(page, 'Schedule').getByRole('article').filter({ hasText: Q4 });
    await expect(row).toContainText('Replied');
    await press(row.getByRole('link'));
    await expect(subjectOf(page)).toHaveText(Q4);
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Replying outside the inbox', () => {
  test("the Reply link opened in a tab of its own is a full Reply page that sends and comes back to the email", async ({ page, sentMail }) => {
    test.slow();
    await openEmail(page, CONTRACT);
    const href = await pill(page, 'Reply').getAttribute('href');
    await page.goto(href!); // e.g. "Open in new tab" on the Reply button

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reply');
    await expect(page.getByText(`Replying to ${CONTRACT} from Priya Raman`)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/?open=1');
    const form = replyForm(page, 'Reply');
    const f = fields(form);
    await expect(f.from).toHaveValue('sam.work@gmail.com');
    await expect(f.to).toHaveValue(PRIYA);
    await expect(f.subject).toHaveValue(`Re: ${CONTRACT}`); // a full page shows the subject
    await expect(f.body).toBeFocused();
    await press(showOriginal(form));
    await expect(form.getByText(/Priya Raman <priya@acme\.example> wrote:/)).toBeVisible();

    await f.body.fill('Sent from the full page.');
    await press(f.send);
    await expect(page).toHaveURL(/\/\?open=1$/); // back to the email
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(note(page, 'Sending…')).toBeVisible();
    await messageSent(page);
    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: PRIYA, subject: `Re: ${CONTRACT}`, in_reply_to: '<m1@demo>' });
    expect(sent[0].body).toMatch(/^Sent from the full page\.\n\nOn .+, Priya Raman <priya@acme\.example> wrote:\n/);
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
  });

  test("on an email's own page (/message/N), Reply opens under it and the email shows Replied once sent", async ({ page, sentMail }) => {
    test.slow();
    await page.goto('/message/1');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(CONTRACT);
    await press(main.getByRole('link', { name: 'Reply', exact: true }).last());
    const form = replyForm(page, 'Reply');
    await expect(form).toBeVisible();
    await expect(page).toHaveURL(/\/message\/1$/); // inline, no page change
    await expect(fields(form).to).toHaveValue(PRIYA);
    await expect(hiddenSubject(form)).toHaveValue(`Re: ${CONTRACT}`);
    await fields(form).body.fill('Signed.');
    await send(page, form);
    await messageSent(page);
    expect(await sentMail()).toMatchObject([{ to: PRIYA, in_reply_to: '<m1@demo>' }]);
    // Was a bug, now fixed: on /message/N the email isn't marked Replied after "Message sent" until the page is reloaded
    await expect.soft(main.getByText('Replied', { exact: true }), 'Replied shows without a reload').toBeVisible();
    await page.reload();
    await expect(main.getByText('Replied', { exact: true })).toBeVisible();
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Undo send on a reply', () => {
  test('Undo brings the reply back to edit, still a reply; sent again, it stays in the conversation', async ({ page, sentMail, isPhone }) => {
    test.slow(); // two sends' worth of waiting
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Reply');
    await fields(form).body.fill('Signed!');
    await send(page, form);
    const undo = note(page, 'Sending…').getByRole('button', { name: 'Undo' });
    await expect(undo).toBeFocused();
    if (isTouch()) await press(undo);
    else await page.keyboard.press('z');

    await expect(note(page, 'Sending undone')).toBeVisible();
    await expect(note(page, 'Sending…')).toHaveCount(0);
    // back in the Compose window (a full-screen sheet on a phone), as it was
    const again = replyForm(page, 'Reply');
    await expect(again).toBeVisible();
    await expect(page.getByRole('form')).toHaveCount(1);
    const f = fields(again);
    await expect(f.from).toHaveValue('sam.work@gmail.com');
    await expect(f.to).toHaveValue(PRIYA);
    await expect(f.subject).toHaveValue(`Re: ${CONTRACT}`);
    await expect(f.body).toHaveValue('Signed!');
    await expect(f.body).toBeFocused();
    if (isPhone) await expect.poll(() => again.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
    await press(showOriginal(again));
    await expect(again.getByText(/Priya Raman <priya@acme\.example> wrote:/)).toBeVisible();
    await expect(f.includeQuote).toBeChecked();
    expect(await sentMail()).toEqual([]);
    // not answered yet
    await expect(pane(page).getByText('Replied', { exact: true })).toHaveCount(0);

    await f.body.fill('Signed and sent back!');
    await send(page, again);
    await messageSent(page);
    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam.work@gmail.com', to: PRIYA, subject: `Re: ${CONTRACT}`, in_reply_to: '<m1@demo>' });
    expect(sent[0].body).toMatch(/^Signed and sent back!\n\nOn .+, Priya Raman <priya@acme\.example> wrote:\n/);
    expect(sent[0].body).toContain(CONTRACT_QUOTE);
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Keyboard shortcuts r, a and f', () => {
  test('r, a and f open Reply, Reply all and Forward for the open email', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, KEYBOARD_ONLY);
    await page.goto('/');
    await page.keyboard.press('r'); // no email open: nothing to answer
    await expect(page.getByRole('form')).toHaveCount(0);

    await openEmail(page, CONTRACT);
    await page.keyboard.press('r');
    const reply = replyForm(page, 'Reply');
    await expect(reply).toBeVisible();
    await expect(fields(reply).to).toHaveValue(PRIYA);
    await expect(fields(reply).body).toBeFocused();

    await page.keyboard.press('Escape'); // leave the text first, as in Gmail
    await expect(fields(reply).body).not.toBeFocused();
    await page.keyboard.press('a');
    const all = replyForm(page, 'Reply all');
    await expect(all).toBeVisible();
    await expect(reply).toHaveCount(0);
    await expect(fields(all).to).toHaveValue(PRIYA);
    await expect(fields(all).body).toBeFocused();

    await page.keyboard.press('Escape');
    await page.keyboard.press('f');
    const fwd = replyForm(page, 'Forward');
    await expect(fwd).toBeVisible();
    await expect(fields(fwd).to).toHaveValue('');
    await expect(fields(fwd).to).toBeFocused();
    await expect(hiddenSubject(fwd)).toHaveValue(`Fwd: ${CONTRACT}`);
    await expect(page.getByRole('form')).toHaveCount(1);
  });

  test('what you type straight after r, before the reply box has arrived, lands in the reply', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, KEYBOARD_ONLY);
    await openEmail(page, CONTRACT);
    // a slow connection: the reply box takes a moment to arrive
    await page.route((url) => url.pathname === '/compose', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.keyboard.press('r');
    await page.keyboard.type('Fair, after lunch'); // f, a and r are shortcuts too
    const reply = replyForm(page, 'Reply');
    await expect(fields(reply).body).toHaveValue('Fair, after lunch');
    await expect(fields(reply).body).toBeFocused();
    await expect(replyForm(page, 'Reply all')).toHaveCount(0);
    await expect(replyForm(page, 'Forward')).toHaveCount(0);
    await expect(page.getByRole('form')).toHaveCount(1);
  });

  test('letters typed into a reply are just text, not shortcuts', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, KEYBOARD_ONLY);
    await openEmail(page, CONTRACT);
    await page.keyboard.press('r');
    const reply = replyForm(page, 'Reply');
    await expect(fields(reply).body).toBeFocused();
    await page.keyboard.type('far away, just a reply');
    await expect(fields(reply).body).toHaveValue('far away, just a reply');
    await expect(replyForm(page, 'Forward')).toHaveCount(0);
    await expect(replyForm(page, 'Reply all')).toHaveCount(0);
    await expect(subjectOf(page)).toHaveText(CONTRACT); // j/k/u didn't move or close anything
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Help me write', () => {
  test('it writes a draft into the reply that you can edit; the busy state shows and clears', async ({ page, sentMail }) => {
    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await expect(f.ask).toBeHidden();
    await expect(f.help).toHaveAttribute('aria-expanded', 'false');
    await press(f.help);
    await expect(f.help).toHaveAttribute('aria-expanded', 'true');
    await expect(f.ask).toBeVisible();
    await expect(f.ask).toBeFocused();
    await expect(f.ask).toHaveAttribute('placeholder', /What should the reply say\?/);
    await f.ask.fill('Say yes, I will bring dessert');

    const asked = page.waitForRequest((r) => r.url().endsWith('/compose/draft') && r.method() === 'POST');
    await f.ask.press('Enter');
    await expect(form.getByText('Writing…')).toBeVisible(); // the AI takes a moment
    const params = new URLSearchParams((await asked).postData() || '');
    expect(params.get('instruction')).toBe('Say yes, I will bring dessert');
    expect(params.get('mode')).toBe('reply');
    expect(params.get('reply_id')).toBe('4');

    await expect(f.body).toHaveValue(DRAFT_YES);
    await expect(form.getByText('Writing…')).toHaveCount(0);
    await expect(note(page, 'Draft ready: read it and edit before sending')).toBeVisible();
    await expect(f.body).toBeFocused();
    // yours to edit; nothing went out
    await f.body.press('Control+End');
    await f.body.pressSequentially(' P.S. Dessert is on me.');
    await expect(f.body).toHaveValue(`${DRAFT_YES} P.S. Dessert is on me.`);
    await expect(form).toBeVisible();
    await expect(note(page, 'Sending…')).toHaveCount(0);
    expect(await sentMail()).toEqual([]);
    // and it's kept like anything you type
    await expect(form.getByText('Draft saved')).toBeVisible();
  });

  test('Create works too, and an instruction with "decline" gives a polite no', async ({ page }) => {
    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await press(f.help);
    await f.ask.fill('Please decline, I am away that weekend');
    await press(f.create);
    await expect(f.body).toHaveValue(DRAFT_NO);
    await expect(form.getByText('Writing…')).toHaveCount(0);
    await expect(note(page, 'Draft ready')).toBeVisible();
    await expect(f.ask).toHaveValue('Please decline, I am away that weekend'); // to ask again if needed
  });

  test("a draft replaces what you'd written, and the snackbar's Undo puts your words back", async ({ page }) => {
    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await f.body.fill('Mum, I think');
    await press(f.help);
    await f.ask.fill('say yes');
    await f.ask.press('Enter');
    await expect(f.body).toHaveValue(DRAFT_YES);
    const undo = note(page, 'Draft ready').getByRole('button', { name: 'Undo' });
    await press(undo);
    await expect(f.body).toHaveValue('Mum, I think');
  });

  test('what you type while Help me write is still working is never lost', async ({ page }) => {
    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await f.body.fill('Hi Mum');
    await press(f.help);
    await f.ask.fill('say yes');
    // the real AI takes a few seconds: hold its answer until the typing below is done
    let answer!: () => void;
    const typed = new Promise<void>((resolve) => { answer = resolve; });
    await page.route('**/compose/draft', async (route) => { await typed; await route.continue(); });
    await f.ask.press('Enter');
    await expect(form.getByText('Writing…')).toBeVisible();
    await press(f.body);
    await f.body.press('Control+End');
    await f.body.pressSequentially(', yes!');
    const meanwhile = await f.body.inputValue(); // what the box holds when the draft lands
    answer();
    await expect(f.body).toHaveValue(DRAFT_YES);
    await expect(form.getByText('Writing…')).toHaveCount(0);
    // Was a bug, now fixed: text typed while Help me write is working is overwritten by the draft, and Undo only brings back what was there before Create
    await press(note(page, 'Draft ready').getByRole('button', { name: 'Undo' }));
    await expect(f.body, 'Undo brings back everything that was in the box').toHaveValue(meanwhile);
  });

  test('the draft, as edited, is what gets sent', async ({ page, sentMail }) => {
    test.slow();
    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await press(f.help);
    await f.ask.fill('decline nicely');
    await f.ask.press('Enter');
    await expect(f.body).toHaveValue(DRAFT_NO);
    await f.body.fill(DRAFT_NO.replace('this time', 'this Sunday'));
    await send(page, form);
    await messageSent(page);
    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: 'sam@gmail.com', to: 'Mum <mum@family.example>', subject: 'Re: Sunday lunch?', in_reply_to: '<m4@demo>' });
    expect(sent[0].body).toMatch(/^Hi,\n\nThanks for thinking of me, but I can't make it this Sunday\.\n\nBest,\nSam\n\nOn .+, Mum <mum@family\.example> wrote:\n> Are you coming on Sunday\?/);
  });

  test('on a Forward it writes the note to go above the email, even with nothing typed', async ({ page }) => {
    await openEmail(page, CONTRACT);
    const form = await startReply(page, 'Forward');
    const f = fields(form);
    await press(f.help);
    await expect(f.ask).toHaveAttribute('placeholder', 'A note to go with it (optional)');
    await press(f.create);
    await expect(f.body).toHaveValue(DRAFT_YES);
    await expect(form.getByText('---------- Forwarded message ---------')).toBeVisible();
  });

  test('a Private sender never goes to the AI: Help me write says so and keeps everything you wrote', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 422/); // the draft is refused on purpose (422)
    // Sender rules: Mum is Private
    await page.goto('/rules');
    await press(page.getByRole('radio', { name: 'Private — never send to AI' }));
    await page.getByRole('textbox', { name: 'Sender or domain' }).fill('mum@family.example');
    await press(page.getByRole('button', { name: 'Add rule' }));
    await expect(note(page, 'Rule saved: Private — never send to AI for mum@family.example')).toBeVisible();

    await openEmail(page, SUNDAY, '/?tab=schedule');
    const form = await startReply(page, 'Reply');
    const f = fields(form);
    await f.body.fill("Yes! I'll bring dessert.");
    await press(f.help);
    await f.ask.fill('make it sound warmer');
    const refused = page.waitForResponse((r) => r.url().endsWith('/compose/draft'));
    await f.ask.press('Enter');
    expect((await refused).status()).toBe(422);

    const err = note(page, PRIVATE_SAYS);
    await expect(err).toBeVisible();
    await expect(err).toHaveAttribute('role', 'alert');
    await expect(form.getByText('Writing…')).toHaveCount(0);
    // nothing lost
    await expect(f.body).toHaveValue("Yes! I'll bring dessert.");
    await expect(f.ask).toHaveValue('make it sound warmer');
    await expect(f.to).toHaveValue('Mum <mum@family.example>');
    await expect(form).toBeVisible();
  });

  test('on a new message with nothing to go on, it asks what to write', async ({ page, allowErrors, isPhone }) => {
    allowErrors.push(/status of 422/); // nothing to go on is turned down (422)
    await page.goto('/');
    await press(page.getByRole('link', { name: /^Compose\b/ }).filter({ visible: true }).first());
    const form = page.getByRole('form', { name: 'New message' });
    await expect(form).toBeVisible();
    if (isPhone) await expect.poll(() => form.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
    const f = fields(form);
    await f.to.fill('pat@example.com');
    await f.subject.fill('March invoice');
    await press(f.help);
    await expect(f.ask).toBeFocused();
    await expect(f.ask).toHaveValue('');
    await f.ask.press('Enter');
    const err = note(page, 'Tell the AI what to write first, e.g. “ask Sam for the March invoice”.');
    await expect(err).toBeVisible();
    await expect(form.getByText('Writing…')).toHaveCount(0);
    await expect(f.body).toHaveValue('');
    await expect(f.to).toHaveValue('pat@example.com');
    await expect(f.subject).toHaveValue('March invoice');

    // the message stays up until dismissed, so it must leave the field and Create in reach
    // Was a bug, now fixed: on a phone the error snackbar sits on top of Help me write's field and Create button in the full-screen compose sheet
    expect.soft(await reachable(f.ask), 'the Help me write field is not under the snackbar').toBe(true);
    expect.soft(await reachable(f.create), 'Create is not under the snackbar').toBe(true);
    if (!(await reachable(f.create))) await press(err.getByRole('button', { name: 'Dismiss' })); // to go on

    // with an instruction it writes
    await f.ask.fill('ask Pat for the March invoice');
    await press(f.create);
    await expect(f.body).toHaveValue(DRAFT_YES);
  });
});

// -----------------------------------------------------------------------------------------------

test.describe('Replying from page 2 of a long list', () => {
  test.use({ mailbox: 'big' });

  test('a reply to an email on page 2 is sent and leaves you on page 2', async ({ page, sentMail }) => {
    test.slow();
    await page.goto('/');
    const rows = list(page, 'Do now').getByRole('article');
    await expect(rows).toHaveCount(50);
    await press(page.getByRole('link', { name: 'Older emails' }).filter({ visible: true }).first());
    await expect(page).toHaveURL(/\/\?after=\d+$/);
    const page2 = new URL(page.url()).search;
    const range = page.getByText(/^51–\d+ of \d+$/).filter({ visible: true }).first();
    await expect(range).toBeVisible();
    const rangeText = await range.innerText();

    // the first email on page 2
    const row = rows.first();
    const subject = await row.getByRole('link').locator('.subject').innerText(); // no own role (see reading.spec.ts)
    const n = /^Subject number (\d+) about something$/.exec(subject)![1];
    await press(row.getByRole('link'));
    await expect(subjectOf(page)).toHaveText(subject);
    await expect(page).toHaveURL(new RegExp(`/\\?open=\\d+&after=${page2.slice(7)}$`));
    const opened = page.url();

    const form = await startReply(page, 'Reply');
    await expect(fields(form).to).toHaveValue(/^Sender \d+ <s\d+@corp\d+\.example>$/);
    await fields(form).body.fill('Thanks, noted.');
    await send(page, form);
    await messageSent(page);
    const sent = await sentMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: `Re: ${subject}`, in_reply_to: `<big${n}@e2e>` });
    expect(sent[0].body).toMatch(/^Thanks, noted\.\n\nOn .+ wrote:\n> Hello, this is a longer email body/);

    // still on that email, still on page 2
    expect(page.url()).toBe(opened);
    await expect(subjectOf(page)).toHaveText(subject);
    await expect(pane(page).getByText('Replied', { exact: true })).toBeVisible();
    await press(backLink(page));
    await expect(page).toHaveURL(new RegExp(`/\\${page2}$`));
    await expect(page.getByText(rangeText).filter({ visible: true }).first()).toBeVisible();
    const answered = list(page, 'Do now').getByRole('article').filter({ hasText: subject });
    await expect(answered).toHaveCount(1);
    await expect(answered).toContainText('Replied');
  });
});
