// Accessibility and keyboard-only use on every page: accessible names, headings and landmarks,
// live regions, menus and dialogs, keyboard-only reading / replying / sending / Undo (desktop),
// the phone and tablet drawer as a modal (focus in, trapped, back out, background inert),
// colour contrast in light and dark (system setting and the in-app Dark / Light setting),
// 200% zoom and 200% text, forced colours, Reduce Motion, and touch target sizes.
//
// What the app is meant to do (docs/design/DESIGN.md §7 Motion, §10 Accessibility checklist;
// app/web/static/app.js syncModal / openDrawer / closeDrawer / toast / trackSend):
// - The shortcut sheet is a role="dialog" popover: focus goes to its Close button and returns to
//   the invoker (or the ⚙ button) when it closes. Menus are <details>: Esc closes and refocuses.
// - Phone / tablet drawer: focus moves into it, the page behind is inert, Esc gives focus back.
// - Snackbars live in #flash (aria-live="polite"); success notes are role="status", errors "alert".
// - Reduced motion: slides become fades of ~150 ms (the compose fields fade 200 ms); nothing moves.
// - Touch: every target at least 44 × 44 px (DESIGN §10 "Targets").
//
// Accessibility gaps noted while writing these (CSS used only where there is no accessible name
// or role Playwright can see):
// - <summary> controls (⚙ Settings, Move to, Categories) have no role in Playwright's tree, so
//   they are found by aria-label; their expanded state is read from Chromium's own tree (CDP).
// - The menus they open are plain disclosures (no menu / menuitem roles).
// - #flash, the snackbar container, has no role or name: it is found by id.
// - The switch knobs and the theme / rule-kind segments draw their state with CSS only, so the
//   forced-colours checks compare screenshots of `.knob` and the segmented <fieldset>.
// - The motion recorder and the contrast / layout scanners look at CSS-drawn boxes by class.
import type { CDPSession, Locator, Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { test, expect, snackbar, PASSWORD } from './fixtures';

// The demo mailbox (e2e/server.py), sorted by app/ai/scoring.quadrant().
const CONTRACT = 'Contract renewal needs your signature today'; // Do now, unread, id 1, Work
const PAYMENT = 'Payment failed for velocity.example'; // Do now, unread, id 2, Velocity

const KEYBOARD_ONLY = 'Keyboard-only use is a desktop scenario: the phone and tablet projects have no '
  + 'hardware keyboard (their touch paths are tested in the drawer, contrast and motion groups)';
const NO_DRAWER = 'At 1024px and wider the sidebar is always shown: there is no drawer to trap focus';

// --- helpers ---------------------------------------------------------------------------------

const isTouch = () => !!test.info().project.use.hasTouch;

/** A finger tap on touch devices, a mouse click on the desktop. */
async function press(target: Locator) {
  if (isTouch()) await target.tap();
  else await target.click();
}

const list = (page: Page, name = 'Do now') => page.getByRole('region', { name, exact: true });
const rowLink = (page: Page, subject: string, tab = 'Do now') =>
  list(page, tab).getByRole('article').filter({ hasText: subject }).getByRole('link');
const pane = (page: Page) => page.getByRole('complementary', { name: 'Selected email' });
const subjectOf = (page: Page) => pane(page).getByRole('heading', { level: 2 });
const menuButton = (page: Page) => page.getByRole('button', { name: 'Main menu' });
/** ⚙: a <summary>, which has no role Playwright knows, so it is found by its aria-label. */
const settingsButton = (page: Page) => page.getByLabel('Settings', { exact: true });
/** Compose: the sidebar button (desktop, tablet rail: "Compose (c)") or the phone's floating one. */
const composeOpener = (page: Page) => page.getByRole('link', { name: /^Compose/ });
const composeWindow = (page: Page, name = 'New message') => page.getByRole('form', { name });
const moveButton = (page: Page, label: string) => pane(page)
  .getByRole('region', { name: 'AI summary and priority' }).getByRole('group', { name: 'Move to' })
  .getByRole('button', { name: new RegExp(`^${label}`) });

/** Press Tab until `target` (or something inside it) has focus. */
async function tabTo(page: Page, target: Locator, max = 70) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const there = await target
      .evaluate((el) => !!document.activeElement && (el === document.activeElement || el.contains(document.activeElement)),
        undefined, { timeout: 1000 })
      .catch(() => false);
    if (there) return;
  }
  throw new Error(`Tab never reached ${target}`);
}

/** No running finite animations or transitions (snackbar / pane / drawer have settled). */
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => document.getAnimations()
    .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length)).toBe(0);
}

// --- Chromium's accessibility tree (what VoiceOver / TalkBack / NVDA are given) ---------------

type AXNode = {
  nodeId: string; ignored: boolean; backendDOMNodeId?: number;
  role?: { value: string }; name?: { value: string };
  properties?: { name: string; value: { value: unknown } }[];
};
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'DisclosureTriangle', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'slider', 'spinbutton', 'listbox',
  'PopUpButton']);

async function withCDP<T>(page: Page, fn: (cdp: CDPSession) => Promise<T>): Promise<T> {
  const cdp = await page.context().newCDPSession(page);
  try { return await fn(cdp); } finally { await cdp.detach().catch(() => {}); }
}

/** Run `fn(sel)` on the DOM node behind an accessibility node. */
async function onDomNode<T>(cdp: CDPSession, backendNodeId: number, fn: string, arg: unknown = null): Promise<T> {
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
  const { result } = await cdp.send('Runtime.callFunctionOn',
    { objectId: object.objectId!, functionDeclaration: fn, arguments: [{ value: arg }], returnByValue: true });
  return result.value as T;
}

/** Controls (buttons, links, fields, disclosures …) that are exposed with an empty name. */
async function unnamedControls(page: Page, { ignore = '' } = {}): Promise<string[]> {
  return withCDP(page, async (cdp) => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
    const bad: string[] = [];
    for (const n of nodes) {
      if (n.ignored || !INTERACTIVE.has(n.role?.value ?? '') || (n.name?.value ?? '').trim() || !n.backendDOMNodeId) continue;
      const [html, skip] = await onDomNode<[string, boolean]>(cdp, n.backendDOMNodeId,
        'function (sel) { return [this.outerHTML.replace(/\\s+/g, " ").slice(0, 160), !!sel && !!this.closest && !!this.closest(sel)]; }', ignore);
      if (!skip) bad.push(`${n.role?.value}: ${html}`);
    }
    return bad;
  });
}

/** The expanded state Chromium reports for the control with this role and exact name. */
async function expandedState(page: Page, role: string, name: string): Promise<unknown> {
  return withCDP(page, async (cdp) => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
    const n = nodes.find((x) => !x.ignored && x.role?.value === role && (x.name?.value ?? '').trim() === name);
    if (!n) return 'not in the accessibility tree';
    return n.properties?.find((p) => p.name === 'expanded')?.value.value ?? 'no expanded state';
  });
}

/** The level-1 headings a screen reader is given (inert and hidden parts don't count). */
async function exposedH1s(page: Page): Promise<string[]> {
  return withCDP(page, async (cdp) => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
    return nodes.filter((n) => !n.ignored && n.role?.value === 'heading'
      && n.properties?.some((p) => p.name === 'level' && p.value.value === 1)).map((n) => n.name?.value ?? '');
  });
}

/** Names of controls a screen reader can still reach outside `container`. */
async function reachableOutside(page: Page, container: string): Promise<string[]> {
  return withCDP(page, async (cdp) => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree') as { nodes: AXNode[] };
    const out: string[] = [];
    for (const n of nodes) {
      if (n.ignored || !INTERACTIVE.has(n.role?.value ?? '') || !n.backendDOMNodeId) continue;
      const inside = await onDomNode<boolean>(cdp, n.backendDOMNodeId,
        'function (sel) { return !!this.closest && !!this.closest(sel); }', container);
      if (!inside) out.push(`${n.role?.value} "${n.name?.value ?? ''}"`);
    }
    return out;
  });
}

// --- in-page helpers (colour maths, focus rings, layout, motion) ------------------------------
// Installed with addInitScript so every page the test visits has window.__a11y.

