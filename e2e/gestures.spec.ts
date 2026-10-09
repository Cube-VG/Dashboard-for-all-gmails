// Phone and tablet navigation and gestures: the menu drawer, swipe back from an email, the
// compose sheet, the shrinking Compose button, layout at small widths, touch target sizes,
// Reduce Motion, and the desktop sidebar (where none of the drawer machinery should apply).
//
// Gestures are real finger input (CDP touch events through swipe() or the finger() helper
// below), so they go through the browser's touch-action and pointer-event handling like a
// phone would. Taps on things in the sticky top bar use page.touchscreen.tap at the element's
// centre: locator.tap() scrolls a sticky element "into view", which moves the list behind it.
import type { Locator, Page } from '@playwright/test';
import { test, expect, swipe, snackbar, expectOnlyForScreenReaders } from './fixtures';

const CONTRACT = 'Contract renewal needs your signature today';
const LATER_SUBJECT = 'Top stories for you';

// ---------------------------------------------------------------------------------------------
// helpers

type Frame = { transform: string; clip: string; opacity: number; x: number; y: number };

const hasTouch = () => !!test.info().project.use.hasTouch;

/** Tap (touch devices) or click (desktop) the middle of an element, without scrolling first. */
async function press(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  if (hasTouch()) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

/**
 * A finger that can be put down, moved, held and lifted (CDP touch events). Each event carries
 * its own timestamp from a virtual clock, so the speed the app measures at release is exactly
 * the one asked for, however slowly this busy machine delivers the events.
 */
async function finger(page: Page, x: number, y: number) {
  const cdp = await page.context().newCDPSession(page);
  const at = (px: number, py: number) => [{ x: px, y: py, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
  let t = Date.now() / 1000;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(x, y), timestamp: t });
  let cx = x, cy = y;
  return {
    /** Move to (x1, y1) in `ms` of finger time. */
    async move(x1: number, y1: number, { ms = 200, steps = 10 } = {}) {
      for (let i = 1; i <= steps; i++) {
        t += ms / steps / 1000;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', timestamp: t,
          touchPoints: at(cx + (x1 - cx) * i / steps, cy + (y1 - cy) * i / steps) });
      }
      cx = x1; cy = y1;
      await page.evaluate(() => new Promise(requestAnimationFrame)); // let it paint
    },
    /** Keep the finger still for `ms` (so letting go is not a flick). */
    hold(ms: number) { t += ms / 1000; },
    async lift() {
      t += 0.008;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t });
      await cdp.detach();
    },
  };
}

/** Record an element's position and transform every frame for `ms` (start it before the action). */
async function recordMotion(page: Page, selector: string, ms = 700) {
  await page.evaluate(({ selector, ms }) => {
    const w = window as unknown as { __frames: Frame[]; __until: number };
    w.__frames = [];
    w.__until = performance.now() + ms;
    const rec = () => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (el && el.getClientRects().length) {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        w.__frames.push({ transform: cs.transform, clip: cs.clipPath, opacity: Number(cs.opacity), x: r.x, y: r.y });
      }
      if (performance.now() < w.__until) requestAnimationFrame(rec);
    };
    requestAnimationFrame(rec);
  }, { selector, ms });
  return async (): Promise<Frame[]> => {
    await page.waitForFunction(() => performance.now() > (window as unknown as { __until: number }).__until);
    return page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);
  };
}

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));
const scrollTo = (page: Page, y: number) =>
  page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);

const menuButton = (page: Page) => page.getByRole('button', { name: 'Main menu' });
const mailboxes = (page: Page) => page.getByRole('navigation', { name: 'Mailboxes' });
/** The "All mail" label: only drawn in the full sidebar (an open drawer, or the desktop sidebar). */
const fullSidebarLabel = (page: Page) => mailboxes(page).getByText('All mail', { exact: true });
const row = (page: Page, subject: string) => page.getByRole('article').filter({ hasText: subject });
const rowLink = (page: Page, subject: string) => row(page, subject).getByRole('link').first();
const newMessage = (page: Page) => page.getByRole('form', { name: 'New message' });

/** The drawer's spring has come to rest (nothing left on the element from the animation). */
async function drawerAtRest(page: Page) {
  await expect.poll(() => page.locator('#sidebar').evaluate((el) =>
    el.classList.contains('moving') || !!el.style.transform || !!el.style.clipPath)).toBe(false);
}

async function openMenu(page: Page) {
  await press(page, menuButton(page));
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(fullSidebarLabel(page)).toBeVisible();
  await drawerAtRest(page);
}

async function expectMenuClosed(page: Page, isPhone: boolean) {
  await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  // the scrim (no accessible name: it's a duplicate of Esc / the menu button) goes away
  await expect(page.locator('.scrim')).toBeHidden();
  if (isPhone) await expect(mailboxes(page)).toBeHidden(); // the whole sidebar slides away
  else await expectOnlyForScreenReaders(fullSidebarLabel(page)); // back to the icon rail
  await drawerAtRest(page);
}

/** Opens an email the way a user on this device would. */
async function openEmail(page: Page, subject: string) {
  const link = rowLink(page, subject);
  if (hasTouch()) await link.tap(); else await link.click();
  await expect(page).toHaveURL(/[?&]open=\d+/);
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
}

