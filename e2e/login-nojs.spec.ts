// Signing in, the dashboard without JavaScript, and how it copes when the network or the server
// lets it down — on a desktop, a phone and a tablet.
//
// - Sign in (the dashboard started with a password): every page and every form is closed until
//   you sign in, a wrong password is refused (and repeated ones pause sign-in), the right one
//   takes you back to the page you asked for, "Keep me signed in", Log out (drafts on this device
//   are forgotten, Back shows nothing), and what happens when the session ends while you work.
// - No JavaScript: every page is server-rendered and every action is a plain form post, so the
//   inbox, tabs, reading, Move to, read/unread, Refresh, search, Compose / Reply / Forward with
//   the real 10-second Undo window, Help me write, pages of 50 and Sender rules must all work.
// - Resilience with JavaScript on: in-place loads that fail (network error, 500) fall back to a
//   normal page load, a slow network never shows the wrong tab, failed posts say so and keep
//   what you typed, and going offline while writing keeps the draft.
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name):
// - The Settings gear and the Move to menu button are <summary> elements: Playwright sees no
//   button role, so they are found by aria-label (getByLabel / summary[aria-label]).
// - The snackbar box (#flash) has no name; snackbars are found with the shared `snackbar()` helper.
// - On the sign-in page Chrome warns that the password form has no username field (password
//   managers and screen readers expect one, even a hidden one).
import type { Locator, Page } from '@playwright/test';
import { test, expect, snackbar, PASSWORD } from './fixtures';

// `loginRequired` is a worker option, and test.use() can't set those inside a describe. A test
// type with a different default for it gets its own worker (and its own --login server) instead.
const loginTest = test.extend({ loginRequired: [true, { scope: 'worker' }] });

// ---------------------------------------------------------------------------------------------
// helpers

/** Phones and tablets are touched, the desktop is clicked. */
const touch = () => test.info().project.name !== 'desktop';
async function press(target: Locator) {
  await transitionDone(target.page());
  await stillInView(target);
  if (touch()) await target.tap();
  else await target.click();
}

/** Bring the target on screen at once (the page scrolls smoothly, which would move it while it's
 * being tapped) and wait until it stays put: with JavaScript off, every retry Playwright makes
 * costs ~30 s (see transitionDone). */
async function stillInView(target: Locator) {
  let last = '';
  await expect.poll(async () => {
    const spot = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const labels = [...((el as HTMLInputElement).labels ?? [])];
      const onScreen = r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
      const reachable = onScreen && !!hit && (el.contains(hit) || labels.some((l) => l.contains(hit)));
      // off screen, or under something fixed (the Compose button): scroll it to the middle, like a finger would
      if (!reachable) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return reachable ? `${Math.round(r.x)},${Math.round(r.y)}` : '';
    }).catch(() => '');
    const settled = spot !== '' && spot === last;
    last = spot;
    return settled;
  }, { message: 'the target is on screen, uncovered and still', intervals: [60] }).toBe(true);
}

/** Every full page load cross-fades (CSS `@view-transition`); while it runs (~0.45 s) the page
 * can't be tapped. Playwright waits that out with timers inside the page, and with JavaScript
 * off those don't run, so a tap right after a page load would hang for 30 s. Wait here instead. */
async function transitionDone(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.getAnimations({ subtree: true })
    .filter((a) => String((a.effect as KeyframeEffect | null)?.pseudoElement ?? '').startsWith('::view-transition'))
    .length).catch(() => -1), { message: 'the page transition has finished', intervals: [30, 50, 100] }).toBe(0);
}

const SUBJECT = {
  contract: 'Contract renewal needs your signature today',
  payment: 'Payment failed for velocity.example',
  q4: 'Q4 planning doc — comments welcome',
  lunch: 'Sunday lunch?',
  otp: 'Your OTP is 482913',
  invoice: 'Quick question about the invoice',
  stories: 'Top stories for you',
  digest: 'Your weekly team digest',
  trip: 'Trip photos',
  receipt: 'Receipt from Velocity Growth',
};

/** The list of one inbox tab (a <section> named after the tab). */
const tabList = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const rows = (page: Page, name: string) => tabList(page, name).getByRole('article');
const inboxTabs = (page: Page) => page.getByRole('navigation', { name: 'Inbox tabs' });
const tab = (page: Page, name: string) => inboxTabs(page).getByRole('link', { name: new RegExp(`^${name}\\b`) });
/** An email's row in the list (its link is named by sender, subject and summary). */
const rowLink = (page: Page, subject: string) =>
  page.getByRole('link', { name: new RegExp(subject.replace(/[.?*+()[\]]/g, '\\$&')) }).first();
const openedSubject = (page: Page, subject: string) => page.getByRole('heading', { name: subject, exact: true });
const aiCard = (page: Page) => page.getByRole('region', { name: 'AI summary and priority' });
const moveButton = (page: Page, label: string) => aiCard(page).getByRole('button', { name: new RegExp(`^${label}\\b`) });
const note = (page: Page, text: string | RegExp) => snackbar(page).filter({ hasText: text });

/** The visible Compose control: sidebar (desktop), icon rail (tablet) or the button bottom right (phone). */
const composeControl = (page: Page) =>
  page.getByRole('link', { name: /^Compose\b/ }).filter({ visible: true }).first();
function fields(form: Locator) {
  return {
    from: form.getByLabel('From'),
    to: form.getByRole('textbox', { name: 'To', exact: true }),
    subject: form.getByRole('textbox', { name: 'Subject', exact: true }),
    body: form.getByRole('textbox', { name: 'Message', exact: true }),
    help: form.getByRole('textbox', { name: 'Help me write' }),
  };
}
const sendButton = (form: Locator) => form.getByRole('button', { name: 'Send', exact: true });

async function signIn(page: Page, password = PASSWORD, { remember = false } = {}) {
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Password').fill(password);
  if (remember) {
    const box = page.getByRole('checkbox', { name: /Keep me signed in/ });
    await press(box);
    await expect(box).toBeChecked();
  }
  await press(page.getByRole('button', { name: 'Sign in' }));
}

/** On the sign-in page; `next` is where it will take you afterwards (null: none given). */
async function expectSignInPage(page: Page, next?: string | null) {
  await expect(page).toHaveURL((u) => u.pathname === '/login'
    && (next === undefined || u.searchParams.get('next') === next));
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
}

const at = (path: string) => (u: URL) => u.pathname + u.search === path;

/** The page checks for new mail every few seconds; one that lands just after Log out gets a 401
 * and goes to sign in itself (with ?next=), racing the Log out redirect. Both end on sign in. */