function installHelpers() {
  type RGBA = { r: number; g: number; b: number; a: number };
  const parse = (c: string): RGBA | null => {
    let m = /rgba?\(([^)]+)\)/.exec(c || '');
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    m = /color\(srgb ([^)]+)\)/.exec(c || '');
    if (m) {
      const p = m[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 };
    }
    m = /^#([0-9a-f]{6})$/i.exec((c || '').trim());
    if (m) { const v = parseInt(m[1], 16); return { r: v >> 16, g: (v >> 8) & 255, b: v & 255, a: 1 }; }
    return null;
  };
  const over = (top: RGBA, bottom: RGBA): RGBA => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
  });
  const lum = (c: RGBA) => {
    const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a: RGBA, b: RGBA) => {
    const x = lum(a), y = lum(b);
    return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
  };
  const hex = (c: RGBA) => '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  /** What is painted behind `el`: its own and its ancestors' backgrounds, stacked. */
  const background = (el: Element | null): RGBA => {
    const layers: RGBA[] = [];
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg: RGBA = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };
  const opacityOf = (el: Element) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  };
  const shown = (el: Element) => {
    if (!el.getClientRects().length) return false;
    // closed <details> content and display:none ancestors (content-visibility: hidden) aren't drawn
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && !el.closest('.sr-only, [aria-hidden="true"], [hidden]');
  };
  /** The text a sighted user sees in `el` (not screen-reader-only or clipped-away text). */
  const visibleText = (el: Element) => {
    let t = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement!;
      if (p.closest('.sr-only, [aria-hidden="true"]')) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || /inset\(50%\)/.test(getComputedStyle(p).clipPath)) continue;
      t += n.textContent;
    }
    return t.replace(/\s+/g, ' ').trim();
  };
  /** Text that is laid out (visible, or clipped for screen readers): it can name the control. */
  const renderedText = (el: Element) => {
    let t = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement!;
      if (p.closest('[aria-hidden="true"]') || !p.getClientRects().length) continue;
      t += n.textContent;
    }
    return t.replace(/\s+/g, ' ').trim();
  };
  const drawn = (el: Element) => !!el.getClientRects().length
    && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions));
  /** Text colour against what is behind it. Large = 24px, or 18.66px bold (WCAG). */
  const textContrast = (el: Element) => {
    const cs = getComputedStyle(el);
    const bg = background(el);
    const c = parse(cs.color) ?? { r: 0, g: 0, b: 0, a: 1 };
    const fg = over({ ...c, a: c.a * opacityOf(el) }, bg);
    const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    return { ratio: ratio(fg, bg), need: large ? 3 : 4.5, fg: hex(fg), bg: hex(bg),
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40), size };
  };
  /** Every visible piece of text under `root` that is below AA. */
  const scan = (root: Element) => {
    const bad: ReturnType<typeof textContrast>[] = [];
    const seen = new Set<Element>();
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !(n.textContent || '').trim()) continue;
      seen.add(el);
      if (!shown(el) || el.closest('svg')) continue;
      const r = textContrast(el);
      if (r.ratio < r.need) bad.push(r);
    }
    return bad;
  };
  /** The colour of an icon (SVG uses currentColor) against what is behind it. */
  const iconContrast = (el: Element) => {
    const svg = el.querySelector('svg') ?? el;
    const c = parse(getComputedStyle(svg).color) ?? { r: 0, g: 0, b: 0, a: 1 };
    const bg = background(el);
    const r = svg.getBoundingClientRect();
    return { ratio: ratio(over(c, bg), bg), w: r.width, h: r.height };
  };
  /** Contrast of two CSS colour expressions, resolved on a probe element. */
  const tokenContrast = (fgExpr: string, bgExpr: string) => {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;top:0;left:0;width:1px;height:1px;color:${fgExpr};background:${bgExpr}`;
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const r = ratio(parse(cs.color)!, parse(cs.backgroundColor)!);
    probe.remove();
    return r;
  };
  /** Where the focused element is, its name, and the focus indicator drawn for it. */
  const focusInfo = () => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return { where: 'body', name: '', ring: null as null | string, ringContrast: 0, x: 0, y: 0, cls: '' };
    const where = a.matches('.skip') ? 'skip' : a.closest('header.top') ? 'banner' : a.closest('#sidebar') ? 'nav'
      : a.closest('main') ? 'main' : a.closest('#flash') ? 'snackbar' : a.closest('#compose-dock') ? 'compose' : 'other';
    const field = a as HTMLInputElement;
    const label = field.labels?.length ? [...field.labels].map((l) => l.innerText).join(' ') : '';
    const name = (a.getAttribute('aria-label') || label || a.innerText || field.placeholder || a.getAttribute('title') || '')
      .replace(/\s+/g, ' ').trim();
    let ring: string | null = null;
    let ringContrast = 0;
    // an outline on the element, or on the box that draws it (a row draws its link's ring)
    for (const box of [a, a.closest('.card'), a.closest('label')]) {
      if (!box) continue;
      const cs = getComputedStyle(box);
      if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) {
        const ringColor = parse(cs.outlineColor) ?? { r: 0, g: 0, b: 0, a: 1 };
        const inside = parseFloat(cs.outlineOffset) < 0;
        const behind = background(inside ? box : box.parentElement);
        ring = `${cs.outlineWidth} ${cs.outlineStyle} outline on ${box === a ? 'itself' : box.className}`;
        ringContrast = ratio(over(ringColor, behind), behind);
        break;
      }
    }
    // fields draw a 2px line or ring with box-shadow on their row instead
    if (!ring) {
      for (const box of [a, a.closest('.cf-row'), a.closest('.help-write')]) {
        if (!box) continue;
        const sh = getComputedStyle(box).boxShadow;
        if (sh && sh !== 'none' && /\b[23]px\b/.test(sh)) {
          ring = `box-shadow on ${box === a ? 'itself' : box.className}`;
          const col = parse(sh) ?? { r: 0, g: 0, b: 0, a: 1 };
          const behind = background(box);
          ringContrast = ratio(over(col, behind), behind);
          break;
        }
      }
    }
    const r = a.getBoundingClientRect();
    return { where, name, ring, ringContrast, x: r.left, y: r.top, cls: String(a.className) };
  };
  /** Controls that can't be seen or tapped: off-screen, clipped, or covered by something else. */
  const layout = async (rootSel?: string) => {
    const vw = document.documentElement.clientWidth;
    const root = rootSel ? document.querySelector(rootSel)! : document;
    const problems: string[] = [];
    const sideways = document.documentElement.scrollWidth - vw;
    if (sideways > 1) problems.push(`the page scrolls sideways by ${sideways}px (${document.documentElement.scrollWidth} in ${vw})`);
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const controls = [...root.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary')]
      // the skip link waits off-screen until it has focus; the matrix dock tucks away while scrolling (DESIGN §7)
      .filter((el) => shown(el) && !el.closest('[inert], .skip, .dock, .sprite')) as HTMLElement[];
    const startY = window.scrollY;
    for (const el of controls) {
      let r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      await frame();
      r = el.getBoundingClientRect();
      const hits = [[0.5, 0.5], [0.2, 0.5], [0.8, 0.5], [0.5, 0.25], [0.5, 0.75]].some(([fx, fy]) => {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const h = document.elementFromPoint(x, y);
        return !!h && (h === el || el.contains(h) || !!(el as HTMLInputElement).labels?.length
          && [...(el as HTMLInputElement).labels!].some((l) => l.contains(h)) || (h.closest('label')?.contains(el) ?? false));
      });
      if (!hits) {
        const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const name = (el.getAttribute('aria-label') || el.innerText || (el as HTMLInputElement).placeholder || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 30);
        problems.push(`"${name}" at x=${Math.round(r.left)}..${Math.round(r.right)} (viewport ${innerWidth}) is ${h ? 'under ' + (h.className || h.tagName) : 'off-screen'}`);
      }
    }
    window.scrollTo({ top: startY, behavior: 'instant' as ScrollBehavior });
    return problems;
  };
  (window as unknown as { __a11y: unknown }).__a11y = { textContrast, scan, iconContrast, tokenContrast, focusInfo, layout, shown, visibleText, renderedText, drawn };
}

/** Records every animation, transition and inline transform / clip-path the page starts. */
function recordMotion() {
  type Rec = { kind: string; props: string[]; duration: number; target: string };
  const recs: Rec[] = [];
  (window as unknown as { __motion: Rec[] }).__motion = recs;
  const name = (el: Element | null) => (el ? `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String((el as HTMLElement).className || '').split(' ').slice(0, 2).join('.')}` : '');
  const seen = new WeakSet<Animation>();
  const tick = () => {
    for (const a of document.getAnimations()) {
      if (seen.has(a)) continue;
      seen.add(a);
      const effect = a.effect as KeyframeEffect | null;
      const props = new Set<string>();
      const tp = (a as unknown as { transitionProperty?: string }).transitionProperty;
      if (tp) props.add(tp);
      for (const k of effect?.getKeyframes() ?? []) {
        for (const p of Object.keys(k)) if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) props.add(p);
      }
      recs.push({ kind: a.constructor.name, props: [...props], duration: Number(effect?.getTiming().duration) || 0,
        target: name(effect?.target ?? null) + (effect?.pseudoElement ?? '') });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // the springs in app.js move things frame by frame with inline styles
  new MutationObserver((muts) => {
    for (const m of muts) {
      const el = m.target as HTMLElement;
      const moved = [el.style.transform, el.style.clipPath].find((v) => v && v !== 'none');
      if (moved) recs.push({ kind: 'inline style', props: [el.style.transform ? 'transform' : 'clip-path'], duration: 0, target: name(el) });
    }
  }).observe(document, { attributes: true, attributeFilter: ['style'], subtree: true });
}

// --- screenshots: how much of a picture changed (no image library needed) --------------------------

/** Decode an 8-bit RGB / RGBA PNG (what Playwright's screenshots are) to RGBA pixels. */
function decodePng(buf: Buffer) {
  let pos = 8, width = 0, height = 0, type = 6;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4); type = chunk[9]; }
    if (kind === 'IDAT') idat.push(chunk);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2];
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** Share (0–1) of pixels that clearly changed between two screenshots of the same element. */
function changedShare(before: Buffer, after: Buffer) {
  const a = decodePng(before), b = decodePng(after);
  if (a.width !== b.width || a.height !== b.height) return 1;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > 48) n++;
  }
  return n / (a.width * a.height);
}

type FocusStop = { where: string; name: string; ring: string | null; ringContrast: number; x: number; y: number; cls: string };
const focusInfo = (page: Page) => page.evaluate(() => (window as any).__a11y.focusInfo()) as Promise<FocusStop>;
const layoutProblems = (page: Page, root?: string) =>
  page.evaluate((r) => (window as any).__a11y.layout(r), root) as Promise<string[]>;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(installHelpers);
});

// --- names, headings, landmarks --------------------------------------------------------------

test.describe('Names, headings and landmarks', () => {
  test('every control on the inbox, its menus and an open email has an accessible name', async ({ page, isPhone }) => {
    const missing: string[] = [];
    // the top bar's logo link is checked on its own below ("icon-only controls …")
    const check = async (where: string) => {
      for (const m of await unnamedControls(page, { ignore: 'a.brand' })) missing.push(`${where} → ${m}`);
    };
    await page.goto('/');
    await expect(rowLink(page, CONTRACT)).toBeVisible();
    await check('inbox');
    await press(settingsButton(page));
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeVisible();
    await check('inbox with ⚙ Settings open');
    await page.keyboard.press('Escape');
    if (!isTouch()) {
      await page.keyboard.press('?');
      await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
      await check('shortcut sheet');
      await page.keyboard.press('Escape');
    }
    if (isTouch()) {
      await press(menuButton(page));
      await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
      await check('drawer');
      await page.keyboard.press('Escape');
      await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    }
    await press(rowLink(page, CONTRACT));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await check('open email');
    await press(pane(page).getByLabel('Move to', { exact: true }).first());
    await check('open email with Move to open');
    expect(missing, 'controls without an accessible name').toEqual([]);
  });

  test('every control on compose, All mail, the matrix, Sent, Rules and the full-page views has a name', async ({ page }) => {
    const missing: string[] = [];
    const check = async (where: string) => {
      for (const m of await unnamedControls(page, { ignore: 'a.brand' })) missing.push(`${where} → ${m}`);
    };
    await page.goto('/');
    await press(composeOpener(page));
    await expect(composeWindow(page)).toBeVisible();
    await press(composeWindow(page).getByRole('button', { name: 'Help me write' }));
    await check('compose window');
    for (const url of ['/?view=all', '/?view=matrix', '/sent', '/rules', '/message/1', '/compose',
      '/compose?mode=reply&reply=1']) {
      await page.goto(url);
      await expect(page.locator('h1')).toBeAttached();
      await check(url);
    }
    expect(missing, 'controls without an accessible name').toEqual([]);
  });

  // Was a bug, now fixed: on tablets (<=1023px) the top bar's Inbox logo link has no accessible name at all, and the sidebar rail's icon links are named only by title
  test('icon-only controls are labelled with aria-label (or hidden text) on every layout', async ({ page }) => {
    const unlabelled: string[] = [];
    const check = async (where: string) => {
      const found = await page.evaluate(() => {
        const a11y = (window as any).__a11y;
        return [...document.querySelectorAll('button, a[href], summary, [role="button"]')]
          .filter((el) => a11y.shown(el) && !el.closest('[inert]'))
          .filter((el) => !a11y.visibleText(el))
          .filter((el) => !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !a11y.renderedText(el))
          .map((el) => el.outerHTML.replace(/\s+/g, ' ').slice(0, 140));
      });
      for (const f of found) unlabelled.push(`${where} → ${f}`);
    };
    for (const url of ['/', '/?open=1', '/?view=matrix', '/sent', '/rules']) {
      await page.goto(url);
      await expect(page.getByRole('main')).toBeVisible();
      await check(url);
    }
    await page.goto('/');
    await press(composeOpener(page));
    await expect(composeWindow(page)).toBeVisible();
    await check('compose window');
    expect(unlabelled, 'icon-only controls without aria-label').toEqual([]);
  });

  test('every page has exactly one h1 and the banner, navigation and main landmarks', async ({ page, isPhone }) => {
    const pages: [string, string | RegExp][] = [
      ['/', 'Inbox: Do now'], ['/?tab=later', 'Inbox: Later'], ['/?view=all', 'All mail'],
      ['/?view=matrix', 'Priority matrix'], ['/sent', 'Sent'], ['/rules', 'Sender rules'],
      ['/compose', 'New message'], ['/message/1', CONTRACT],
    ];
    for (const [url, h1] of pages) {
      await page.goto(url);
      await expect(page.locator('h1'), `one h1 on ${url}`).toHaveCount(1);
      await expect(page.locator('h1'), `h1 on ${url}`).toHaveText(h1);
      expect(await exposedH1s(page), `h1s screen readers get on ${url}`).toEqual([await page.locator('h1').innerText()]);
      await expect(page.getByRole('banner'), `banner on ${url}`).toHaveCount(1);
      await expect(page.getByRole('main'), `main on ${url}`).toHaveCount(1);
      await expect(page.getByRole('search'), `search on ${url}`).toBeVisible();
      if (isPhone) {
        // a drawer on phones: the navigation is behind the Main menu button that controls it
        await expect(menuButton(page)).toHaveAttribute('aria-controls', 'sidebar');
        await expect(page.locator('nav#sidebar')).toHaveAttribute('aria-label', 'Mailboxes');
      } else {
        await expect(page.getByRole('navigation', { name: 'Mailboxes' }), `navigation on ${url}`).toBeVisible();
      }
    }
    if (isPhone) {
      await page.goto('/');
      await press(menuButton(page));
      await expect(page.getByRole('navigation', { name: 'Mailboxes' })).toBeVisible();
    }
  });

  // Was a bug, now fixed: with an email open, the page exposes no h1 (the list's h1 is hidden with the list; the subject is an h2)
  test('with an email open, screen readers still find exactly one h1', async ({ page }) => {
    await page.goto('/');
    await press(rowLink(page, CONTRACT));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(page.getByRole('heading', { name: CONTRACT })).toBeVisible();
    await settled(page);
    expect(await exposedH1s(page), 'h1s in the accessibility tree').toHaveLength(1);
  });

  test('the error page has one h1 and a main landmark', async ({ page, allowErrors }) => {
    allowErrors.push(/404/);
    await page.goto('/message/999999');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('404');
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to the inbox' })).toBeVisible();
    expect(await unnamedControls(page)).toEqual([]);
  });
});

// The sign-in page needs a dashboard started with a password. `loginRequired` is a worker option
// (it can't be switched on for one describe), so these tests start their own e2e/server.py --login.
test.describe('Sign-in page', () => {
  let proc: ChildProcess | null = null;
  let base = '';
  test.beforeAll(async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => { const { port: p } = s.address() as { port: number }; s.close(() => resolve(p)); });
    });
    const root = join(__dirname, '..');
    const python = process.env.PYTHON || (existsSync(join(root, '.venv/bin/python')) ? join(root, '.venv/bin/python') : 'python3');
    proc = spawn(python, ['e2e/server.py', String(port), '--login'], { cwd: root, stdio: 'ignore' });
    base = `http://127.0.0.1:${port}`;
    for (const until = Date.now() + 20_000; Date.now() < until;) {
      try { if ((await fetch(`${base}/__test/sent`)).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('e2e/server.py --login did not start');
  });
  test.afterAll(() => { proc?.kill(); });

  test('has one h1, a main landmark, labelled fields, and signs in with the keyboard alone', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sign in');
    await expect(page.getByRole('main')).toBeVisible();
    const password = page.getByRole('textbox', { name: 'Password' });
    await expect(password).toBeFocused(); // autofocus
    await expect(page.getByRole('checkbox', { name: /Keep me signed in/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(await unnamedControls(page)).toEqual([]);
    expect(await page.evaluate(() => (window as any).__a11y.scan(document.body)), 'text below AA contrast').toEqual([]);
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${base}/`);
    await expect(rowLink(page, CONTRACT)).toBeVisible();
  });

  test('a wrong password is announced as an alert and the field is marked invalid', async ({ page, allowErrors }) => {
    allowErrors.push(/401/);
    await page.goto(`${base}/login`);
    const password = page.getByRole('textbox', { name: 'Password' });
    await password.fill('not the password');
    await password.press('Enter');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText("That password isn't right");
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAttribute('aria-describedby', (await alert.getAttribute('id'))!);
    await expect(password).toBeFocused();
  });
});

// --- live regions, menus and dialogs ---------------------------------------------------------

test.describe('Live regions, menus and dialogs', () => {
  test('snackbars are announced: notes politely (status), errors as alerts', async ({ page }) => {
    await page.goto('/');
    // the container exists from the start, so screen readers watch it before anything appears
    await expect(page.locator('#flash')).toHaveAttribute('aria-live', 'polite');
    await press(rowLink(page, CONTRACT));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await press(moveButton(page, 'Later'));
    const note = page.locator('#flash').getByRole('status').filter({ hasText: 'Moved to Later' });
    await expect(note).toBeVisible();
    await expect(note.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(snackbar(page)).toHaveAttribute('role', 'status');

    await page.goto('/');
    await press(composeOpener(page));
    const form = composeWindow(page);
    await expect(form).toBeVisible();
    await press(form.getByRole('button', { name: 'Send' }));
    const alert = page.locator('#flash').getByRole('alert');
    await expect(alert).toHaveText(/Add at least one recipient\./);
    const to = form.getByRole('textbox', { name: 'To' });
    await expect(to).toHaveAttribute('aria-invalid', 'true');
    await expect(to).toBeFocused();
  });

  test("the Main menu button's aria-expanded matches whether the menu is shown", async ({ page, isPhone, isTablet }) => {
    await page.goto('/');
    const btn = menuButton(page);
    await expect(btn).toHaveAttribute('aria-controls', 'sidebar');
    if (isPhone || isTablet) {
      await expect(btn).toHaveAttribute('aria-expanded', 'false');
      await press(btn);
      await expect(btn).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('navigation', { name: 'Mailboxes' }).getByRole('link', { name: /^Sent/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(btn).toHaveAttribute('aria-expanded', 'false');
    } else {
      // desktop: the button folds the sidebar into a rail of icons and back
      const sentLabel = page.getByRole('navigation', { name: 'Mailboxes' }).getByText('Sent', { exact: true });
      await expect(sentLabel).toBeVisible(); // full sidebar with labels
      await expect(btn, 'the full sidebar is shown').toHaveAttribute('aria-expanded', 'true');
      await press(btn);
      // folded into the rail: the labels are only for screen readers now
      await expect.poll(() => sentLabel.evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
      await expect(btn, 'the sidebar is folded').toHaveAttribute('aria-expanded', 'false');
    }
  });

  test('Settings and Move to report their expanded state; Help me write has aria-expanded', async ({ page }) => {
    await page.goto('/');
    expect(await expandedState(page, 'DisclosureTriangle', 'Settings')).toBe(false);
    await press(settingsButton(page));
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeVisible();
    expect(await expandedState(page, 'DisclosureTriangle', 'Settings')).toBe(true);
    // its parts have real roles and states
    await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Auto' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Open next email after an action' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeHidden();
    expect(await expandedState(page, 'DisclosureTriangle', 'Settings')).toBe(false);

    await press(rowLink(page, CONTRACT));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    expect(await expandedState(page, 'DisclosureTriangle', 'Move to')).toBe(false);
    await press(pane(page).getByLabel('Move to', { exact: true }).first());
    expect(await expandedState(page, 'DisclosureTriangle', 'Move to')).toBe(true);
    await page.keyboard.press('Escape');

    await page.goto('/');
    await press(composeOpener(page));
    const help = composeWindow(page).getByRole('button', { name: 'Help me write' });
    await expect(help).toHaveAttribute('aria-expanded', 'false');
    await press(help);
    await expect(help).toHaveAttribute('aria-expanded', 'true');
    await expect(composeWindow(page).getByRole('textbox', { name: 'Help me write' })).toBeVisible();
  });

  test('the keyboard shortcuts sheet is a labelled dialog (only offered with a keyboard and mouse)', async ({ page }) => {
    await page.goto('/');
    await press(settingsButton(page));
    const item = page.getByRole('button', { name: /^Keyboard shortcuts/ });
    if (isTouch()) {
      // touch screens get no single-key shortcuts entry (style.css: .keys-item hidden without a fine pointer)
      await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeVisible();
      await expect(item).toBeHidden();
      return;
    }
    await press(item);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(dialog.getByRole('switch', { name: 'Single-key shortcuts' })).toHaveAttribute('aria-checked', 'true');
  });
});

// --- keyboard only (desktop) -----------------------------------------------------------------

test.describe('Keyboard only', () => {
  test.beforeEach(() => { test.skip(isTouch(), KEYBOARD_ONLY); });

  test('Tab walks the inbox in visual order with a visible focus ring on every stop', async ({ page }) => {
    await page.goto('/');
    await expect(rowLink(page, PAYMENT)).toBeVisible();
    const stops: FocusStop[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const s = await focusInfo(page);
      if (s.where === 'body') break;
      stops.push(s);
      if (s.name.startsWith('Mark as read: ' + PAYMENT)) break;
    }
    const names = stops.map((s) => s.name);
    expect(names[0]).toBe('Skip to the email');
    // the order a sighted user reads: top bar, then the sidebar top to bottom, then the list
    const order = ['Main menu', 'Search mail', 'Refresh', 'Settings', 'Compose', 'All mail', 'Priority matrix',
      'Sent', 'Sender rules', 'Unread', 'Do now', 'Schedule', 'Quick reply', 'Later', 'Not sorted'];
    let at = -1;
    for (const want of order) {
      const i = names.findIndex((n, k) => k > at && n.startsWith(want));
      expect(i, `"${want}" comes after "${names[at] ?? 'the start'}" (stops: ${names.join(' · ')})`).toBeGreaterThan(at);
      at = i;
    }
    const contract = names.findIndex((n) => n.includes(CONTRACT));
    const payment = names.findIndex((n) => n.includes(PAYMENT) && !n.startsWith('Mark as read'));
    expect(contract, 'the first email comes after the tabs').toBeGreaterThan(at);
    expect(payment, 'the second email comes after the first').toBeGreaterThan(contract);
    // regions are never revisited: skip link → banner → sidebar → main
    const rank = { skip: 0, banner: 1, nav: 2, main: 3 } as Record<string, number>;
    const ranks = stops.map((s) => rank[s.where] ?? 99);
    expect(ranks, `region order (${stops.map((s) => s.where).join(',')})`).toEqual([...ranks].sort((a, b) => a - b));
    // tabs left to right, emails top to bottom
    const tabs = stops.filter((s) => / tab /.test(` ${s.cls} `));
    expect(tabs.length).toBe(5);
    expect(tabs.map((t) => t.x)).toEqual([...tabs.map((t) => t.x)].sort((a, b) => a - b));
    expect(stops[payment].y).toBeGreaterThan(stops[contract].y);
    // a visible ring on every stop, with at least 3:1 against what is behind it (WCAG 1.4.11 / 2.4.7)
    const noRing = stops.filter((s) => !s.ring || s.ringContrast < 3).map((s) => `${s.name}: ${s.ring ?? 'no ring'} (${s.ringContrast}:1)`);
    expect(noRing, 'stops without a visible focus ring').toEqual([]);
  });

  test('the skip link shows on the first Tab and jumps past the top bar and sidebar', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the email' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    const s = await focusInfo(page);
    expect(s.where).toBe('main');
    expect(s.name).toBe('Unread');
  });

  test('Tab through the compose window: logical order and a focus indicator on every field and button', async ({ page }) => {
    await page.goto('/');
    await expect(rowLink(page, CONTRACT)).toBeVisible();
    await page.keyboard.press('c');
    const form = composeWindow(page);
    await expect(form.getByRole('textbox', { name: 'To' })).toBeFocused();
    const stops: FocusStop[] = [await focusInfo(page)];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      const s = await focusInfo(page);
      if (s.where !== 'compose') break;
      stops.push(s);
    }
    const names = stops.map((s) => s.name || s.cls);
    const order = ['Cc', 'Bcc', 'Subject', 'Message', 'Send', 'Help me write', 'Discard draft'];
    let at = 0;
    for (const want of order) {
      const i = names.findIndex((n, k) => k > at && (n === want || n.startsWith(want)));
      expect(i, `"${want}" after "${names[at]}" (stops: ${names.join(' · ')})`).toBeGreaterThan(at);
      at = i;
    }
    // the fields are unnamed in innerText terms: check each stop draws something
    const noRing = stops.filter((s) => !s.ring || s.ringContrast < 3).map((s) => `${s.name || s.cls}: ${s.ring ?? 'no indicator'}`);
    expect(noRing, 'compose stops without a visible focus indicator').toEqual([]);
  });

  test('open with Enter, reply with r, send with Ctrl+Enter: the reply goes out threaded', async ({ page, sentMail }) => {
    await page.goto('/');
    await tabTo(page, rowLink(page, CONTRACT));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/[?&]open=1\b/);
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await expect(subjectOf(page)).toBeFocused();
    await page.keyboard.press('r');
    const reply = pane(page).getByRole('form', { name: 'Reply' });
    const body = reply.getByRole('textbox', { name: 'Message' });
    await expect(body).toBeFocused();
    await page.keyboard.type('Signed and sent back. Thanks!');
    await page.keyboard.press('Control+Enter');
    await expect(snackbar(page)).toContainText('Sending…');
    // the Undo is where the keyboard is: one Enter away
    await expect(snackbar(page).getByRole('button', { name: 'Undo' })).toBeFocused();
    await expect.poll(sentMail, { timeout: 20_000, message: 'the reply reached the mail server' }).toHaveLength(1);
    const [mail] = await sentMail();
    expect(mail.to).toContain('priya@acme.example');
    expect(mail.subject).toBe(`Re: ${CONTRACT}`);
    expect(mail.in_reply_to).toBe('<m1@demo>');
    expect(mail.body).toContain('Signed and sent back. Thanks!');
    await expect(page.locator('#flash').getByRole('status').filter({ hasText: 'Message sent' })).toBeVisible();
  });

  test('Undo a keyboard send with Enter on the snackbar: the reply comes back to edit and nothing goes out', async ({ page, sentMail }) => {
    await page.goto('/');
    await tabTo(page, rowLink(page, CONTRACT));
    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toBeFocused();
    await page.keyboard.press('r');
    await expect(pane(page).getByRole('textbox', { name: 'Message' })).toBeFocused();
    await page.keyboard.type('Wait, one more thing');
    await page.keyboard.press('Control+Enter');
    const undo = snackbar(page).getByRole('button', { name: 'Undo' });
    await expect(undo).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('#flash').getByRole('status').filter({ hasText: 'Sending undone' })).toBeVisible();
    // the undone reply opens for editing with what was typed, and the keyboard is in it
    // (the inline reply that was sent leaves the page with a short fade; the window is the one to edit)
    const back = composeWindow(page, 'Reply').filter({ has: page.getByRole('button', { name: 'Save & close' }) });
    await expect(back).toBeVisible();
    await expect(back.getByRole('textbox', { name: 'Message' })).toHaveValue(/^Wait, one more thing/);
    await expect(back.getByRole('textbox', { name: 'Message' })).toBeFocused();
    // the Sent page lists it as undone (g then t), and the mail server got nothing
    await page.keyboard.press('Escape');
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/sent$/);
    await expect(page.getByRole('listitem').filter({ hasText: CONTRACT })).toContainText('Undone');
    expect(await sentMail()).toEqual([]);
  });

  test('z undoes a send from the compose window', async ({ page, sentMail }) => {
    await page.goto('/');
    await expect(rowLink(page, CONTRACT)).toBeVisible();
    await page.keyboard.press('c');
    const form = composeWindow(page);
    await expect(form.getByRole('textbox', { name: 'To' })).toBeFocused();
    await page.keyboard.type('dev@acme.example');
    await tabTo(page, form.getByRole('textbox', { name: 'Subject' }));
    await page.keyboard.type('Keyboard only');
    await page.keyboard.press('Tab');
    await expect(form.getByRole('textbox', { name: 'Message' })).toBeFocused();
    await page.keyboard.type('Sent without touching the mouse.');
    await page.keyboard.press('Control+Enter');
    await expect(snackbar(page)).toContainText('Sending…');
    await page.keyboard.press('z');
    await expect(page.locator('#flash').getByRole('status').filter({ hasText: 'Sending undone' })).toBeVisible();
    await expect(composeWindow(page)).toHaveCount(1); // the sent window has finished leaving
    await expect(composeWindow(page).getByRole('textbox', { name: 'Subject' })).toHaveValue('Keyboard only');
    await expect(composeWindow(page).getByRole('textbox', { name: 'Message' })).toHaveValue('Sent without touching the mouse.');
    expect(await sentMail()).toEqual([]);
  });

  test('focus is not lost when the Sending… snackbar ends', async ({ page, sentMail }) => {
    await page.goto('/');
    await tabTo(page, rowLink(page, CONTRACT));
    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toBeFocused();
    await page.keyboard.press('r');
    await expect(pane(page).getByRole('textbox', { name: 'Message' })).toBeFocused();
    await page.keyboard.type('Done.');
    await page.keyboard.press('Control+Enter');
    await expect(snackbar(page).getByRole('button', { name: 'Undo' })).toBeFocused();
    await expect.poll(sentMail, { timeout: 20_000 }).toHaveLength(1);
    await expect(page.locator('#flash').getByRole('status').filter({ hasText: 'Message sent' })).toBeVisible();
    // the next Tab must not start over from the top of the page: focus is back in the email
    await expect(page.locator('body')).not.toBeFocused();
    expect((await focusInfo(page)).where, 'focus after the snackbar went').not.toBe('body');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#pane'))).toBe(true);
  });

  test('Settings opens with Enter, its theme and switches work by keyboard, Esc closes it and refocuses ⚙; choices survive a reload', async ({ page }) => {
    await page.goto('/');
    await tabTo(page, settingsButton(page));
    await page.keyboard.press('Enter');
    expect(await expandedState(page, 'DisclosureTriangle', 'Settings')).toBe(true);
    await page.keyboard.press('Tab');
    const auto = page.getByRole('radio', { name: 'Auto' });
    await expect(auto).toBeFocused();
    // the focused theme segment shows a ring (it is drawn on the label)
    const s = await focusInfo(page);
    expect(s.ring, 'focus ring on the theme picker').not.toBeNull();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Light' })).toBeChecked();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.keyboard.press('Tab');
    const compact = page.getByRole('switch', { name: 'Compact rows' });
    await expect(compact).toBeFocused();
    await page.keyboard.press('Space');
    await expect(compact).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(compact).toBeHidden();
    await expect(settingsButton(page)).toBeFocused();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    await tabTo(page, settingsButton(page));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('radio', { name: 'Dark' })).toBeChecked();
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toHaveAttribute('aria-checked', 'true');
  });

  test('the shortcuts sheet (?) takes focus to Close and gives it back to whoever opened it', async ({ page }) => {
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    // from an email in the list
    await tabTo(page, rowLink(page, CONTRACT));
    await page.keyboard.press('?');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(rowLink(page, CONTRACT)).toBeFocused();
    // from ⚙ › Keyboard shortcuts: back to ⚙, since that menu closed
    await tabTo(page, settingsButton(page));
    await page.keyboard.press('Enter');
    await tabTo(page, page.getByRole('button', { name: /^Keyboard shortcuts/ }));
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeHidden(); // ⚙ has closed behind it
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(settingsButton(page)).toBeFocused();
  });

  test('Esc closes the open email and puts focus back on its row', async ({ page }) => {
    await page.goto('/');
    await tabTo(page, rowLink(page, PAYMENT));
    await page.keyboard.press('Enter');
    await expect(subjectOf(page)).toBeFocused();
    await expect(subjectOf(page)).toHaveText(PAYMENT);
    await page.keyboard.press('Escape');
    await expect(pane(page)).toBeHidden();
    await expect(page).not.toHaveURL(/open=/);
    await expect(rowLink(page, PAYMENT)).toBeFocused();
  });
});

// --- returning focus after compose (every device) ----------------------------------------------

test.describe('Compose window focus', () => {
  // Was a bug, now fixed: closing the compose window (Esc or "Save & close") drops focus to <body> instead of the Compose button that opened it
  test('closing the compose window gives focus back to the Compose button', async ({ page }) => {
    await page.goto('/');
    const opener = composeOpener(page);
    await expect(opener).toBeVisible();
    if (isTouch()) await opener.tap();
    else { await tabTo(page, opener); await page.keyboard.press('Enter'); }
    const form = composeWindow(page);
    await expect(form.getByRole('textbox', { name: 'To' })).toBeFocused();
    if (isTouch()) await form.getByRole('button', { name: 'Save & close' }).tap();
    else await page.keyboard.press('Escape');
    await expect(form).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

// --- the drawer on phones and tablets ------------------------------------------------------------

test.describe('Drawer (phone and tablet)', () => {
  test.beforeEach(({ isPhone, isTablet }) => { test.skip(!isPhone && !isTablet, NO_DRAWER); });

  /** Tab 25 times; every stop must be inside the drawer (or the browser's own UI, i.e. <body>). */
  async function tabStopsOutside(page: Page) {
    const outside: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      const s = await page.evaluate(() => {
        const a = document.activeElement;
        if (!a || a === document.body || a.closest('#sidebar')) return null;
        return (a.getAttribute('aria-label') || (a as HTMLElement).innerText || a.tagName).replace(/\s+/g, ' ').trim().slice(0, 40);
      });
      if (s && !outside.includes(s)) outside.push(s);
    }
    return outside;
  }

  test('opening the menu moves focus in, keeps Tab inside, hides the page behind, and Esc gives focus back', async ({ page }) => {
    await page.goto('/');
    await expect(rowLink(page, CONTRACT)).toBeVisible();
    await menuButton(page).tap();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    const nav = page.getByRole('navigation', { name: 'Mailboxes' });
    await expect(nav).toBeVisible();
    await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('#sidebar')), { message: 'focus moved into the menu' }).toBe(true);
    // the page behind is inert: no focus, nothing for VoiceOver / TalkBack
    for (const el of ['header.top', '#board', '.skip']) {
      expect(await page.locator(el).evaluate((e) => (e as HTMLElement).inert), `${el} is inert`).toBe(true);
    }
    expect(await reachableOutside(page, '#sidebar'), 'controls a screen reader can reach behind the menu').toEqual([]);
    expect(await tabStopsOutside(page), 'Tab stops outside the open menu').toEqual([]);
    await page.keyboard.press('Escape');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toBeFocused();
    for (const el of ['header.top', '#board']) {
      expect(await page.locator(el).evaluate((e) => (e as HTMLElement).inert), `${el} is back`).toBe(false);
    }
    await expect(rowLink(page, CONTRACT)).toBeVisible();
  });

  test('tapping the dimmed page beside the menu closes it and gives focus back to the menu button', async ({ page }) => {
    await page.goto('/');
    await menuButton(page).tap();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await settled(page);
    const vp = page.viewportSize()!;
    await page.touchscreen.tap(vp.width - 12, Math.round(vp.height / 2));
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(menuButton(page)).toBeFocused();
  });

  // Was a bug, now fixed: on Sent and Rules the page behind the open menu is not made inert (syncModal only inerts #board), so Tab and screen readers reach it
  test('on Sent and Rules the page behind the open menu is unreachable too', async ({ page }) => {
    const leaks: string[] = [];
    for (const url of ['/rules', '/sent']) {
      await page.goto(url);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await menuButton(page).tap();
      await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
      for (const s of await reachableOutside(page, '#sidebar')) leaks.push(`${url}: screen reader reaches ${s}`);
      for (const s of await tabStopsOutside(page)) leaks.push(`${url}: Tab reaches "${s}"`);
      await page.keyboard.press('Escape');
      await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    }
    expect(leaks, 'what can be reached behind the open menu').toEqual([]);
  });
});

// --- full-screen views: an email and compose on a phone --------------------------------------------------------------------

test.describe('Full-screen email and compose', () => {
  // Was a bug, now fixed: on a phone the full-screen compose sheet opened from Rules (or Sent) leaves the page behind it reachable (syncModal only inerts #board)
  test('the full-screen compose sheet on a phone hides the page behind it, on the inbox and on Rules', async ({ page, isPhone }) => {
    test.skip(!isPhone, 'Only phones show compose as a full-screen sheet; on wider screens it is a floating window beside the page');
    const leaks: string[] = [];
    for (const url of ['/', '/rules']) {
      await page.goto(url);
      await composeOpener(page).tap();
      const form = composeWindow(page);
      await expect(form.getByRole('textbox', { name: 'To' })).toBeFocused();
      await settled(page);
      for (const s of await reachableOutside(page, '#compose-dock')) leaks.push(`${url}: screen reader reaches ${s}`);
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press('Tab');
        const s = await page.evaluate(() => {
          const a = document.activeElement;
          if (!a || a === document.body || a.closest('#compose-dock')) return null;
          return (a.getAttribute('aria-label') || (a as HTMLElement).innerText || (a as HTMLInputElement).name || a.tagName).trim().slice(0, 30);
        });
        if (s && !leaks.includes(`${url}: Tab reaches "${s}"`)) leaks.push(`${url}: Tab reaches "${s}"`);
      }
      await form.getByRole('button', { name: 'Save & close' }).tap();
      await expect(form).toBeHidden();
    }
    expect(leaks, 'what can be reached behind the compose sheet').toEqual([]);
  });

  test('an opened email takes focus on a phone and hides the list behind it', async ({ page, isPhone }) => {
    await page.goto('/');
    await press(rowLink(page, CONTRACT));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    if (isPhone) {
      await expect(subjectOf(page)).toBeFocused();
      for (const el of ['header.top', '#board']) {
        expect(await page.locator(el).evaluate((e) => (e as HTMLElement).inert), `${el} is inert`).toBe(true);
      }
      expect(await reachableOutside(page, '#pane'), 'controls reachable behind the email').toEqual([]);
    } else {
      // tablet and desktop: the email takes the list's place (the list is not displayed at all)
      await expect(list(page)).toBeHidden();
      await expect(menuButton(page)).toBeVisible();
    }
    await press(pane(page).getByRole('link', { name: 'Back to the list' }));
    await expect(pane(page)).toBeHidden();
    await expect(rowLink(page, CONTRACT)).toBeFocused();
  });
});

// --- colour contrast ---------------------------------------------------------------------------

type Pair = { label: string; ratio: number; need: number; fg?: string; bg?: string };

/** Spot checks (named pairs) and a full scan of each screen; returns everything below AA. */
async function contrastTour(page: Page): Promise<{ failures: string[]; measured: string[] }> {
  const failures: string[] = [];
  const measured: string[] = [];
  const spot = async (label: string, selector: string) => {
    const r = await page.evaluate((sel) => {
      const a11y = (window as any).__a11y;
      const el = [...document.querySelectorAll(sel)].find((e) => a11y.shown(e));
      return el ? a11y.textContrast(el) : null;
    }, selector) as Pair | null;
    if (!r) return;
    measured.push(label);
    if (r.ratio < r.need) failures.push(`${label}: ${r.ratio}:1 (needs ${r.need}) ${r.fg} on ${r.bg}`);
  };
  const scan = async (where: string, selector = 'body') => {
    const bad = await page.evaluate((sel) => (window as any).__a11y.scan(document.querySelector(sel)), selector) as (Pair & { text: string })[];
    for (const b of bad) failures.push(`${where} "${b.text}": ${b.ratio}:1 (needs ${b.need}) ${b.fg} on ${b.bg}`);
  };
  const icons = async (where: string, selector: string) => {
    const bad = await page.evaluate((sel) => {
      const a11y = (window as any).__a11y;
      return [...document.querySelectorAll(sel)].filter((e) => a11y.shown(e)).map((e) => ({ name: e.getAttribute('aria-label'), ...a11y.iconContrast(e) }))
        .filter((r) => r.ratio < 3).map((r) => `${r.name} icon ${r.ratio}:1`);
    }, selector) as string[];
    for (const b of bad) failures.push(`${where}: ${b} (needs 3)`);
  };

  await page.goto('/');
  await expect(rowLink(page, CONTRACT)).toBeVisible();
  await settled(page);
  await spot('body text: a sender in the list', '#board .row .sender');
  await spot('body text: a subject in the list', '#board .row .subject');
  await spot('secondary text: an email summary', '#board .row .snippet');
  await spot('tab label: current tab', '.tab[aria-current] .tab-name');
  await spot('tab label: other tab', '.tab:not([aria-current]) .tab-name');
  await spot('tab label: "new" count', '.tab:not([aria-current]) .tab-new');
  await spot('link: Unread filter', '.unread-chip');
  await spot('link: sidebar item', '#sidebar .nav-item .nav-text');
  await spot('button: Compose', '.fab span, .compose-btn span');
  await spot('secondary text: sorting status', '.sorting-budget');
  const ph = await page.evaluate(() => {
    const input = document.querySelector('input[type=search]')!;
    const probe = document.createElement('span');
    probe.textContent = 'x';
    probe.style.color = getComputedStyle(input, '::placeholder').color;
    input.parentElement!.append(probe);
    const r = (window as any).__a11y.textContrast(probe);
    probe.remove();
    return r;
  }) as Pair;
  measured.push('placeholder: Search mail');
  if (ph.ratio < 4.5) failures.push(`placeholder: Search mail ${ph.ratio}:1 ${ph.fg} on ${ph.bg}`);
  for (const [fg, bg] of [['var(--focus)', 'var(--bg)'], ['var(--focus)', 'var(--surface)']]) {
    const r = await page.evaluate(([f, b]) => (window as any).__a11y.tokenContrast(f, b), [fg, bg]) as number;
    measured.push(`focus ring on ${bg}`);
    if (r < 3) failures.push(`focus ring ${fg} on ${bg}: ${r}:1 (needs 3)`);
  }
  await icons('top bar', '.top .icon-btn');
  await scan('inbox');

  await press(rowLink(page, CONTRACT));
  await expect(subjectOf(page)).toHaveText(CONTRACT);
  await settled(page);
  await spot('body text: the email', '#pane .body-text');
  await spot('secondary text: to line', '#pane .to-line');
  await spot('secondary text: AI reason', '#pane .ai-reason');
  await spot('button: Reply', '#pane .reply-bar .btn span');
  await spot('button: Move to', '#pane .card-moves .move-label');
  await icons('email toolbar', '#pane .detail-bar .icon-btn');
  await scan('open email', '#pane');

  await press(moveButton(page, 'Later'));
  await expect(snackbar(page)).toContainText('Moved to Later');
  await settled(page);
  await spot('snackbar text', '.flash:not(.leaving) .flash-msg');
  await spot('snackbar action: Undo', '.flash:not(.leaving) .flash-btn');
  await scan('snackbar', '#flash');

  await page.goto('/');
  await press(composeOpener(page));
  await expect(composeWindow(page)).toBeVisible();
  await settled(page);
  await spot('button: Send', '.compose-window .send-btn span');
  await scan('compose window', '#compose-dock');
  for (const url of ['/?view=matrix', '/sent', '/rules']) {
    await page.goto(url);
    await settled(page);
    await scan(url);
  }
  return { failures, measured };
}

async function chooseTheme(page: Page, theme: 'Dark' | 'Light') {
  await page.goto('/');
  await press(settingsButton(page));
  await press(page.getByRole('radio', { name: theme }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
}

test.describe('Colour contrast (WCAG AA: 4.5:1 text, 3:1 large text and UI parts)', () => {
  const MUST_MEASURE = ['body text: a sender in the list', 'secondary text: an email summary', 'tab label: current tab',
    'tab label: other tab', 'link: Unread filter', 'placeholder: Search mail', 'body text: the email', 'button: Reply',
    'button: Move to', 'snackbar text', 'snackbar action: Undo', 'button: Send'];

  test('light (device setting)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const { failures, measured } = await contrastTour(page);
    expect(measured).toEqual(expect.arrayContaining(MUST_MEASURE));
    expect(failures).toEqual([]);
  });

  test('dark (device setting)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(14, 15, 12)');
    const { failures, measured } = await contrastTour(page);
    expect(measured).toEqual(expect.arrayContaining(MUST_MEASURE));
    expect(failures).toEqual([]);
  });

  test('the Dark setting on a light device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await chooseTheme(page, 'Dark');
    const { failures, measured } = await contrastTour(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(14, 15, 12)');
    expect(measured).toEqual(expect.arrayContaining(MUST_MEASURE));
    expect(failures).toEqual([]);
  });

  test('the Light setting on a dark device', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await chooseTheme(page, 'Light');
    const { failures, measured } = await contrastTour(page);
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(232, 235, 230)');
    expect(measured).toEqual(expect.arrayContaining(MUST_MEASURE));
    expect(failures).toEqual([]);
  });
});

// --- zoom and large text -------------------------------------------------------------------------

/** Visit the main screens and collect anything cut off, covered, or scrolling sideways. */
async function layoutTour(page: Page, urls: string[]) {
  const problems: string[] = [];
  for (const url of urls) {
    await page.goto(url);
    await expect(page.locator('h1')).toBeAttached();
    await settled(page);
    for (const p of await layoutProblems(page)) problems.push(`${url}: ${p}`);
  }
  return problems;
}

const bigText = (page: Page) => page.addInitScript(() => {
  document.addEventListener('DOMContentLoaded', () => { document.documentElement.style.fontSize = '200%'; });
});

test.describe('Zoom and large text', () => {
  // Was a bug, now fixed: at 200% zoom (and on a short phone screen) the ⚙ Settings menu runs off the bottom of the screen and can't be scrolled, cutting off its last items
  test('at 200% zoom nothing is cut off, covered or scrolls sideways', async ({ page, isPhone, isTablet }) => {
    // 200% zoom halves the CSS viewport: 1280 → 640 on a desktop, 810 → 405 on the tablet; a
    // phone is taken to 320px, the narrowest width WCAG 1.4.10 (Reflow) asks for
    const size = isPhone ? { width: 320, height: 332 } : isTablet ? { width: 405, height: 540 } : { width: 640, height: 450 };
    await page.setViewportSize(size);
    const problems = await layoutTour(page, ['/', '/?open=1', '/?view=all', '/?view=matrix', '/sent', '/rules']);
    await page.goto('/');
    await press(composeOpener(page));
    await expect(composeWindow(page)).toBeVisible();
    await settled(page);
    for (const p of await layoutProblems(page)) problems.push(`compose window: ${p}`);
    await page.goto('/');
    await press(settingsButton(page));
    await expect(page.getByRole('switch', { name: 'Compact rows' })).toBeVisible();
    await settled(page);
    // the menu covers the page on purpose: only its own items are checked
    for (const p of await layoutProblems(page, '#more-menu')) problems.push(`⚙ Settings: ${p}`);
    expect(problems).toEqual([]);
  });

  test('with text at 200%, the inbox, an email, All mail, the matrix and Sent still fit', async ({ page }) => {
    await bigText(page);
    const problems = await layoutTour(page, ['/', '/?open=1', '/?view=all', '/?view=matrix', '/sent']);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('32px');
    expect(problems).toEqual([]);
  });

  // Was a bug, now fixed: on a phone with 200% text the compose toolbar doesn't wrap: "Help me write" and "Discard draft" are pushed off-screen
  test('with text at 200%, the compose window keeps every button on screen', async ({ page }) => {
    await bigText(page);
    await page.goto('/');
    await press(composeOpener(page));
    await expect(composeWindow(page)).toBeVisible();
    await settled(page);
    const problems = await layoutProblems(page);
    const sheet = await composeWindow(page).evaluate((f) => f.scrollWidth - f.clientWidth);
    if (sheet > 1) problems.push(`the compose window scrolls sideways by ${sheet}px`);
    await page.goto('/compose');
    await settled(page);
    for (const p of await layoutProblems(page)) problems.push(`/compose: ${p}`);
    expect(problems).toEqual([]);
  });

  // Was a bug, now fixed: on a phone with 200% text the Rules page scrolls sideways (the rule-kind <fieldset> keeps its min-content width)
  test('with text at 200%, the Rules page does not scroll sideways', async ({ page }) => {
    await bigText(page);
    expect(await layoutTour(page, ['/rules'])).toEqual([]);
  });
});

// --- forced colours (Windows High Contrast) ------------------------------------------------------

test.describe('Forced colours', () => {
  test('controls stay visible: icons, text, button borders and the current tab', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/');
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    await expect(rowLink(page, CONTRACT)).toBeVisible();
    await settled(page);
    const check = async (where: string, selector: string) => page.evaluate(([w, sel]) => {
      const a11y = (window as any).__a11y;
      const out: string[] = [];
      for (const el of [...document.querySelectorAll(sel)].filter((e) => a11y.shown(e) && !e.closest('[inert]'))) {
        const name = el.getAttribute('aria-label') || a11y.visibleText(el).slice(0, 30);
        const svg = [...el.querySelectorAll('svg')].find((x) => a11y.drawn(x));
        if (el instanceof HTMLInputElement) {
          // an empty field is shown by its placeholder (in the system's GrayText)
          const probe = document.createElement('span');
          probe.textContent = 'x';
          probe.style.color = getComputedStyle(el, '::placeholder').color;
          el.parentElement!.append(probe);
          const r = a11y.textContrast(probe);
          probe.remove();
          if (r.ratio < 3) out.push(`${w} "${name}" placeholder ${r.ratio}:1`);
        } else if (a11y.visibleText(el)) {
          // measure the element that holds the text
          const holder = [...el.querySelectorAll('*'), el].find((x) => x.childNodes.length && [...x.childNodes]
            .some((c) => c.nodeType === 3 && (c.textContent || '').trim()) && a11y.shown(x)) ?? el;
          const r = a11y.textContrast(holder);
          if (r.ratio < 4.5) out.push(`${w} "${name}" text ${r.ratio}:1`);
        } else if (svg) {
          const r = a11y.iconContrast(el);
          if (r.ratio < 3 || r.w < 8) out.push(`${w} "${name}" icon ${r.ratio}:1 ${r.w}px`);
        } else out.push(`${w} "${name}" shows nothing`);
      }
      return out;
    }, [where, selector]) as Promise<string[]>;
    const problems = [
      ...await check('top bar', '.top .icon-btn, .top input[type=search]'),
      ...await check('tabs', '.tab'),
      ...await check('list', '#board .row-link'),
    ];
    // the current tab keeps a system-colour outline (style.css §24)
    const current = await page.locator('.tab[aria-current]').evaluate((e) => getComputedStyle(e).outlineStyle);
    expect(current, 'the current tab is outlined').not.toBe('none');
    await press(rowLink(page, CONTRACT));
    await expect(subjectOf(page)).toHaveText(CONTRACT);
    await settled(page);
    problems.push(...await check('email toolbar', '#pane .detail-bar .icon-btn'));
    problems.push(...await check('email buttons', '#pane .reply-bar .btn, #pane .card-moves .move'));
    // buttons get a CanvasText border so their shape survives
    const border = await pane(page).getByRole('link', { name: 'Reply', exact: true }).last()
      .evaluate((e) => getComputedStyle(e).borderStyle);
    expect(border, 'Reply keeps a border').toBe('solid');
    expect(problems).toEqual([]);
  });

  /** Share of the part's pixels that change when its state changes (screenshots before / after). */
  async function changeOnScreen(part: Locator, change: () => Promise<void>, page: Page) {
    await settled(page);
    const before = await part.screenshot({ animations: 'disabled' });
    await change();
    await settled(page);
    const after = await part.screenshot({ animations: 'disabled' });
    return changedShare(before, after);
  }

  // Was a bug, now fixed: in forced-colours mode the switches in ⚙ Settings lose their knob, so on and off look the same
  test('switches still show whether they are on', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await press(settingsButton(page));
    const compact = page.getByRole('switch', { name: 'Compact rows' });
    const knob = compact.locator('.knob'); // the drawn switch (aria-hidden)
    // normal colours: most of the knob changes (dark fill, thumb moves) — the method sees it
    const normal = await changeOnScreen(knob, () => press(compact), page);
    expect(normal, 'share of the knob that changes in normal colours').toBeGreaterThan(0.15);
    await expect(compact).toHaveAttribute('aria-checked', 'true');
    await press(compact);
    await expect(compact).toHaveAttribute('aria-checked', 'false');
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    const forced = await changeOnScreen(knob, () => press(compact), page);
    await expect(compact).toHaveAttribute('aria-checked', 'true');
    expect(forced, 'share of the knob that changes in forced colours (on vs off)').toBeGreaterThan(0.15);
  });

  // Was a bug, now fixed: in forced-colours mode the selected option of the segmented pickers (Theme in ⚙, rule kind on Rules) is invisible
  test('the selected option of segmented pickers is still visible', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const pickers: { url: string; open?: boolean; group: string; to: string; back: string }[] = [
      { url: '/', open: true, group: 'Theme', to: 'Light', back: 'Auto' },
      { url: '/rules', group: 'Rule', to: 'Always low priority', back: 'Always important (VIP)' },
    ];
    const invisible: string[] = [];
    for (const forced of [false, true]) {
      await page.emulateMedia({ forcedColors: forced ? 'active' : 'none', reducedMotion: 'reduce' });
      for (const p of pickers) {
        await page.goto(p.url);
        if (p.open) await press(settingsButton(page));
        const group = page.getByRole('group', { name: p.group });
        await expect(group).toBeVisible();
        const changed = await changeOnScreen(group, () => press(group.getByRole('radio', { name: p.to })), page);
        await expect(group.getByRole('radio', { name: p.to })).toBeChecked();
        if (!forced) expect(changed, `${p.group}: share that changes in normal colours`).toBeGreaterThan(0.02);
        else if (changed <= 0.02) invisible.push(`${p.group} (${p.url}): choosing "${p.to}" changes ${(changed * 100).toFixed(1)}% of it`);
        await press(group.getByRole('radio', { name: p.back }));
      }
    }
    expect(invisible).toEqual([]);
  });
});

// --- Reduce Motion -------------------------------------------------------------------------------

const MOVES = /transform|translate|scale|rotate|clip|inset|^(top|left|right|bottom|height|width|margin.*)$/i;

/** Open and close the drawer (phone / tablet), an email and the compose window. */
async function motionTour(page: Page, { isPhone, isTablet }: { isPhone: boolean; isTablet: boolean }) {
  await page.goto('/');
  await expect(rowLink(page, CONTRACT)).toBeVisible();
  await settled(page);
  await page.evaluate(() => { (window as any).__motion.length = 0; });
  if (isPhone || isTablet) {
    await press(menuButton(page));
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await settled(page);
    await page.keyboard.press('Escape');
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    await settled(page);
  }
  await press(rowLink(page, CONTRACT));
  await expect(subjectOf(page)).toHaveText(CONTRACT);
  await settled(page);
  await press(pane(page).getByRole('link', { name: 'Back to the list' }));
  await expect(pane(page)).toBeHidden();
  await settled(page);
  await press(composeOpener(page));
  await expect(composeWindow(page)).toBeVisible();
  await settled(page);
  await press(composeWindow(page).getByRole('button', { name: 'Save & close' }));
  await expect(composeWindow(page)).toBeHidden();
  await settled(page);
  return page.evaluate(() => (window as any).__motion) as Promise<{ kind: string; props: string[]; duration: number; target: string }[]>;
}

test.describe('Reduce Motion', () => {
  test('menu, email and compose only fade (200 ms at most): nothing slides or scales', async ({ page, isPhone, isTablet }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(recordMotion);
    const recs = await motionTour(page, { isPhone, isTablet });
    const moving = recs.filter((r) => r.props.some((p) => MOVES.test(p)))
      .map((r) => `${r.target}: ${r.kind} of ${r.props.join(',')} (${r.duration} ms)`);
    // DESIGN §7: Reduce Motion turns slides into ~150 ms fades (the compose fields fade 200 ms)
    const long = recs.filter((r) => r.duration > 200).map((r) => `${r.target}: ${r.props.join(',')} ${r.duration} ms`);
    expect(moving, 'movement with Reduce Motion on').toEqual([]);
    expect(long, 'animations longer than 200 ms with Reduce Motion on').toEqual([]);
    // the fades are there (it isn't just that nothing was recorded)
    expect(recs.some((r) => r.props.includes('opacity')), 'something faded').toBe(true);
  });

  test('without Reduce Motion the same steps do slide (the recorder sees movement)', async ({ page, isPhone, isTablet }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.addInitScript(recordMotion);
    const recs = await motionTour(page, { isPhone, isTablet });
    expect(recs.filter((r) => r.props.some((p) => MOVES.test(p))).length).toBeGreaterThan(0);
  });
});

// --- target sizes --------------------------------------------------------------------------------

// Was a bug, now fixed: on touch screens the email's toolbar buttons and the Move to buttons are 40px, and the menu's Categories / "Updated" rows 36px, under the 44px minimum
test('touch targets are at least 44px on touch screens (24px with a mouse)', async ({ page, isPhone, isTablet }) => {
  const min = isPhone || isTablet ? 44 : 24;
  const small: string[] = [];
  const measure = async (where: string, selector: string) => {
    const found = await page.evaluate(([sel, m]) => {
      const a11y = (window as any).__a11y;
      return [...document.querySelectorAll(sel as string)].filter((e) => a11y.shown(e) && !e.closest('[inert]'))
        .map((e) => ({ name: (e.getAttribute('aria-label') || (e as HTMLElement).innerText).replace(/\s+/g, ' ').trim().slice(0, 30), r: e.getBoundingClientRect() }))
        .filter(({ r }) => r.width < (m as number) || r.height < (m as number))
        .map(({ name, r }) => `${name} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }, [selector, min]) as string[];
    for (const f of found) small.push(`${where}: ${f}`);
  };
  await page.goto('/');
  await expect(rowLink(page, CONTRACT)).toBeVisible();
  await measure('top bar', '.top button, .top summary, .top input[type=search]');
  await measure('list', '.tabs .tab, #board .row-link');
  if (isPhone || isTablet) {
    await press(menuButton(page));
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    await measure('menu', '#sidebar a, #sidebar summary');
    await page.keyboard.press('Escape');
  }
  await press(rowLink(page, CONTRACT));
  await expect(subjectOf(page)).toHaveText(CONTRACT);
  await settled(page);
  await measure('email toolbar', '#pane .detail-bar a, #pane .detail-bar button, #pane .detail-bar summary');
  await measure('email', '#pane .card-moves .move, #pane .reply-bar .btn');
  await page.goto('/');
  await press(composeOpener(page));
  await expect(composeWindow(page)).toBeVisible();
  await settled(page);
  await measure('compose', '.compose-window .compose-head button, .compose-window .compose-bar button');
  expect(small, `controls under ${min}px`).toEqual([]);
});