async function paneAtRest(page: Page) {
  await expect.poll(() => page.locator('#pane').evaluate((el) =>
    el.classList.contains('moving') || !!el.style.transform)).toBe(false);
}

/** The Compose control a user sees: the round button bottom right (phone) or the sidebar's
 * ("Compose (c)" on the tablet's icon rail, where only its title names it). */
const composeControl = (page: Page) =>
  page.getByRole('link', { name: /^Compose\b/ }).filter({ visible: true }).first();

async function fillNewMessage(page: Page) {
  const form = newMessage(page);
  await form.getByRole('textbox', { name: 'To' }).fill('pat@example.com');
  await form.getByRole('textbox', { name: 'Subject' }).fill('Lunch on Friday');
  await form.getByRole('textbox', { name: 'Message' }).fill('Shall we try the new place?');
}

async function expectDraftRestored(page: Page) {
  const form = newMessage(page);
  await expect(form.getByRole('textbox', { name: 'To' })).toHaveValue('pat@example.com');
  await expect(form.getByRole('textbox', { name: 'Subject' })).toHaveValue('Lunch on Friday');
  await expect(form.getByRole('textbox', { name: 'Message' })).toHaveValue('Shall we try the new place?');
  await expect(form.getByText('Draft restored')).toBeVisible();
}

/** The compose window / sheet has finished rising into place. */
async function composeAtRest(form: Locator) {
  await expect.poll(() => form.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
}

/** No sideways scrolling of the page itself. */
async function expectNoSidewaysScroll(page: Page, what: string) {
  const { sw, iw } = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: window.innerWidth }));
  expect.soft(sw, `${what}: the page is ${sw}px wide in a ${iw}px window`).toBeLessThanOrEqual(iw);
}

/** Every control is fully inside the window, left to right (nothing cut off at the edge). */
async function expectInsideWindow(page: Page, what: string, controls: Locator[]) {
  const iw = await page.evaluate(() => window.innerWidth);
  for (const c of controls) {
    await expect.soft(c, `${what}: ${c} is shown`).toBeVisible();
    const box = await c.boundingBox();
    if (!box) continue;
    expect.soft(box.x, `${what}: ${c} starts inside the window`).toBeGreaterThanOrEqual(-0.5);
    expect.soft(box.x + box.width, `${what}: ${c} ends inside the ${iw}px window`).toBeLessThanOrEqual(iw + 0.5);
  }
}

/** Names (and sizes) of the controls smaller than 44 x 44. */
async function tooSmall(controls: [string, Locator][]) {
  const small: string[] = [];
  for (const [name, c] of controls) {
    await expect(c, `${name} is shown`).toBeVisible();
    const b = (await c.boundingBox())!;
    if (b.width < 44 - 0.5 || b.height < 44 - 0.5) small.push(`${name} ${Math.round(b.width)}x${Math.round(b.height)}`);
  }
  return small;
}

// ---------------------------------------------------------------------------------------------
// the menu drawer