const LOGGED_OUT_CHECK = /status of 401/;

/** The Settings gear (a <summary>) and the Log out button in its menu. */
async function logOut(page: Page) {
  await press(page.getByLabel('Settings', { exact: true }));
  const logout = page.getByRole('button', { name: 'Log out' });
  await expect(logout).toBeVisible();
  await press(logout);
}

async function openCompose(page: Page) {
  await press(composeControl(page));
  const form = page.getByRole('form', { name: 'New message' });
  await expect(fields(form).to).toBeVisible();
  return form;
}

// =============================================================================================
// Signing in
// =============================================================================================

loginTest.describe('Sign in', () => {
  loginTest('every page sends you to sign in first, and shows no mail', async ({ page }) => {
    const paths = ['/', '/?tab=later', '/?view=all', '/?view=matrix', '/?open=1', '/message/1',
      '/compose', '/compose?mode=reply&reply=1', '/sent', '/rules'];
    for (const path of paths) {
      await page.goto(path);
      await expectSignInPage(page, path);
      await expect(page.getByText(SUBJECT.contract), `no mail on the sign-in page for ${path}`).toHaveCount(0);
    }
  });

  loginTest('the data behind the pages is closed too, but the page styles load', async ({ page }) => {
    for (const path of ['/api/stats', '/api/outbox/1', '/message/1?partial=1', '/compose?partial=window', '/?tab=later']) {
      const r = await page.request.get(path, { headers: { Accept: 'application/json' }, maxRedirects: 0 });
      expect(r.status(), path).toBe(401);
      const body = await r.text();
      expect(body, path).toContain('Please sign in again');
      expect(body, path).not.toContain('Contract renewal');
    }
    const css = await page.request.get('/static/style.css');
    expect(css.status(), 'the sign-in page needs its styles').toBe(200);
  });

  loginTest('forms can\'t be sent without signing in, and nothing changes', async ({ page, sentMail }) => {
    const posts: [string, Record<string, string>][] = [
      ['/message/1/score', { move: 'later' }],
      ['/message/1/read', { is_read: '1' }],
      ['/rules', { kind: 'vip', pattern: 'boss@corp.example' }],
      ['/rules/1/delete', {}],
      ['/compose/send', { from_account: 'sam@gmail.com', to: 'x@example.com', subject: 'Sneaky', body: 'Hi' }],
      ['/compose/draft', { instruction: 'say hi' }],
      ['/sync', {}],
      ['/outbox/1/undo', {}],
    ];
    for (const [path, form] of posts) {
      const r = await page.request.post(path, { form, maxRedirects: 0 });
      expect(r.status(), `POST ${path}`).toBe(401);
      expect(await r.json(), `POST ${path}`).toMatchObject({ ok: false, message: 'Please sign in again' });
    }
    await page.goto('/');
    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    await expect(rows(page, 'Do now').filter({ hasText: SUBJECT.contract }), 'not moved').toBeVisible();
    await expect(rowLink(page, SUBJECT.contract), 'still unread').toHaveAccessibleName(/^Unread:/);
    await page.goto('/rules');
    await expect(page.getByText('None yet.'), 'no rule was added').toHaveCount(3);
    expect(await sentMail(), 'nothing was sent').toEqual([]);
  });

  loginTest('a form posted from another site is refused even when signed in', async ({ page }) => {
    await page.goto('/');
    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    const r = await page.request.post('/message/2/score', {
      form: { move: 'later' }, headers: { Origin: 'http://evil.example' }, maxRedirects: 0 });
    expect(r.status()).toBe(403);
    expect(await r.text()).toContain('Cross-site request blocked');
    await page.reload();
    await expect(rows(page, 'Do now').filter({ hasText: SUBJECT.payment }), 'not moved').toBeVisible();
  });

  loginTest('a wrong password shows an error and lets nobody in; the right one then opens the page you asked for',
    async ({ page, allowErrors }) => {
      allowErrors.push(/status of 401/);
      await page.goto('/?tab=later');
      await expectSignInPage(page, '/?tab=later');
      await signIn(page, 'correct battery');
      const error = page.getByRole('alert');
      await expect(error).toHaveText(/^That password isn't right\./);
      const password = page.getByLabel('Password');
      await expect(password).toHaveAttribute('aria-invalid', 'true');
      await expect(password, 'the wrong password is not kept in the field').toHaveValue('');
      await expect(page.getByText(SUBJECT.stories)).toHaveCount(0);
      // still nobody in
      await page.goto('/?tab=later');
      await expectSignInPage(page, '/?tab=later');
      await signIn(page, 'correct battery');
      await expect(error).toBeVisible();
      await signIn(page);
      await expect(page).toHaveURL(at('/?tab=later'));
      await expect(tab(page, 'Later')).toHaveAttribute('aria-current', 'page');
      await expect(rows(page, 'Later').filter({ hasText: SUBJECT.stories })).toBeVisible();
    });

  loginTest('signing in from a link to an email opens that email', async ({ page }) => {
    await page.goto('/?tab=quick&open=6');
    await expectSignInPage(page, '/?tab=quick&open=6');
    await signIn(page);
    await expect(page).toHaveURL(at('/?tab=quick&open=6'));
    await expect(openedSubject(page, SUBJECT.invoice)).toBeVisible();
  });

  loginTest('a sign-in link can\'t send you to another site', async ({ page, baseURL }) => {
    for (const next of ['//evil.example/inbox', 'https://evil.example/', '/\\evil.example']) {
      await page.goto('/login?next=' + encodeURIComponent(next));
      await signIn(page);
      await expect(page, `next=${next}`).toHaveURL(baseURL!);
      await page.context().clearCookies();
    }
  });

  loginTest('"Keep me signed in" remembers this device for 30 days; otherwise the browser forgets it',
    async ({ page, context }) => {
      await page.goto('/');
      await signIn(page);
      await expect(page).toHaveURL(at('/'));
      let cookie = (await context.cookies()).find((c) => c.name === 'inbox_session');
      expect(cookie, 'a session cookie').toBeTruthy();
      expect(cookie!.expires, 'gone when the browser closes').toBe(-1);
      expect(cookie!.httpOnly).toBe(true);
      expect(cookie!.sameSite).toBe('Lax');

      await context.clearCookies();
      await page.goto('/');
      await signIn(page, PASSWORD, { remember: true });
      await expect(page).toHaveURL(at('/'));
      cookie = (await context.cookies()).find((c) => c.name === 'inbox_session');
      const days = (cookie!.expires - Date.now() / 1000) / 86400;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
    });

  loginTest('ten wrong passwords pause signing in, even with the right one', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 40[19]/, /status of 429/);
    await page.goto('/');
    for (let i = 0; i < 10; i++) {
      await signIn(page, `guess ${i}`);
      await expect(page.getByRole('alert')).toHaveText(/^That password isn't right/);
    }
    await signIn(page);
    await expect(page.getByRole('alert')).toHaveText(/^Too many wrong attempts\. Try again in 1[45] minutes\./);
    await page.goto('/');
    await expectSignInPage(page, '/');
  });

  loginTest('the sign-in page fits the screen, with 16px text fields and big targets', async ({ page }) => {
    await page.goto('/sent');
    await expectSignInPage(page, '/sent');
    const password = page.getByLabel('Password');
    await expect(password, 'ready to type').toBeFocused();
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth,
      font: parseFloat(getComputedStyle(document.querySelector('input[name=password]')!).fontSize),
    }));
    expect(size.scroll, 'no sideways scrolling').toBeLessThanOrEqual(size.width);
    expect(size.font, 'iOS zooms into text fields under 16px').toBeGreaterThanOrEqual(16);
    const vw = page.viewportSize()!.width;
    const card = (await page.locator('form').boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(vw);
    const signInButton = page.getByRole('button', { name: 'Sign in' });
    await expect(signInButton, 'no scrolling to sign in').toBeInViewport();
    expect((await signInButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect((await password.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const remember = page.getByText('Keep me signed in on this device for 30 days');
    expect((await remember.boundingBox())!.height, 'the whole line toggles the checkbox').toBeGreaterThanOrEqual(44);
    await press(remember);
    await expect(page.getByRole('checkbox', { name: /Keep me signed in/ })).toBeChecked();
  });

  loginTest('Log out returns to sign in and forgets the drafts kept on this device', async ({ page, allowErrors }) => {
    allowErrors.push(LOGGED_OUT_CHECK);
    await page.goto('/');
    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    const form = await openCompose(page);
    const f = fields(form);
    await f.to.fill('friend@example.com');
    await f.subject.fill('Private plans');
    await f.body.fill('Only for this device');
    await expect(form.getByText('Draft saved')).toBeVisible();
    const drafts = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draft:')));
    expect(await drafts(), 'kept while signed in').toEqual(['draft:new:new']);
    await press(form.getByRole('button', { name: 'Save & close' }));
    await expect(form).toBeHidden();

    await logOut(page);
    await expectSignInPage(page);
    expect(await drafts(), 'forgotten after Log out').toEqual([]);
    await page.goto('/');
    await expectSignInPage(page, '/');

    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    const again = await openCompose(page);
    await expect(fields(again).body).toHaveValue('');
    await expect(again.getByText('Draft restored')).toHaveCount(0);
  });

  loginTest('after Log out, Back doesn\'t show your mail', async ({ page, allowErrors }) => {
    allowErrors.push(LOGGED_OUT_CHECK);
    await page.goto('/');
    await signIn(page);
    await expect(rows(page, 'Do now').filter({ hasText: SUBJECT.contract })).toBeVisible();
    await logOut(page);
    await expectSignInPage(page);
    await page.goBack();
    await expectSignInPage(page);
    await expect(page.getByText(SUBJECT.contract)).toHaveCount(0);
  });

  loginTest('when the session ends, the next tab you pick asks you to sign in, then shows it', async ({ page, context }) => {
    await page.goto('/');
    const firstCheck = page.waitForResponse((r) => r.url().endsWith('/api/stats'));
    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    await firstCheck; // the page's own check for new mail has run: the next one is 15 s away
    await context.clearCookies(); // the session ended (expired, or signed out elsewhere)
    await press(page.getByRole('link', { name: 'Unread', exact: true }));
    await expectSignInPage(page, '/?unread=1');
    await signIn(page);
    await expect(page).toHaveURL(at('/?unread=1'));
    await expect(page.getByRole('link', { name: 'Unread', exact: true })).toHaveAttribute('aria-current', 'true');
    await expect(rows(page, 'Do now')).toHaveCount(2);
  });

  loginTest('coming back to a page left open after the session ended asks you to sign in', async ({ page, context, allowErrors }) => {
    allowErrors.push(/status of 401/);
    await page.goto('/?tab=schedule');
    await signIn(page);
    await expect(rows(page, 'Schedule').filter({ hasText: SUBJECT.lunch })).toBeVisible();
    await context.clearCookies();
    // the user switches back to this browser tab
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expectSignInPage(page, '/?tab=schedule');
    await signIn(page);
    await expect(page).toHaveURL(at('/?tab=schedule'));
  });

  loginTest('moving an email after the session ended asks you to sign in and changes nothing', async ({ page, context, allowErrors }) => {
    allowErrors.push(/status of 401/);
    await page.goto('/');
    await signIn(page);
    await press(rowLink(page, SUBJECT.payment));
    await expect(openedSubject(page, SUBJECT.payment)).toBeVisible();
    await context.clearCookies();
    await press(moveButton(page, 'Later'));
    await expectSignInPage(page, '/?open=2');
    await signIn(page);
    await expect(page).toHaveURL(at('/?open=2'));
    await expect(moveButton(page, 'Do now'), 'still in Do now').toHaveAttribute('aria-pressed', 'true');
  });

  // By design (prefs.js, login.html): when the session ends, drafts saved in this browser are
  // forgotten too, so a shared or public computer keeps nothing. Nothing is sent without asking.
  loginTest('sending after the session ended asks you to sign in and sends nothing; the saved draft is forgotten', async ({ page, context, allowErrors, sentMail }) => {
    allowErrors.push(/status of 401/);
    await page.goto('/');
    const firstCheck = page.waitForResponse((r) => r.url().endsWith('/api/stats'));
    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    const form = await openCompose(page);
    const f = fields(form);
    await f.to.fill('friend@example.com');
    await f.subject.fill('A long letter');
    await f.body.fill('Some careful writing.');
    await expect(form.getByText('Draft saved')).toBeVisible();
    // the page's own session check has run (it would also send you to sign in, 15 s later)
    await firstCheck;
    await context.clearCookies(); // e.g. 12 hours without "Keep me signed in" are up
    await press(sendButton(form));
    await expectSignInPage(page);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('draft:'))),
      'drafts kept in this browser are gone').toEqual([]);
    await signIn(page);
    await expect(page).toHaveURL(at('/'));
    const again = await openCompose(page);
    await expect(fields(again).body).toHaveValue('');
    expect(await sentMail(), 'and nothing was sent without asking').toEqual([]);
  });

  loginTest.describe('without JavaScript', () => {
    loginTest.use({ javaScriptEnabled: false });

    loginTest('signing in and out works', async ({ page }) => {
      await page.goto('/sent');
      await expectSignInPage(page, '/sent');
      await signIn(page);
      await expect(page).toHaveURL(at('/sent'));
      await expect(page.getByRole('heading', { level: 1, name: 'Sent' })).toBeVisible();
      await logOut(page);
      await expectSignInPage(page, null);
      await page.goto('/sent');
      await expectSignInPage(page, '/sent');
    });

    // APP BUG: without JS, a form posted after the session ended shows raw JSON ({"ok":false,…}) instead of the sign-in page
    loginTest('a button pressed after the session ended goes to sign in, not a page of code', async ({ page, context, allowErrors }) => {
      allowErrors.push(/status of 401/);
      await page.goto('/?open=2');
      await signIn(page);
      await expect(openedSubject(page, SUBJECT.payment)).toBeVisible();
      await context.clearCookies();
      await press(moveButton(page, 'Later'));
      await expectSignInPage(page);
      await expect(page.getByText('"ok"')).toHaveCount(0);
    });
  });
});