test.describe('Menu drawer on phones and tablets', () => {
  test.beforeEach(async ({ isPhone, isTablet }) => {
    test.skip(!isPhone && !isTablet, 'The desktop sidebar is always shown (no drawer): see "Desktop sidebar" below');
  });

  test('the menu button opens the menu with a spring slide', async ({ page, isPhone }) => {
    await page.goto('/');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    if (isPhone) await expect(mailboxes(page)).toBeHidden();
    else await expectOnlyForScreenReaders(fullSidebarLabel(page)); // tablet: only the icon rail

    const frames = await recordMotion(page, '#sidebar', 600);
    await press(page, menuButton(page));
    const seen = await frames();

    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(fullSidebarLabel(page)).toBeVisible();
    await drawerAtRest(page);
    const vw = page.viewportSize()!.width;
    const box = (await mailboxes(page).boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBeCloseTo(Math.min(300, vw * 0.86), 0);
    // the motion is driven per frame, so some frames catch it part of the way in
    if (isPhone) {
      expect(seen.some((f) => f.x < -5 && f.x > -box.width + 5), 'slides in from the left').toBe(true);
    } else {
      expect(seen.some((f) => f.clip !== 'none'), 'grows out of the icon rail').toBe(true);
    }
    await expect(page.locator('.scrim')).toBeVisible();
    // focus moves into the menu
    await expect(mailboxes(page).getByRole('link', { name: 'Compose' })).toBeFocused();
  });

  test('tapping the dimmed page closes the menu without opening the email under it', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    const vw = page.viewportSize()!.width;
    const under = (await rowLink(page, CONTRACT).boundingBox())!;
    // a tap right of the menu, on top of the first email's row
    await page.touchscreen.tap(vw - 16, under.y + under.height / 2);
    await expectMenuClosed(page, isPhone);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeHidden();
    await expect(menuButton(page)).toBeFocused();
    // and the page works again straight away
    await rowLink(page, CONTRACT).tap();
    await expect(page).toHaveURL(/open=1/);
  });

  test('swiping the menu left closes it', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    await swipe(page, 250, 420, 40, 425);
    await expectMenuClosed(page, isPhone);
    await expect(page).toHaveURL(/\/$/);
    // the swipe did not turn into a tap on whatever was under the finger
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeHidden();
  });

  test('swiping the dimmed page left also closes the menu', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    const vw = page.viewportSize()!.width;
    await swipe(page, vw - 10, 300, vw - 200, 305);
    await expectMenuClosed(page, isPhone);
    await expect(page).toHaveURL(/\/$/);
  });

  test('the menu follows the finger, and springs back open when let go early', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    const f = await finger(page, 250, 420);
    await f.move(180, 422, { ms: 240, steps: 12 });
    // part of the way closed, under the finger
    const side = page.locator('#sidebar');
    if (isPhone) {
      const x = (await side.boundingBox())!.x;
      expect(x).toBeLessThan(-30);
      expect(x).toBeGreaterThan(-120);
    } else {
      expect(await side.evaluate((el) => getComputedStyle(el).clipPath)).not.toBe('none');
    }
    f.hold(150); // the finger stops before letting go: no flick
    await f.lift();
    await drawerAtRest(page);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(fullSidebarLabel(page)).toBeVisible();
    expect((await side.boundingBox())!.x).toBe(0);
  });

  test('a quick flick closes the menu even after a short distance', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    // ~70px in ~50ms: not past halfway, but fast enough that it would carry on past it
    const f = await finger(page, 250, 420);
    await f.move(180, 420, { ms: 48, steps: 4 });
    await f.lift();
    await expectMenuClosed(page, isPhone);
  });

  test('Esc closes the menu and puts focus back on the menu button', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    await page.keyboard.press('Escape');
    await expectMenuClosed(page, isPhone);
    await expect(menuButton(page)).toBeFocused();
  });

  test('choosing a place in the menu closes it and goes there', async ({ page, isPhone }) => {
    await page.goto('/');
    await expect(row(page, LATER_SUBJECT)).toHaveCount(0); // Inbox opens on "Do now"
    await openMenu(page);
    await mailboxes(page).getByRole('link', { name: 'All mail' }).tap();
    await expect(page).toHaveURL(/\/\?view=all$/);
    await expectMenuClosed(page, isPhone);
    await expect(row(page, LATER_SUBJECT)).toBeVisible(); // All mail lists every tab's mail
    await expect(page.getByRole('article')).toHaveCount(10);

    // a page outside the inbox loads as a new page, with the menu closed
    await openMenu(page);
    await mailboxes(page).getByRole('link', { name: 'Sent' }).tap();
    await expect(page).toHaveURL(/\/sent$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sent' })).toBeVisible();
    await expectMenuClosed(page, isPhone);
  });

  test('Compose in the menu closes it and opens a new message', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    await mailboxes(page).getByRole('link', { name: 'Compose' }).tap();
    await expect(newMessage(page)).toBeVisible();
    await expect(newMessage(page).getByRole('textbox', { name: 'To' })).toBeFocused();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.scrim')).toBeHidden();
    if (isPhone) await expect(mailboxes(page)).toBeHidden();
  });

  // APP BUG: pressing c (Compose shortcut) with the menu open opens a new message on top of the still-open menu
  test('the c shortcut with the menu open puts the menu away and opens a new message', async ({ page, isPhone }) => {
    await page.goto('/');
    await openMenu(page);
    await page.keyboard.press('c');
    await expect(newMessage(page)).toBeVisible();
    await expect(newMessage(page).getByRole('textbox', { name: 'To' })).toBeFocused();
    // like choosing Compose in the menu: the menu goes away first
    await expectMenuClosed(page, isPhone);
    // so Esc now puts the new message away (the draft is kept), instead of closing a hidden menu
    await page.keyboard.press('Escape');
    await expect(newMessage(page)).toHaveCount(0);
  });

  test('while the menu is open, Tab keeps focus inside it', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    const where = () => page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return 'nowhere';
      return a.closest('#sidebar') ? 'menu' : `outside: ${a.outerHTML.slice(0, 80)}`;
    });
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) { await page.keyboard.press('Tab'); seen.add(await where()); }
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Tab'); seen.add(await where()); }
    // it may pass through the browser itself between the last and first link, never the page behind
    expect([...seen].filter((s) => s !== 'menu' && s !== 'nowhere')).toEqual([]);
    expect(seen.has('menu')).toBe(true);
  });
});

test.describe('Menu drawer over a long list', () => {
  test.use({ mailbox: 'big' });
  test.beforeEach(async ({ isPhone, isTablet }) => {
    test.skip(!isPhone && !isTablet, 'The desktop sidebar is always shown (no drawer)');
  });

  // APP BUG: with the menu open, swiping up/down on the menu or the dimmed page scrolls the list behind it
  test('while the menu is open, the list behind it does not scroll', async ({ page }) => {
    await page.goto('/?tab=later');
    await scrollTo(page, 600);
    await expect.poll(() => scrollY(page)).toBe(600);
    await openMenu(page);
    const { width: vw, height: vh } = page.viewportSize()!;
    await swipe(page, 150, vh * 0.75, 150, vh * 0.25, { ms: 300, steps: 15 }); // on the menu
    await page.waitForTimeout(400); // any fling would carry on for a moment
    expect(await scrollY(page), 'a vertical swipe on the menu').toBe(600);
    await swipe(page, vw - 16, vh * 0.75, vw - 16, vh * 0.25, { ms: 300, steps: 15 }); // on the dimmed page
    await page.waitForTimeout(400);
    expect(await scrollY(page), 'a vertical swipe on the dimmed page').toBe(600);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test('opening and closing the menu keeps your place in the list', async ({ page, isPhone }) => {
    await page.goto('/?tab=later');
    await scrollTo(page, 900);
    await expect.poll(() => scrollY(page)).toBe(900);
    await openMenu(page);
    await page.keyboard.press('Escape');
    await expectMenuClosed(page, isPhone);
    expect(await scrollY(page)).toBe(900);
  });
});

// ---------------------------------------------------------------------------------------------
// going back from an open email

test.describe('Going back from an open email', () => {
  test('going back from an email returns to the list (phone: swipe right)', async ({ page, isPhone }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    if (isPhone) {
      // full screen, over the list
      await paneAtRest(page);
      expect(await page.locator('#pane').boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
      await expect(page.getByRole('link', { name: 'Compose', exact: true }).filter({ visible: true })).toHaveCount(0);
      // a finger from the left part of the screen, to the right
      await swipe(page, 30, 420, 320, 425);
    } else {
      // tablet and desktop: the email takes the list's place; the back arrow returns
      const back = page.getByRole('link', { name: 'Back to the list' });
      if (hasTouch()) await back.tap(); else await back.click();
    }
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeHidden();
    await expect(row(page, CONTRACT)).toBeVisible();
    await expect(rowLink(page, CONTRACT)).toBeFocused(); // you land on the email you left
    if (isPhone) await expect(composeControl(page)).toBeVisible();
  });

  test('a swipe let go before halfway springs the email back', async ({ page, isPhone }) => {
    test.skip(!isPhone, 'The email only follows a finger on phones (DESIGN.md §7)');
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await paneAtRest(page);
    const f = await finger(page, 40, 420);
    await f.move(160, 423, { ms: 240, steps: 12 });
    const x = (await page.locator('#pane').boundingBox())!.x;
    expect(x, 'the email follows the finger').toBeGreaterThan(80);
    expect(x).toBeLessThan(200);
    f.hold(150); // held still: no flick
    await f.lift();
    await paneAtRest(page);
    expect((await page.locator('#pane').boundingBox())!.x).toBe(0);
    await expect(page).toHaveURL(/open=1/);
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeVisible();
  });

  test('a mostly vertical swipe scrolls the email instead of going back', async ({ page, isPhone }) => {
    test.skip(!hasTouch(), 'Desktop has no touch screen');
    await page.goto('/');
    await openEmail(page, CONTRACT);
    await paneAtRest(page);
    // drifts right a little while going up: the scroll wins
    await swipe(page, 40, 560, 110, 160, { ms: 300, steps: 15 });
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(/open=1/);
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeAttached();
    expect(await page.locator('#pane').evaluate((el) => el.style.transform)).toBe('');
    if (isPhone) {
      // the full-screen email scrolls itself
      expect(await page.locator('#pane').evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
    }
  });
});

test.describe('Scrolling a long list by touch', () => {
  test.use({ mailbox: 'big' });

  test('swiping up and down scrolls the list without opening anything', async ({ page }) => {
    await page.goto('/?tab=later');
    await expect(page.getByRole('article')).toHaveCount(50);
    const { width: vw, height: vh } = page.viewportSize()!;
    if (hasTouch()) await swipe(page, vw / 2, vh * 0.8, vw / 2, vh * 0.3, { ms: 300, steps: 15 });
    else { await page.mouse.move(vw / 2, vh / 2); await page.mouse.wheel(0, 500); }
    await expect.poll(() => scrollY(page)).toBeGreaterThan(150);
    const down = await scrollY(page);
    if (hasTouch()) await swipe(page, vw / 2, vh * 0.3, vw / 2, vh * 0.7, { ms: 300, steps: 15 });
    else { await page.mouse.wheel(0, -300); }
    await expect.poll(() => scrollY(page)).toBeLessThan(down);
    await expect(page).toHaveURL(/\?tab=later$/);
    await expect(page.locator('#layout')).not.toHaveClass(/with-pane/);
  });
});

// ---------------------------------------------------------------------------------------------
// compose sheet

test.describe('Compose sheet', () => {
  test('pulling a new message down by its title bar puts it away and keeps the draft', async ({ page, isPhone }) => {
    await page.goto('/');
    await press(page, composeControl(page));
    const form = newMessage(page);
    await expect(form).toBeVisible();
    await fillNewMessage(page);
    await composeAtRest(form);
    const head = (await form.getByText('New message', { exact: true }).boundingBox())!;
    if (isPhone) {
      // a bottom sheet covering the screen
      await expect.poll(async () => form.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });
      await swipe(page, head.x + 40, head.y + head.height / 2, head.x + 45, head.y + 420, { ms: 250 });
    } else {
      // a floating window: dragging its title bar is not a way to close it there
      if (hasTouch()) {
        await swipe(page, head.x + 40, head.y + head.height / 2, head.x + 45, head.y + 300, { ms: 250 });
        await page.waitForTimeout(300);
        await expect(form).toBeVisible();
      }
      await press(page, form.getByRole('button', { name: 'Save & close' }));
    }
    await expect(form).toHaveCount(0);
    await expect(snackbar(page)).toContainText('Draft saved on this device');
    await expect(page).toHaveURL(/\/$/);

    await press(page, composeControl(page));
    await expectDraftRestored(page);
  });

  test('a short pull springs the sheet back up', async ({ page, isPhone }) => {
    test.skip(!isPhone, 'Compose is a pull-down sheet on phones only (a floating window elsewhere)');
    await page.goto('/');
    await press(page, composeControl(page));
    const form = newMessage(page);
    await expect(form).toBeVisible();
    await fillNewMessage(page);
    await composeAtRest(form);
    const head = (await form.getByText('New message', { exact: true }).boundingBox())!;
    const f = await finger(page, head.x + 40, head.y + head.height / 2);
    await f.move(head.x + 42, head.y + head.height / 2 + 90, { ms: 240, steps: 12 });
    const y = (await form.boundingBox())!.y;
    expect(y, 'the sheet follows the finger').toBeGreaterThan(40);
    expect(y).toBeLessThan(140);
    f.hold(150); // held still: no flick
    await f.lift();
    await expect.poll(async () => (await form.boundingBox())!.y).toBe(0);
    await expect(form.getByRole('textbox', { name: 'Message' })).toHaveValue('Shall we try the new place?');

    // and a pull upwards never takes it away either
    await swipe(page, head.x + 40, head.y + head.height / 2 + 4, head.x + 40, Math.max(1, head.y - 200), { ms: 200 });
    await page.waitForTimeout(300);
    await expect(form).toBeVisible();
    await expect.poll(async () => (await form.boundingBox())!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// the Compose button

test.describe('Compose button', () => {
  test.use({ mailbox: 'big' });

  test('the Compose button tucks into an icon while scrolling down, and comes back on the way up', async ({ page, isPhone }) => {
    await page.goto('/?tab=later');
    if (!isPhone) {
      // tablet and desktop: no floating button; Compose is at the top of the sidebar
      await expect(page.locator('.fab')).toBeHidden(); // CSS: the floating button has no other handle
      await expect(mailboxes(page).getByRole('link', { name: 'Compose' })).toBeVisible();
      return;
    }
    const fab = composeControl(page);
    await expect(fab).toBeVisible();
    const wide = (await fab.boundingBox())!;
    expect(wide.width).toBeGreaterThan(120);
    await swipe(page, 200, 500, 200, 200, { ms: 300, steps: 15 });
    await expect.poll(async () => (await fab.boundingBox())!.width).toBeLessThan(64);
    await expect(fab).toHaveAccessibleName('Compose'); // still says what it is
    const small = (await fab.boundingBox())!;
    expect(small.height).toBeGreaterThanOrEqual(56);
    expect(small.x + small.width).toBeCloseTo(wide.x + wide.width, 0); // tucks towards the corner
    await swipe(page, 200, 250, 200, 450, { ms: 300, steps: 15 });
    await expect.poll(async () => (await fab.boundingBox())!.width).toBeGreaterThan(120);
    // and it still works
    await press(page, fab);
    await expect(newMessage(page)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// layout

type Screen = {
  name: string;
  url: string;
  setup?: (page: Page) => Promise<void>;
  then?: (page: Page, device: { isPhone: boolean; isTablet: boolean }) => Promise<boolean | void>;
  controls: (page: Page) => Locator[];
};

const topBar = (page: Page) => [
  menuButton(page),
  page.getByRole('searchbox', { name: 'Search mail' }),
  page.getByRole('button', { name: 'Refresh' }),
  page.getByLabel('Settings', { exact: true }),
];

const SCREENS: Screen[] = [
  { name: 'the inbox', url: '/', controls: (p) => [...topBar(p), rowLink(p, CONTRACT)] },
  { name: 'All mail', url: '/?view=all', controls: (p) => [...topBar(p), rowLink(p, LATER_SUBJECT)] },
  { name: 'the priority matrix', url: '/?view=matrix', controls: (p) => [...topBar(p), rowLink(p, CONTRACT)] },
  {
    name: 'Sent, with an email waiting to go', url: '/sent',
    setup: async (page) => {
      const r = await page.request.post('/compose/send', { headers: { Accept: 'application/json' }, form: {
        mode: 'new', from_account: 'sam.work@gmail.com', to: 'priya.raman.procurement@acme-international.example',
        subject: 'Signed-contract-Acme-renewal-2026-final-v3.pdf attached', body: 'Here it is.', next: '/' } });
      expect(r.ok()).toBe(true);
    },
    controls: (p) => [...topBar(p), p.getByText('Signed-contract-Acme-renewal-2026-final-v3.pdf attached'),
      p.getByRole('button', { name: 'Undo' })],
  },
  {
    name: 'Sender rules, with a long address', url: '/rules',
    setup: async (page) => {
      const r = await page.request.post('/rules', { headers: { Accept: 'application/json' }, form: {
        kind: 'vip', pattern: 'very.long.sender.address.for.testing@subdomain.acme-international.example', next: '/rules' } });
      expect(r.ok()).toBe(true);
    },
    controls: (p) => [...topBar(p), p.getByText('very.long.sender.address.for.testing@subdomain.acme-international.example')],
  },
  {
    name: 'the full-page compose', url: '/compose',
    controls: (p) => [p.getByRole('textbox', { name: 'To' }), p.getByRole('button', { name: 'Send', exact: true }),
      p.getByRole('link', { name: 'Discard draft' })],
  },
  {
    name: 'an open email', url: '/?open=1',
    controls: (p) => [p.getByRole('link', { name: 'Back to the list' }), p.getByTitle('Move to (1–4)'),
      p.getByRole('heading', { name: CONTRACT }),
      p.getByRole('link', { name: 'Reply', exact: true }).filter({ visible: true }).last(), // the reply bar's
      p.getByRole('link', { name: 'Reply all' }), p.getByRole('link', { name: 'Forward' })],
  },
  {
    name: 'the settings menu', url: '/',
    then: async (page) => {
      await press(page, page.getByLabel('Settings', { exact: true }));
      await expect(page.getByText('Quick settings')).toBeVisible();
    },
    controls: (p) => [p.locator('#more-menu'), p.getByRole('switch', { name: 'Compact rows' }),
      p.getByRole('switch', { name: 'Solid surfaces' }), p.locator('#more-menu').getByRole('link', { name: 'Sender rules' })],
  },
  {
    name: 'a new message', url: '/',
    then: async (page) => { await press(page, composeControl(page)); await expect(newMessage(page)).toBeVisible(); },
    controls: (p) => [newMessage(p).getByRole('textbox', { name: 'To' }), newMessage(p).getByRole('button', { name: 'Send', exact: true }),
      newMessage(p).getByRole('button', { name: 'Save & close' }), newMessage(p).getByRole('button', { name: 'Discard draft' })],
  },
  {
    name: 'the open menu', url: '/',
    then: async (page, { isPhone, isTablet }) => {
      if (!isPhone && !isTablet) return false; // the desktop sidebar is the menu
      await openMenu(page);
    },
    controls: (p) => [mailboxes(p).getByRole('link', { name: 'Compose' }), mailboxes(p).getByRole('link', { name: 'Priority matrix' }),
      mailboxes(p).getByRole('link', { name: 'Sender rules' })],
  },
];

test.describe('Layout fits the screen', () => {
  for (const s of SCREENS) {
    test(`${s.name} has no sideways scrolling and nothing cut off`, async ({ page, isPhone, isTablet }) => {
      if (s.setup) { await page.goto('/'); await s.setup(page); }
      await page.goto(s.url);
      if (s.then) {
        const ran = await s.then(page, { isPhone, isTablet });
        if (ran === false) test.skip(true, 'Not on desktop: the sidebar there is always shown');
      }
      await expectNoSidewaysScroll(page, s.name);
      await expectInsideWindow(page, s.name, s.controls(page));
    });
  }

  test('every screen also fits a 320px-wide phone', async ({ page, isPhone }) => {
    test.skip(!isPhone, 'The small-phone width is checked in the phone project');
    await page.setViewportSize({ width: 320, height: 568 });
    for (const s of SCREENS) {
      if (s.setup) { await page.goto('/'); await s.setup(page); }
      await page.goto(s.url);
      if (s.then) await s.then(page, { isPhone: true, isTablet: false });
      await expectNoSidewaysScroll(page, `${s.name} at 320px`);
      await expectInsideWindow(page, `${s.name} at 320px`, s.controls(page));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// touch targets

test.describe('Touch targets are at least 44px', () => {
  test.beforeEach(async ({ isPhone, isTablet }) => {
    test.skip(!isPhone && !isTablet, 'Desktop has a fine pointer: 36px controls with a mouse are by design');
  });

  test('the list screen: menu, search, refresh, settings, tabs, emails and Compose', async ({ page }) => {
    await page.goto('/');
    const tabs = page.getByRole('navigation', { name: 'Inbox tabs' }).getByRole('link');
    const controls: [string, Locator][] = [
      ['Main menu', menuButton(page)],
      ['Search mail', page.getByRole('searchbox', { name: 'Search mail' })],
      ['Refresh', page.getByRole('button', { name: 'Refresh' })],
      ['Settings', page.getByLabel('Settings', { exact: true })],
      ['Do now tab', tabs.first()],
      ['first email', rowLink(page, CONTRACT)],
      ['Compose', composeControl(page)],
    ];
    expect(await tooSmall(controls)).toEqual([]);
  });

  // APP BUG: in the open menu, the Categories toggle and the "Updated …" status are 36px tall on touch screens
  test('the open menu: every link and toggle', async ({ page }) => {
    await page.goto('/');
    await openMenu(page);
    const nav = mailboxes(page);
    const controls: [string, Locator][] = [];
    for (const name of ['Compose', 'Inbox', 'All mail', 'Priority matrix', 'Sent', 'Sender rules', 'Personal', 'Work', 'Velocity']) {
      controls.push([name, nav.getByRole('link', { name }).first()]);
    }
    controls.push(['Categories', nav.getByText('Categories', { exact: true })
      .locator('xpath=ancestor-or-self::summary')]); // <summary>: no button role to find it by
    controls.push(['sync status', nav.getByText(/^Updated /).locator('xpath=ancestor-or-self::summary')]);
    expect(await tooSmall(controls)).toEqual([]);
  });

  // APP BUG: the open email's toolbar (Back, Mark as read, Move to, Newer/Older) is 40px on touch screens
  test('an open email: Back, Mark as read, Move to and the reply buttons', async ({ page, isPhone }) => {
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const controls: [string, Locator][] = [
      ['Back to the list', page.getByRole('link', { name: 'Back to the list' })],
      ['Mark as read/unread', page.getByRole('button', { name: /^Mark as (un)?read$/ })],
      ['Move to', page.getByTitle('Move to (1–4)')], // a <summary>: no button role to find it by
      ['Reply all', page.getByRole('link', { name: 'Reply all' })],
      ['Forward', page.getByRole('link', { name: 'Forward' })],
    ];
    if (!isPhone) controls.push(['Older email', page.getByRole('button', { name: 'Older email' })]);
    expect(await tooSmall(controls)).toEqual([]);
  });

  // APP BUG: in a new message, Send and Help me write are 40px tall on touch screens
  test('a new message: Send, Help me write, Save & close and Discard', async ({ page }) => {
    await page.goto('/');
    await press(page, composeControl(page));
    const form = newMessage(page);
    await expect(form).toBeVisible();
    const controls: [string, Locator][] = [
      ['Send', form.getByRole('button', { name: 'Send', exact: true })],
      ['Help me write', form.getByRole('button', { name: 'Help me write' })],
      ['Save & close', form.getByRole('button', { name: 'Save & close' })],
      ['Discard draft', form.getByRole('button', { name: 'Discard draft' })],
    ];
    expect(await tooSmall(controls)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Reduce Motion

test.describe('With Reduce Motion', () => {
  // (reducedMotion is a browser-context option, not a test option, in this Playwright version)
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the menu fades in and out without sliding', async ({ page, isPhone, isTablet }) => {
    test.skip(!isPhone && !isTablet, 'The desktop sidebar is always shown (no drawer)');
    await page.goto('/');
    const opening = await recordMotion(page, '#sidebar', 1000);
    await press(page, menuButton(page));
    const inFrames = await opening();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(fullSidebarLabel(page)).toBeVisible();
    expect(inFrames.length).toBeGreaterThan(3);
    expect(inFrames.filter((f) => f.transform !== 'none' || f.clip !== 'none')).toEqual([]);
    expect(inFrames.every((f) => f.x === 0)).toBe(true);

    const closing = await recordMotion(page, '#sidebar', 300);
    await page.keyboard.press('Escape');
    const outFrames = await closing();
    await expectMenuClosed(page, isPhone);
    expect(outFrames.filter((f) => f.transform !== 'none' || f.clip !== 'none')).toEqual([]);
    await expect(menuButton(page)).toBeFocused();
  });

  test('an email opens and closes without sliding', async ({ page, isPhone }) => {
    await page.goto('/');
    const opening = await recordMotion(page, '#pane', 1500);
    await openEmail(page, CONTRACT);
    const inFrames = await opening();
    expect(inFrames.length).toBeGreaterThan(3);
    expect(inFrames.filter((f) => f.transform !== 'none')).toEqual([]);
    if (isPhone) expect(await page.locator('#pane').boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 664 });

    const closing = await recordMotion(page, '#pane', 300);
    const back = page.getByRole('link', { name: 'Back to the list' });
    if (hasTouch()) await back.tap(); else await back.click();
    const outFrames = await closing();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeHidden();
    await expect(row(page, CONTRACT)).toBeVisible();
    expect(outFrames.filter((f) => f.transform !== 'none')).toEqual([]);
  });

  test('a new message opens and closes without sliding, and keeps its draft', async ({ page }) => {
    await page.goto('/');
    const opening = await recordMotion(page, '.compose-window', 1500);
    await press(page, composeControl(page));
    const form = newMessage(page);
    await expect(form).toBeVisible();
    const inFrames = await opening();
    expect(inFrames.length).toBeGreaterThan(3);
    expect(inFrames.filter((f) => f.transform !== 'none')).toEqual([]);
    await fillNewMessage(page);

    const closing = await recordMotion(page, '.compose-window', 300);
    await press(page, form.getByRole('button', { name: 'Save & close' }));
    const outFrames = await closing();
    await expect(form).toHaveCount(0);
    expect(outFrames.filter((f) => f.transform !== 'none')).toEqual([]);
    await expect(snackbar(page)).toContainText('Draft saved on this device');
    await press(page, composeControl(page));
    await expectDraftRestored(page);
  });

  // APP BUG: with Reduce Motion on, the swipe gestures do nothing at all (README: "things fade instead of sliding")
  test('the swipe gestures still work, they just fade instead of sliding', async ({ page, isPhone, isTablet }) => {
    test.skip(!isPhone && !isTablet, 'Desktop has no touch gestures');
    await page.goto('/');
    await openMenu(page);
    await swipe(page, 250, 420, 40, 425);
    await expect.soft(menuButton(page), 'swiping the menu left closes it').toHaveAttribute('aria-expanded', 'false');
    if (!isPhone) return; // the email and compose gestures are phone-only
    await page.keyboard.press('Escape'); // closes the menu if the swipe did not
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');

    await openEmail(page, CONTRACT);
    await swipe(page, 30, 420, 320, 425);
    await expect.soft(page, 'swiping an open email right goes back').toHaveURL(/\/$/);
    await page.goto('/');

    await press(page, composeControl(page));
    const form = newMessage(page);
    await expect(form).toBeVisible();
    await fillNewMessage(page);
    await composeAtRest(form);
    const head = (await form.getByText('New message', { exact: true }).boundingBox())!;
    await swipe(page, head.x + 40, head.y + head.height / 2, head.x + 45, head.y + 420, { ms: 250 });
    await expect.soft(form, 'pulling the new message down puts it away').toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// desktop: the sidebar is always there, and none of the drawer machinery gets in the way

test.describe('Desktop sidebar', () => {
  test('the sidebar: always shown on desktop, an icon rail on tablets, hidden on phones', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    if (isPhone) {
      await expect(mailboxes(page)).toBeHidden();
      await expect(menuButton(page)).toBeVisible();
    } else if (isTablet) {
      await expect(mailboxes(page)).toBeVisible();
      expect((await mailboxes(page).boundingBox())!.width).toBeLessThan(100);
      await expectOnlyForScreenReaders(fullSidebarLabel(page));
      // the rail's icons still go places
      await mailboxes(page).getByRole('link', { name: 'All mail' }).tap();
      await expect(page).toHaveURL(/view=all/);
      await expect(page.locator('.scrim')).toBeHidden();
    } else {
      await expect(fullSidebarLabel(page)).toBeVisible();
      await expect(page.locator('.scrim')).toBeHidden();
      expect(await page.locator('#board').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
      await mailboxes(page).getByRole('link', { name: 'All mail' }).click();
      await expect(page).toHaveURL(/view=all/);
      await expect(fullSidebarLabel(page)).toBeVisible();
      await expect(row(page, LATER_SUBJECT)).toBeVisible();
      // Esc with nothing open leaves it alone
      await page.keyboard.press('Escape');
      await expect(fullSidebarLabel(page)).toBeVisible();
    }
  });

  test('the menu button folds the desktop sidebar into icons, remembered after a reload', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, 'On phones and tablets the menu button opens the drawer (tested above)');
    await page.goto('/');
    await menuButton(page).click();
    await expectOnlyForScreenReaders(fullSidebarLabel(page));
    expect((await mailboxes(page).boundingBox())!.width).toBeLessThan(100);
    await expect(page.locator('.scrim')).toBeHidden(); // a rail, not an overlay
    await page.reload();
    await expectOnlyForScreenReaders(fullSidebarLabel(page));
    await menuButton(page).click();
    await expect(fullSidebarLabel(page)).toBeVisible();
    await page.reload();
    await expect(fullSidebarLabel(page)).toBeVisible();
  });

  // APP BUG: on desktop the menu button always says "collapsed" (aria-expanded=false), even with the full sidebar shown
  test('the menu button tells screen readers whether the menu is expanded', async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    if (isPhone || isTablet) {
      await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
      await openMenu(page);
      await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
      return;
    }
    await expect(fullSidebarLabel(page)).toBeVisible();
    await expect(menuButton(page), 'the full sidebar is showing').toHaveAttribute('aria-expanded', 'true');
    await menuButton(page).click();
    await expectOnlyForScreenReaders(fullSidebarLabel(page));
    await expect(menuButton(page), 'folded into icons').toHaveAttribute('aria-expanded', 'false');
  });

  test('mouse drags select text instead of dragging panels', async ({ page, isPhone, isTablet }) => {
    test.skip(isPhone || isTablet, 'Touch screens: dragging is covered by the swipe tests above');
    await page.goto('/');
    await openEmail(page, CONTRACT);
    const subject = page.getByRole('heading', { name: CONTRACT });
    const b = (await subject.boundingBox())!;
    await page.mouse.move(b.x + 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 300, b.y + b.height / 2 + 1, { steps: 12 });
    await page.mouse.up();
    expect(await page.evaluate(() => String(window.getSelection()))).toContain('Contract renewal');
    await expect(page).toHaveURL(/open=1/);
    expect(await page.locator('#pane').evaluate((el) => el.style.transform)).toBe('');

    // a sideways mouse drag on the sidebar leaves it where it is
    const nav = (await mailboxes(page).boundingBox())!;
    await page.mouse.move(nav.x + 200, nav.y + 300);
    await page.mouse.down();
    await page.mouse.move(nav.x + 20, nav.y + 300, { steps: 12 });
    await page.mouse.up();
    expect(await mailboxes(page).boundingBox()).toEqual(nav);
    await expect(fullSidebarLabel(page)).toBeVisible();
    await expect(page.locator('.scrim')).toBeHidden();
    await expect(page).toHaveURL(/open=1/);
  });

  test('turning a tablet sideways to desktop width with the menu open leaves a normal page', async ({ page, isTablet }) => {
    test.skip(!isTablet, 'Only a tablet turns into a desktop-width window (phone landscape stays under 1024px)');
    await page.goto('/');
    await openMenu(page);
    await page.setViewportSize({ width: 1080, height: 810 });
    await expect(page.locator('.scrim')).toBeHidden();
    await expect(fullSidebarLabel(page)).toBeVisible();
    // the page is usable again: nothing left inert behind a drawer that is gone
    await rowLink(page, CONTRACT).tap();
    await expect(page).toHaveURL(/open=1/);
  });
});