// =============================================================================================
// Without JavaScript
// =============================================================================================

test.describe('Without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test.describe('the inbox', () => {
    test('lists the Do now mail', async ({ page }) => {
      await page.goto('/');
      await expect(tab(page, 'Do now')).toHaveAttribute('aria-current', 'page');
      await expect(rows(page, 'Do now')).toHaveCount(2);
      await expect(rows(page, 'Do now').nth(0)).toContainText(SUBJECT.contract);
      await expect(rows(page, 'Do now').nth(1)).toContainText(SUBJECT.payment);
    });

    // APP BUG: without JS on a phone the menu becomes a screen-high column of unlabeled icons above the inbox (rail CSS applies)
    test('the first email is on screen without scrolling', async ({ page }) => {
      await page.goto('/');
      await expect(rows(page, 'Do now').first()).toBeInViewport();
    });

    test('every tab is a plain link that opens its mail', async ({ page }) => {
      await page.goto('/');
      const expected: [string, string, string, string[]][] = [
        ['Schedule', 'Schedule', '/?tab=schedule', [SUBJECT.q4, SUBJECT.lunch]],
        ['Quick reply', 'Quick reply', '/?tab=quick', [SUBJECT.otp, SUBJECT.invoice]],
        ['Later', 'Later', '/?tab=later', [SUBJECT.stories, SUBJECT.digest]],
        ['Not sorted', 'Not sorted yet', '/?tab=unsorted', [SUBJECT.trip, SUBJECT.receipt]],
        ['Do now', 'Do now', '/', [SUBJECT.contract, SUBJECT.payment]],
      ];
      for (const [name, list, url, subjects] of expected) {
        await press(tab(page, name));
        await expect(page).toHaveURL(at(url));
        await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
        await expect(rows(page, list)).toHaveCount(subjects.length);
        for (const s of subjects) await expect(rows(page, list).filter({ hasText: s })).toBeVisible();
      }
    });

    test('All mail and the Priority matrix open from the menu', async ({ page }) => {
      await page.goto('/');
      const menu = page.getByRole('navigation', { name: 'Mailboxes' });
      await press(menu.getByRole('link', { name: /^All mail/ }));
      await expect(page).toHaveURL(at('/?view=all'));
      await expect(rows(page, 'All email by priority')).toHaveCount(10);
      await press(menu.getByRole('link', { name: /^Priority matrix/ }));
      await expect(page).toHaveURL(at('/?view=matrix'));
      for (const h of ['Do now', 'Schedule', 'Quick reply', 'Later']) {
        await expect(page.getByRole('heading', { level: 2, name: h, exact: true })).toBeVisible();
      }
    });

    test('search finds mail', async ({ page }) => {
      await page.goto('/');
      const search = page.getByRole('searchbox', { name: 'Search mail' });
      await search.fill('invoice');
      await search.press('Enter');
      await expect(page).toHaveURL(at('/?view=all&q=invoice'));
      await expect(rows(page, 'All email by priority')).toHaveCount(1);
      await expect(rows(page, 'All email by priority').first()).toContainText(SUBJECT.invoice);
    });

    test('Refresh fetches mail and says so, and the note can be dismissed', async ({ page }) => {
      await page.goto('/?tab=later');
      await press(page.getByRole('button', { name: 'Refresh' }));
      await expect(page).toHaveURL(at('/?tab=later'));
      const done = note(page, /^Sync done\./);
      await expect(done).toHaveText('Sync done. sync: new: 0, accounts: 3');
      await expect(done).toHaveAttribute('role', 'status');
      await press(done.getByRole('link', { name: 'Dismiss' }));
      await expect(page).toHaveURL(at('/?tab=later'));
      await expect(snackbar(page)).toHaveCount(0);
      await expect(rows(page, 'Later')).toHaveCount(2);
    });
  });

  test.describe('reading', () => {
    test('opening an email shows it, and Back to the list returns', async ({ page }) => {
      await page.goto('/');
      await press(rowLink(page, SUBJECT.contract));
      await expect(page).toHaveURL(at('/?open=1'));
      await expect(openedSubject(page, SUBJECT.contract)).toBeVisible();
      await expect(page.getByText(/Legal needs it signed by 5 pm today/)).toBeVisible();
      await expect(aiCard(page)).toContainText('Sign the Acme renewal contract by 5 pm today');
      await press(page.getByRole('link', { name: 'Back to the list' }));
      await expect(page).toHaveURL(at('/'));
      await expect(rows(page, 'Do now')).toHaveCount(2);
    });

    test('Move to in the summary moves the email and says so', async ({ page }) => {
      await page.goto('/');
      await press(rowLink(page, SUBJECT.payment));
      await expect(page).toHaveURL(at('/?open=2'));
      await expect(moveButton(page, 'Do now')).toHaveAttribute('aria-pressed', 'true');
      await press(moveButton(page, 'Later'));
      await expect(page).toHaveURL(at('/?open=2'));
      await expect(note(page, 'Moved to')).toHaveText('Moved to “Later”. Future scores will learn from this.');
      await expect(moveButton(page, 'Later')).toHaveAttribute('aria-pressed', 'true');
      await press(page.getByRole('link', { name: 'Back to the list' }));
      await expect(rows(page, 'Do now')).toHaveCount(1);
      await press(tab(page, 'Later'));
      await expect(rows(page, 'Later').filter({ hasText: SUBJECT.payment })).toBeVisible();
      await page.reload();
      await expect(rows(page, 'Later')).toHaveCount(3);
    });

    test('the Move to menu works too', async ({ page }) => {
      await page.goto('/?open=2');
      // a <summary>: no button role (see the note at the top)
      await press(page.locator('summary[aria-label="Move to"]'));
      const menu = page.getByRole('group', { name: 'Move to' }).first();
      await press(menu.getByRole('button', { name: /^Quick reply\b/ }));
      await expect(note(page, 'Moved to')).toHaveText('Moved to “Quick reply”. Future scores will learn from this.');
      await page.goto('/?tab=quick');
      await expect(rows(page, 'Quick reply').filter({ hasText: SUBJECT.payment })).toBeVisible();
    });

    test('Mark as read and Mark as unread work', async ({ page }) => {
      await page.goto('/');
      await expect(rowLink(page, SUBJECT.contract)).toHaveAccessibleName(/^Unread:/);
      await press(rowLink(page, SUBJECT.contract));
      await press(page.getByRole('button', { name: 'Mark as read' }));
      await expect(note(page, 'Marked')).toHaveText('Marked as read');
      await press(page.getByRole('link', { name: 'Back to the list' }));
      await expect(rowLink(page, SUBJECT.contract)).not.toHaveAccessibleName(/^Unread:/);
      await press(rowLink(page, SUBJECT.contract));
      await press(page.getByRole('button', { name: 'Mark as unread' }));
      await expect(note(page, 'Marked')).toHaveText('Marked as unread');
      await press(page.getByRole('link', { name: 'Back to the list' }));
      await expect(rowLink(page, SUBJECT.contract)).toHaveAccessibleName(/^Unread:/);
    });

    test('a rule for the sender of an open email can be added and removed', async ({ page }) => {
      await page.goto('/?tab=unsorted');
      await press(rowLink(page, SUBJECT.trip));
      await expect(page).toHaveURL(at('/?tab=unsorted&open=9'));
      await press(page.getByText('Rules for this sender'));
      await expect(page.getByLabel('Apply to')).toHaveValue('rahul@friends.example');
      await press(page.getByRole('button', { name: 'Always important (VIP)' }));
      await expect(page).toHaveURL(at('/?tab=unsorted&open=9'));
      await expect(note(page, 'Rule saved')).toHaveText(
        'Rule saved: Always important (VIP) for rahul@friends.example. 1 waiting email is sorted at the next sync.');
      const remove = page.getByRole('button', { name: 'Remove rule Always important (VIP) for rahul@friends.example' });
      await expect(remove).toBeVisible();
      await press(remove);
      await expect(note(page, 'Rule removed')).toBeVisible();
      await expect(remove).toHaveCount(0);
    });
  });

  test.describe('writing', () => {
    test('the Compose page sends after the 10-second Undo window', async ({ page, sentMail }) => {
      await page.goto('/');
      await press(composeControl(page));
      await expect(page).toHaveURL((u) => u.pathname === '/compose');
      await expect(page.getByRole('heading', { level: 1, name: 'New message' })).toBeVisible();
      const form = page.getByRole('form', { name: 'New message' });
      const f = fields(form);
      await f.to.fill('friend@example.com');
      await f.subject.fill('Lunch on Friday?');
      await f.body.fill('Are you free on Friday at 1?');
      await press(sendButton(form));
      await expect(page).toHaveURL(at('/sent'));
      await expect(note(page, 'Sending in')).toHaveText('Sending in 10 seconds… (Undo is here on Sent)');
      const item = page.getByRole('listitem').filter({ hasText: 'Lunch on Friday?' });
      await expect(item).toContainText('Sending…');
      await expect(item.getByRole('button', { name: 'Undo' })).toBeVisible();
      expect(await sentMail(), 'not before the Undo time is up').toEqual([]);
      await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
      const [sent] = await sentMail();
      expect(sent).toMatchObject({ from: 'sam@gmail.com', to: 'friend@example.com', subject: 'Lunch on Friday?', in_reply_to: null });
      expect(sent.body).toContain('Are you free on Friday at 1?');
      await page.reload();
      await expect(item).not.toContainText('Sending…');
      await expect(item.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    });

    test('a mistake in the address says what\'s wrong and keeps what you wrote', async ({ page, sentMail, allowErrors }) => {
      allowErrors.push(/status of 400/);
      await page.goto('/compose');
      const form = page.getByRole('form', { name: 'New message' });
      const f = fields(form);
      await f.to.fill('friend-at-example.com');
      await f.subject.fill('Hello');
      await f.body.fill('Some text I typed');
      await press(sendButton(form));
      await expect(form.getByRole('alert')).toHaveText('To: “friend-at-example.com” isn\'t an email address.');
      await expect(f.to).toHaveValue('friend-at-example.com');
      await expect(f.subject).toHaveValue('Hello');
      await expect(f.body).toHaveValue('Some text I typed');
      expect(await sentMail()).toEqual([]);
    });

    test('Undo on the Sent page stops the email and opens it again to edit and send', async ({ page, sentMail }) => {
      await page.goto('/compose?next=/sent');
      const form = page.getByRole('form', { name: 'New message' });
      const f = fields(form);
      await f.to.fill('team@example.com');
      await f.subject.fill('Wrong figures');
      await f.body.fill('The total is 12');
      await press(sendButton(form));
      await expect(page).toHaveURL(at('/sent'));
      await press(page.getByRole('listitem').filter({ hasText: 'Wrong figures' }).getByRole('button', { name: 'Undo' }));
      await expect(page).toHaveURL((u) => u.pathname === '/compose' && !!u.searchParams.get('draft'));
      await expect(note(page, 'Sending undone')).toBeVisible();
      await expect(f.to).toHaveValue('team@example.com');
      await expect(f.subject).toHaveValue('Wrong figures');
      await expect(f.body).toHaveValue('The total is 12');
      await f.body.fill('The total is 21');
      await press(sendButton(form));
      await expect(page).toHaveURL(at('/sent'));
      await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
      const sent = await sentMail();
      expect(sent, 'only the corrected email went out').toHaveLength(1);
      expect(sent[0].body).toContain('The total is 21');
    });

    test('Reply from an email sends a threaded reply to the sender', async ({ page, sentMail }) => {
      await page.goto('/?open=1');
      await press(page.getByRole('link', { name: 'Reply', exact: true }).filter({ visible: true }).last());
      await expect(page).toHaveURL((u) => u.pathname === '/compose' && u.searchParams.get('mode') === 'reply'
        && u.searchParams.get('reply') === '1');
      await expect(page.getByRole('heading', { level: 1, name: 'Reply' })).toBeVisible();
      await expect(page.getByText(`Replying to ${SUBJECT.contract} from Priya Raman`)).toBeVisible();
      const form = page.getByRole('form', { name: 'Reply' });
      const f = fields(form);
      await expect(f.to).toHaveValue(/priya@acme\.example/);
      await expect(f.subject).toHaveValue(`Re: ${SUBJECT.contract}`);
      await f.body.fill('Signed and sent back.');
      await press(sendButton(form));
      await expect(page, 'without JavaScript a send lands on Sent, where Undo is').toHaveURL(at('/sent'));
      await expect(note(page, 'Sending in')).toBeVisible();
      await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
      const [sent] = await sentMail();
      expect(sent).toMatchObject({ from: 'sam.work@gmail.com', subject: `Re: ${SUBJECT.contract}`, in_reply_to: '<m1@demo>' });
      expect(sent.to).toContain('priya@acme.example');
      expect(sent.body).toContain('Signed and sent back.');
    });

    test('/compose?mode=forward&reply=ID forwards the email with its text', async ({ page, sentMail }) => {
      await page.goto('/compose?mode=forward&reply=3');
      await expect(page.getByRole('heading', { level: 1, name: 'Forward' })).toBeVisible();
      const form = page.getByRole('form', { name: 'Forward' });
      const f = fields(form);
      await expect(f.to).toHaveValue('');
      await expect(f.subject).toHaveValue(`Fwd: ${SUBJECT.q4}`);
      await f.to.fill('boss@example.com');
      await f.body.fill('FYI');
      await press(sendButton(form));
      await expect(page).toHaveURL(at('/sent'));
      await expect(note(page, 'Sending in')).toBeVisible();
      await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
      const [sent] = await sentMail();
      expect(sent).toMatchObject({ from: 'sam.work@gmail.com', to: 'boss@example.com', subject: `Fwd: ${SUBJECT.q4}`, in_reply_to: null });
      expect(sent.body).toContain('FYI');
      expect(sent.body).toContain('Sharing the draft Q4 plan');
    });

    test('Help me write drafts the reply', async ({ page }) => {
      await page.goto('/compose?mode=reply&reply=4');
      const form = page.getByRole('form', { name: 'Reply' });
      const f = fields(form);
      await f.help.fill('decline, I am away that weekend');
      await press(form.getByRole('button', { name: 'Create' }));
      await expect(f.body).toHaveValue(/I can't make it this time\./);
      await expect(f.to).toHaveValue(/mum@family\.example/);
      await expect(f.subject).toHaveValue('Re: Sunday lunch?');
    });

    // APP BUG: on a phone the Compose fields are 15px (Help me write 14px), so iPhone Safari zooms the page in when you tap into them
    test('on a phone the Compose fields are 16px, so the iPhone doesn\'t zoom in', async ({ page, isPhone }) => {
      test.skip(!isPhone, 'only iPhone Safari zooms into text fields under 16px');
      await page.goto('/compose');
      const f = fields(page.getByRole('form', { name: 'New message' }));
      const all = [['From', f.from], ['To', f.to], ['Subject', f.subject], ['Message', f.body], ['Help me write', f.help]] as const;
      for (const [name, field] of all) {
        const size = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect.soft(size, `${name}: font size in px`).toBeGreaterThanOrEqual(16);
      }
    });

    // APP BUG: without JS the Cc, Bcc and "Help me write" buttons are shown but do nothing (those rows are already open)
    test('Compose shows no buttons that do nothing', async ({ page }) => {
      await page.goto('/compose');
      const form = page.getByRole('form', { name: 'New message' });
      await expect(form.getByRole('textbox', { name: 'Cc', exact: true }), 'Cc is already open').toBeVisible();
      await expect(fields(form).help, 'Help me write is already open').toBeVisible();
      await expect(form.getByRole('button', { name: 'Cc', exact: true })).toBeHidden();
      await expect(form.getByRole('button', { name: 'Bcc', exact: true })).toBeHidden();
      await expect(form.getByRole('button', { name: 'Help me write' })).toBeHidden();
    });
  });

  // APP BUG: without JS the Main menu button is shown on desktop and tablet but does nothing (hidden only on phones)
  test('the Main menu button is hidden when it can\'t open anything', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Mailboxes' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Main menu' })).toBeHidden();
  });

  test.describe('long lists (big mailbox)', () => {
    test.use({ mailbox: 'big' });

    /** Each row's text (textContent: rows far off screen aren't laid out, so innerText would be empty). */
    async function listed(page: Page, list: string) {
      const r = rows(page, list);
      await expect(r).toHaveCount(50);
      return r.evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
    }
    const range = (page: Page) => page.getByText(/^\d+–\d+ of \d+$/).filter({ visible: true }).first();

    test('a tab shows 50 at a time, with working Older and Newer links', async ({ page }) => {
      await page.goto('/?tab=later');
      await expect(range(page)).toHaveText(/^1–50 of \d+$/);
      const total = (await range(page).textContent())!.split(' of ')[1];
      const first = await listed(page, 'Later');
      await press(page.getByRole('link', { name: 'Older emails' }).filter({ visible: true }).first());
      await expect(page).toHaveURL((u) => u.searchParams.get('tab') === 'later' && !!u.searchParams.get('after'));
      await expect(range(page)).toHaveText(`51–100 of ${total}`);
      const second = await listed(page, 'Later');
      expect(second.filter((t) => first.includes(t)), 'no email on both pages').toEqual([]);
      await press(page.getByRole('link', { name: 'Newer emails' }).filter({ visible: true }).first());
      await expect(page).toHaveURL(at('/?tab=later'));
      await expect(range(page)).toHaveText(`1–50 of ${total}`);
      expect(await listed(page, 'Later')).toEqual(first);
    });

    test('All mail pages through all 1,500 emails', async ({ page }) => {
      await page.goto('/?view=all');
      await expect(range(page)).toHaveText('1–50 of 1500');
      const older = page.getByRole('link', { name: 'Older emails' }).filter({ visible: true }).first();
      await press(older);
      await expect(range(page)).toHaveText('51–100 of 1500');
      await press(older);
      await expect(range(page)).toHaveText('101–150 of 1500');
      await expect(page.getByRole('link', { name: 'Newer emails' }).filter({ visible: true })).not.toHaveCount(0);
    });
  });

  test.describe('Sender rules', () => {
    test('add a rule, then remove it', async ({ page }) => {
      await page.goto('/rules');
      await press(page.getByRole('radio', { name: 'Always important (VIP)' }));
      await page.getByLabel('Sender or domain').fill('Boss@Corp.example');
      await press(page.getByRole('button', { name: 'Add rule' }));
      await expect(page).toHaveURL(at('/rules'));
      await expect(note(page, 'Rule saved')).toHaveText(
        'Rule saved: Always important (VIP) for boss@corp.example. It applies to their new mail from now on.');
      const item = page.getByRole('listitem').filter({ hasText: 'boss@corp.example' });
      await expect(item).toContainText('0 emails');

      await press(page.getByRole('radio', { name: 'Always low priority' }));
      await expect(page.getByRole('radio', { name: 'Always low priority' })).toBeChecked();
      await page.getByLabel('Sender or domain').fill('news.example');
      await press(page.getByRole('button', { name: 'Add rule' }));
      await expect(page.getByRole('listitem').filter({ hasText: '@news.example' })).toBeVisible();
      await expect(page.getByText('None yet.')).toHaveCount(1);

      await press(page.getByRole('button', { name: 'Remove rule boss@corp.example' }));
      await expect(note(page, 'Rule removed')).toBeVisible();
      await expect(item).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('listitem').filter({ hasText: 'boss@corp.example' })).toHaveCount(0);
      await expect(page.getByRole('listitem').filter({ hasText: '@news.example' })).toBeVisible();
    });

    test('a rule with a typo says what\'s wrong and keeps what you typed', async ({ page }) => {
      await page.goto('/rules');
      await press(page.getByRole('radio', { name: 'Private — never send to AI' }));
      const input = page.getByLabel('Sender or domain');
      await input.fill('nope');
      await press(page.getByRole('button', { name: 'Add rule' }));
      await expect(page.getByRole('alert')).toHaveText(
        'Enter a sender address (boss@company.com) or a domain (@company.com)');
      await expect(input).toHaveValue('nope');
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByRole('radio', { name: 'Private — never send to AI' })).toBeChecked();
      await expect(page.getByText('None yet.')).toHaveCount(3);
    });
  });
});

// =============================================================================================
// Resilience (JavaScript on)
// =============================================================================================

test.describe('When the network or the server fails', () => {
  const isTab = (name: string) => (u: URL) => u.pathname === '/' && u.searchParams.get('tab') === name;

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('a tab that fails to load in place (network error) still opens', async ({ page, allowErrors }) => {
    allowErrors.push(/ERR_FAILED/);
    let failed = 0;
    await page.route(isTab('later'), (route) => {
      if (route.request().isNavigationRequest()) return route.continue();
      failed += 1;
      return route.abort('failed');
    });
    await page.goto('/');
    await press(tab(page, 'Later'));
    await expect(page).toHaveURL(at('/?tab=later'));
    await expect(tab(page, 'Later')).toHaveAttribute('aria-current', 'page');
    await expect(rows(page, 'Later')).toHaveCount(2);
    await expect(rows(page, 'Later').filter({ hasText: SUBJECT.stories })).toBeVisible();
    await expect(page.locator('html'), 'not stuck waiting').not.toHaveClass(/nav-wait/);
    expect(failed, 'the in-place load really failed').toBeGreaterThan(0);
  });

  test('a tab the server fails on (500) still opens', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 500/, /HTTP 500/);
    let failed = 0;
    await page.route(isTab('quick'), (route) => {
      if (route.request().isNavigationRequest()) return route.continue();
      failed += 1;
      return route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' });
    });
    await page.goto('/');
    await press(tab(page, 'Quick reply'));
    await expect(page).toHaveURL(at('/?tab=quick'));
    await expect(tab(page, 'Quick reply')).toHaveAttribute('aria-current', 'page');
    await expect(rows(page, 'Quick reply').filter({ hasText: SUBJECT.invoice })).toBeVisible();
    await expect(page.getByText('Internal Server Error')).toHaveCount(0);
    expect(failed).toBeGreaterThan(0);
  });

  /** Holds the in-place loads of these tabs for a while; `done` says which have been let through. */
  async function slowTabs(page: Page, delays: Record<string, number>) {
    const done = new Set<string>();
    await page.route((u) => u.pathname === '/' && (u.searchParams.get('tab') ?? '') in delays, async (route) => {
      if (route.request().isNavigationRequest()) return route.continue();
      const name = new URL(route.request().url()).searchParams.get('tab')!;
      await new Promise((r) => setTimeout(r, delays[name]));
      try { await route.continue(); } catch { /* the test is over */ }
      done.add(name);
    });
    return done;
  }

  test('on a slow network, tapping two tabs quickly ends on the last one', async ({ page }) => {
    const done = await slowTabs(page, { schedule: 1500, later: 1500 });
    await page.goto('/');
    await press(tab(page, 'Schedule'));
    await press(tab(page, 'Later'));
    await expect(page).toHaveURL(at('/?tab=later'));
    await expect(rows(page, 'Later').filter({ hasText: SUBJECT.stories })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => done.has('schedule') && done.has('later'), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(500); // anything still on its way has landed
    await expect(page).toHaveURL(at('/?tab=later'));
    await expect(tab(page, 'Later')).toHaveAttribute('aria-current', 'page');
    await expect(tab(page, 'Schedule')).not.toHaveAttribute('aria-current', 'page');
    await expect(rows(page, 'Later')).toHaveCount(2);
    await expect(page.getByText(SUBJECT.lunch)).toHaveCount(0);
  });

  test('a slow tab that answers last never replaces the tab picked after it', async ({ page }) => {
    const done = await slowTabs(page, { schedule: 3000, later: 300 });
    await page.goto('/');
    await press(tab(page, 'Schedule'));
    await press(tab(page, 'Later'));
    await expect(rows(page, 'Later').filter({ hasText: SUBJECT.stories })).toBeVisible();
    await expect.poll(() => done.has('schedule'), { timeout: 10_000 }).toBe(true);
    await page.waitForTimeout(500); // the late Schedule page has landed
    await expect(page).toHaveURL(at('/?tab=later'));
    await expect(tab(page, 'Later')).toHaveAttribute('aria-current', 'page');
    await expect(rows(page, 'Later')).toHaveCount(2);
    await expect(page.getByText(SUBJECT.lunch)).toHaveCount(0);
  });

  test('an email that fails to load in place still opens', async ({ page, allowErrors }) => {
    allowErrors.push(/ERR_FAILED/);
    let failed = 0;
    await page.route((u) => u.pathname.startsWith('/message/') && u.searchParams.has('partial'), (route) => {
      failed += 1;
      return route.abort('failed');
    });
    await page.goto('/');
    await press(rowLink(page, SUBJECT.contract));
    await expect(page).toHaveURL(at('/?open=1'));
    await expect(openedSubject(page, SUBJECT.contract)).toBeVisible();
    await expect(page.getByText(/Legal needs it signed by 5 pm today/)).toBeVisible();
    expect(failed).toBeGreaterThan(0);
  });

  test('Compose that fails to open as a window opens as a page', async ({ page, allowErrors }) => {
    allowErrors.push(/ERR_FAILED/);
    await page.route((u) => u.pathname === '/compose' && u.searchParams.get('partial') === 'window',
      (route) => route.abort('failed'));
    await page.goto('/');
    await press(composeControl(page));
    await expect(page).toHaveURL((u) => u.pathname === '/compose');
    await expect(page.getByRole('heading', { level: 1, name: 'New message' })).toBeVisible();
    await expect(fields(page.getByRole('form', { name: 'New message' })).to).toBeEditable();
  });

  test('a move the server fails says so, leaves the email where it was, and Retry works', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 500/, /HTTP 500/);
    await page.route('**/message/*/score', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }));
    await page.goto('/');
    await press(rowLink(page, SUBJECT.payment));
    await expect(openedSubject(page, SUBJECT.payment)).toBeVisible();
    await press(moveButton(page, 'Later'));
    const error = note(page, 'Failed (500)');
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(moveButton(page, 'Do now'), 'shown back where it is').toHaveAttribute('aria-pressed', 'true');
    await expect(moveButton(page, 'Later')).toHaveAttribute('aria-pressed', 'false');
    await expect(openedSubject(page, SUBJECT.payment)).toBeVisible();

    await page.unrouteAll();
    await press(error.getByRole('button', { name: 'Retry' }));
    await expect(note(page, /^Moved to Later/)).toBeVisible();
    await page.goto('/?tab=later');
    await expect(rows(page, 'Later').filter({ hasText: SUBJECT.payment })).toBeVisible();
  });

  test('a move while offline says the server can\'t be reached; Retry works once back online', async ({ page, context, allowErrors }) => {
    allowErrors.push(/ERR_INTERNET_DISCONNECTED/);
    await page.goto('/');
    await press(rowLink(page, SUBJECT.payment));
    await expect(openedSubject(page, SUBJECT.payment)).toBeVisible();
    await context.setOffline(true);
    await press(moveButton(page, 'Quick reply'));
    const error = note(page, 'Could not reach the dashboard server');
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(moveButton(page, 'Do now')).toHaveAttribute('aria-pressed', 'true');
    await context.setOffline(false);
    await press(error.getByRole('button', { name: 'Retry' }));
    await expect(note(page, /^Moved to Quick reply/)).toBeVisible();
    await page.goto('/?tab=quick');
    await expect(rows(page, 'Quick reply').filter({ hasText: SUBJECT.payment })).toBeVisible();
  });

  test('a send the server fails keeps everything you wrote, and sending again works', async ({ page, sentMail, allowErrors }) => {
    allowErrors.push(/status of 500/, /HTTP 500/);
    await page.route('**/compose/send', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }));
    await page.goto('/');
    const form = await openCompose(page);
    const f = fields(form);
    await f.to.fill('friend@example.com');
    await f.subject.fill('Weekend plans');
    await f.body.fill('Hiking on Saturday?');
    await press(sendButton(form));
    await expect(note(page, 'Failed (500)')).toHaveAttribute('role', 'alert');
    await expect(form).toBeVisible();
    await expect(f.to).toHaveValue('friend@example.com');
    await expect(f.subject).toHaveValue('Weekend plans');
    await expect(f.body).toHaveValue('Hiking on Saturday?');
    expect(await sentMail()).toEqual([]);

    await page.unrouteAll();
    await press(sendButton(form));
    await expect(note(page, 'Sending…')).toBeVisible();
    await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
    expect((await sentMail())[0]).toMatchObject({ to: 'friend@example.com', subject: 'Weekend plans' });
  });

  test('a reply the server fails keeps the reply text', async ({ page, sentMail, allowErrors }) => {
    allowErrors.push(/status of 500/, /HTTP 500/);
    await page.route('**/compose/send', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }));
    await page.goto('/');
    await press(rowLink(page, SUBJECT.contract));
    await expect(openedSubject(page, SUBJECT.contract)).toBeVisible();
    await press(page.getByRole('link', { name: 'Reply', exact: true }).filter({ visible: true }).last());
    const form = page.getByRole('form', { name: 'Reply' });
    const body = fields(form).body;
    await expect(body).toBeVisible();
    await body.fill('Signed, sending it over now.');
    await press(sendButton(form));
    await expect(note(page, 'Failed (500)')).toBeVisible();
    await expect(body).toHaveValue('Signed, sending it over now.');
    await page.unrouteAll();
    await press(sendButton(form));
    await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
    expect((await sentMail())[0]).toMatchObject({ in_reply_to: '<m1@demo>', subject: `Re: ${SUBJECT.contract}` });
  });

  test('going offline while writing keeps the draft', async ({ page, context, sentMail, allowErrors }) => {
    allowErrors.push(/ERR_INTERNET_DISCONNECTED/);
    await page.goto('/');
    const form = await openCompose(page);
    const f = fields(form);
    await f.to.fill('friend@example.com');
    await f.subject.fill('Notes from the train');
    await context.setOffline(true);
    await f.body.fill('Written with no signal at all.');
    await press(sendButton(form));
    await expect(note(page, 'Could not reach the dashboard server')).toHaveAttribute('role', 'alert');
    await expect(f.body).toHaveValue('Written with no signal at all.');
    await press(form.getByRole('button', { name: 'Save & close' }));
    await expect(note(page, 'Draft saved on this device')).toBeVisible();
    await context.setOffline(false);

    await page.reload();
    const again = await openCompose(page);
    const g = fields(again);
    await expect(again.getByText('Draft restored')).toBeVisible();
    await expect(g.to).toHaveValue('friend@example.com');
    await expect(g.subject).toHaveValue('Notes from the train');
    await expect(g.body).toHaveValue('Written with no signal at all.');
    expect(await sentMail()).toEqual([]);
  });

  test('a failed Refresh says so and offers Retry', async ({ page, allowErrors }) => {
    allowErrors.push(/status of 500/, /HTTP 500/);
    await page.route('**/sync', (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }));
    await page.goto('/');
    await press(page.getByRole('button', { name: 'Refresh' }));
    const error = note(page, 'Failed (500)');
    await expect(error).toHaveAttribute('role', 'alert');
    await page.unrouteAll();
    await press(error.getByRole('button', { name: 'Retry' }));
    await expect(note(page, /^Sync done\./)).toBeVisible();
    await expect(rows(page, 'Do now')).toHaveCount(2);
  });
});
