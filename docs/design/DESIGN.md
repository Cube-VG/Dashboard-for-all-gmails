# Unified Inbox — Design Spec (source of truth)

> **v2 (current): Gmail's structure, this file's palette.** The app is public and should need no
> learning, so layout and flow copy Gmail while colours, type, radii, glass menus and motion
> stay as specified below. Where v2 and an older section disagree, v2 wins.
>
> - **Shell:** app bar (menu, logo, wide search pill, refresh, settings gear) · left sidebar
>   (lime **Compose**, Inbox / All mail / Priority matrix / Sent / Sender rules, accounts as
>   coloured labels, collapsible Categories, sync status) · one white panel for content.
>   Tablets get a rail of icons; phones a drawer, a search pill on top and a Compose button
>   bottom right.
> - **Inbox = tabs**, like Primary / Promotions / Social: Do now · Schedule · Quick reply · Later
>   (· Not sorted while the AI works). The tab underline and "N new" badge use the quadrant
>   colour. The four-box matrix is a view in the sidebar, no longer the first screen.
> - **Rows**, Gmail density: sender · label chips + subject – AI summary · date; unread rows
>   white and bold, read rows `--row-read`; hover lifts the row and shows mark read/unread.
>   Phones: avatar, sender + time, subject, two-line summary.
> - **Reading view** replaces the list (Gmail default; "Reading pane on the right" in
>   settings for ≥1280px): toolbar icons (back, read, Move to, reply, newer/older, Open in
>   Gmail), subject + labels, the AI card (Gmail's summary card), sender line with avatar,
>   body, and Reply · Reply all · Forward pills that open an inline reply.
> - **Compose:** Gmail's floating window bottom right (minimise, full screen, close),
>   From / To (Cc Bcc) / Subject rows, borderless body, lime **Send**, **Help me write**
>   (AI draft, `--ai-bg`), trash. Full screen on phones; a full page without JS.
> - **Snackbar:** bottom left, inverse colours, actions in `--snack-action` (Undo, View).
> - **One lime per area** still holds: Compose in the sidebar, Send in compose.

Status: approved direction for the redesign · Scope: `app/web/templates/*`, `app/web/static/{style.css,app.js}`, new `app/web/static/prefs.js` · Backend: none required (3 optional one-liners in §12).

Inputs merged here: the Wise design language (`docs/design/DESIGN-wise.md`), Apple Liquid Glass (WWDC25 219/356, HIG Materials), Apple fluid-motion rules and the eight principles, the 20 UX laws, the research and audit run on the real situation (4 accounts, 325 emails, 313 unsorted). Where an earlier note in this repo conflicts with this file, follow this file.

---

## 1. The three rules everything else follows

1. **Two layers.** *Content* (cards, columns, the detail body, rules lists, banners) is **Wise**: solid white cards on a sage canvas, 24px radius, no borders, surface contrast is the elevation. *Controls that float above content* (toolbar capsule, menus, shortcut sheet, toast, phone dock, sticky bars inside the detail pane) are **Liquid Glass**. Glass never goes on a card, column, or anything repeated in a list. Glass never sits on glass.
2. **One lime per area.** `#9fe870` is only ever a **fill** with `#0e0f0c` text: toolbar → *Sync now*; detail pane → *Open in Gmail*; rules page → *Add rule*; empty board → *Sync now*. Lime is never text, never a border or focus ring, never a success colour, never on a green surface (`--pale`, positive).
3. **The matrix is the product.** First screen = what to do now. Unsorted mail is a one-line progress strip, never a wall of cards. Every action responds on pointer-down, can be undone where the backend allows, and works without JS (POST-redirect-GET).

---

## 2. Tokens (paste into the top of `style.css`)

```css
:root {
  color-scheme: light dark;
  /* surfaces (Wise) */
  --bg: #e8ebe6;            /* page canvas = Wise canvas-soft (sage) */
  --surface: #ffffff;       /* cards, pane, strip, rule lists = Wise canvas */
  --surface-2: #f4f6f2;     /* hover/pressed fill inside a card */
  --fill: #e8ebe6;          /* secondary button, Move track, ai-box, category chip */
  --fill-press: #dde1da;
  --inverse-bg: #0e0f0c;  --inverse-text: #ffffff;   /* selected chips, Do-now header, "N new" pill */
  /* text */
  --text: #0e0f0c;          /* Wise ink */
  --text-2: #454745;        /* Wise body — ALL secondary text */
  --placeholder: #5c5f5a;
  --mute: #868685;          /* NON-TEXT only: icons, disabled, chevrons */
  --line: rgb(14 15 12 / .10);  --line-strong: rgb(14 15 12 / .24);
  --focus: #0e0f0c;
  /* brand + semantic (Wise) */
  --lime: #9fe870; --lime-hover: #cdffad; --lime-press: #c5edab; --on-lime: #0e0f0c;
  --pale: #e2f6d5; --on-pale: #054d28;             /* badge-positive: done / success */
  --warning-bg: #fff4c2; --on-warning: #4a3b1c; --warning-glyph: #b86700;
  --negative-bg: #fbe9e9; --on-negative: #a72027; --negative: #d03238;
  /* quadrant identity = filled glyph circle (non-text); the label carries meaning */
  --q-do: #d03238;       --q-do-on: #ffffff;
  --q-schedule: #38c8ff; --q-schedule-on: #0e0f0c;
  --q-quick: #ffd11a;    --q-quick-on: #0e0f0c;
  --q-later: #868685;    --q-later-on: #ffffff;
  /* elevation (content layer: almost none) */
  --shadow-hover: 0 6px 20px -10px rgb(14 15 12 / .28);
  --shadow-pane: 0 2px 6px rgb(14 15 12 / .06), 0 24px 48px -20px rgb(14 15 12 / .30);
  /* glass (control layer) — alphas chosen for worst-case legibility, see §3 */
  --glass-tint: rgb(255 255 255 / .72);
  --glass-tint-thick: rgb(255 255 255 / .86);
  --glass-solid: #f7f8f6;
  --glass-field: rgb(255 255 255 / .80);           /* search field on glass */
  --glass-fill: rgb(14 15 12 / .06);  --glass-fill-hover: rgb(14 15 12 / .10);
  --glass-selected: #ffffff;                        /* selected segment */
  --glass-text: #0e0f0c;                            /* text on glass is ALWAYS full strength */
  --glass-edge: rgb(14 15 12 / .10);  --rim-hi: .95;
  --glass-shadow: 0 1px 2px rgb(14 15 12 / .06), 0 10px 28px -10px rgb(14 15 12 / .28);
  --glass-shadow-lg: 0 2px 6px rgb(14 15 12 / .08), 0 28px 56px -16px rgb(14 15 12 / .36);
  /* type */
  --font: -apple-system, BlinkMacSystemFont, system-ui, Inter, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  /* space (4px base, Wise) */
  --s-0: 2px; --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px; --s-6: 24px; --s-8: 32px; --s-12: 48px;
  /* radius (Wise; concentric rule in §6) */
  --r-sm: 8px; --r-md: 12px; --r-lg: 16px; --r-xl: 24px; --r-pill: 999px;
  /* sizes */
  --tap: 44px; --control: 36px; --bar-h: 52px; --dock-h: 60px; --gutter: 32px;
  /* motion (no spring lib: critically damped approximation) */
  --ease-out: cubic-bezier(0.32, 0.72, 0, 1);
  --ease-press: cubic-bezier(0.2, 0.8, 0.2, 1);
  --d-press: 100ms; --d-release: 160ms; --d-fast: 150ms; --d-menu: 220ms; --d-menu-out: 160ms;
  --d-toast: 280ms; --d-toast-out: 200ms; --d-pane: 300ms; --d-sheet: 360ms; --d-sheet-out: 280ms;
  --d-progress: 400ms;
}
@media (pointer: coarse) { :root { --control: 44px; --bar-h: 60px; } }
@media (max-width: 1279px) { :root { --gutter: 24px; } }
@media (max-width: 767px)  { :root { --gutter: 16px; } }

/* Dark: Wise polarity flip, built from ink #0e0f0c and ink-deep #163300 */
@media (prefers-color-scheme: dark) { :root {
  --bg: #0e0f0c; --surface: #1a1c18; --surface-2: #22251f; --fill: #23271f; --fill-press: #2c3027;
  --inverse-bg: #e8ebe6; --inverse-text: #0e0f0c;
  --text: #e8ebe6; --text-2: #b9bdb5; --placeholder: #9a9e96; --mute: #868685;
  --line: rgb(232 235 230 / .10); --line-strong: rgb(232 235 230 / .22); --focus: #e8ebe6;
  --pale: #163300; --on-pale: #e2f6d5;
  --warning-bg: #2e2608; --on-warning: #ffe58a; --warning-glyph: #ffd11a;
  --negative-bg: #320707; --on-negative: #ffb3b6;
  --shadow-hover: 0 6px 20px -10px rgb(0 0 0 / .6);
  --shadow-pane: 0 0 0 1px rgb(232 235 230 / .06), 0 24px 48px -20px rgb(0 0 0 / .7);
  --glass-tint: rgb(30 32 28 / .80); --glass-tint-thick: rgb(30 32 28 / .88); --glass-solid: #1f211d;
  --glass-field: rgb(14 15 12 / .55); --glass-fill: rgb(232 235 230 / .08); --glass-fill-hover: rgb(232 235 230 / .12);
  --glass-selected: #343830; --glass-text: #e8ebe6; --glass-edge: rgb(255 255 255 / .10); --rim-hi: .40;
  --glass-shadow: 0 1px 2px rgb(0 0 0 / .4), 0 12px 32px -10px rgb(0 0 0 / .7);
  --glass-shadow-lg: 0 2px 6px rgb(0 0 0 / .5), 0 32px 64px -16px rgb(0 0 0 / .8);
} }

/* Increased contrast (Safari supports this; on macOS it also implies Reduce Transparency) */
@media (prefers-contrast: more) {
  :root { --text-2: var(--text); --placeholder: var(--text-2); --line: rgb(14 15 12 / .5); --line-strong: #0e0f0c; --mute: #454745; }
  .card, .chip-link, .sorting, .banner, .pane, .rules, .empty-col { outline: 1px solid var(--line-strong); outline-offset: -1px; }
  .btn-primary { box-shadow: inset 0 0 0 1.5px #0e0f0c; }
}
@media (prefers-contrast: more) and (prefers-color-scheme: dark) {
  :root { --line: rgb(232 235 230 / .5); --line-strong: #e8ebe6; --mute: #b9bdb5; }
}
```
Lime, quadrant fills and `--on-lime` are identical in light and dark (ink on lime = 13.05:1 both ways). Account colours from `accounts.yaml` are used only as 8px dots next to the account name.

---

## 3. Contrast (WCAG 2.2, computed; every text pair used in this spec)

| Pair | Ratio | Use |
|---|---|---|
| `#0e0f0c` on `#ffffff` / on `#e8ebe6` | 19.23 / 15.98 | all primary text on cards / canvas |
| `#454745` on `#ffffff` / `#e8ebe6` / `#f4f6f2` | 9.37 / 7.79 / 8.62 | secondary text, card meta, chips, hints |
| `#5c5f5a` on `#ffffff` / `#e8ebe6` | 6.48 / 5.39 | placeholders |
| `#868685` on `#ffffff` / `#e8ebe6` | 3.64 / 3.03 | **non-text only** (icons, chevrons) — never text |
| `#0e0f0c` on lime / lime-hover / lime-press | 13.05 / 16.94 / 14.72 | primary CTA, all states |
| `#ffffff` on `#0e0f0c` | 19.23 | inverse: selected chip, Do-now header (light) |
| `#054d28` on `#e2f6d5` | 8.76 | done / success badge (light) |
| `#4a3b1c` on `#fff4c2` | 9.81 | warning banner, "due soon" chip (light) |
| `#a72027` on `#fbe9e9` / on `#ffffff` | 6.23 / 7.29 | error banner, "overdue" chip, Remove (light) |
| Quadrant glyphs: white on `#d03238`, ink on `#38c8ff`, ink on `#ffd11a`, white on `#868685` | 5.01 / 9.95 / 13.17 / 3.64 | glyphs (non-text ≥3:1) |
| Dark: `#e8ebe6` on `#0e0f0c` / `#1a1c18` / `#23271f` / `#343830` | 15.98 / 14.27 / 12.64 / 9.95 | primary text, selected segment |
| Dark: `#b9bdb5` on `#1a1c18` / `#0e0f0c` / `#23271f` | 9.00 / 10.08 / 7.97 | secondary text |
| Dark: `#9a9e96` on `#1a1c18` | 6.30 | placeholders |
| Dark: `#0e0f0c` on `#e8ebe6` | 15.98 | inverse (selected chip, Do-now header) |
| Dark: `#e2f6d5` on `#163300` · `#ffe58a` on `#2e2608` · `#ffb3b6` on `#320707` | 12.19 · 12.05 · 10.59 | success · warning · error |
| **Glass worst case** (light, tint .72 over an ink block): ink text | 10.12 | toolbar text when Do-now header scrolls under |
| **Glass worst case** (dark, tint .80 over the light Do-now header): `#e8ebe6` | 7.60 | same, dark |
| Search field on glass (`--glass-field`), placeholder | ≥ 5.7 | field is near-opaque on purpose |

Rules: no grey text on glass (`--glass-text` only; selection on glass is shown by a raised pill, not by dimming the others). `--mute` never carries words. Colour is never the only signal: quadrants also have a glyph and a label, unread also has weight, errors also have an icon and text.

---

## 4. Typography

System font first (SF Pro on the user's Mac, Text/Display optical sizes switch automatically in Safari; no font files, works offline). `font-synthesis-weight: none`. Weights used: **400, 600, 700, 900** only. Sizes in `rem` so Safari text zoom scales the layout. Counts and times: `font-variant-numeric: tabular-nums`. Headings `text-wrap: balance`, paragraphs `text-wrap: pretty`.

| Role | Size / line-height | Weight | Tracking | Where |
|---|---|---|---|---|
| Hero (Wise display moment) | 2.5rem/1.0 (phone 1.875rem) | 900 | -0.03em | "3 to do now", "All caught up" — one per page, never on glass |
| Title | 1.5rem/1.25 (phone 1.25rem) | 700 | -0.02em | page h1, detail subject, "12 emails match" |
| Column title | 1.25rem/1.2 | 700 | -0.01em | "Do now", "Schedule"… |
| Body | 1rem/1.5 | 400 | 0 | email body, inputs (always ≥16px: no iOS zoom), buttons 600 |
| Card | 0.9375rem/1.35 | 600 sender / 400 subject (unread 700/600) | 0 | cards, list rows |
| Small | 0.875rem/1.43 | 400 / 600 | 0 | summaries, chips, hints, toolbar labels (600 on glass = vibrancy) |
| Caption | 0.75rem/1.33 | 400 (600 in the dock) | +0.01em | card account/time, dock labels, kbd hints (never smaller) |

---

## 5. Layout

Breakpoints (Wise): **phone < 768px**, **tablet 768–1279px**, **desktop ≥ 1280px**. Page side gutter `--gutter` 16 / 24 / 32px (+ `env(safe-area-inset-left/right)`); the toolbar capsule uses the same inset. Content max-width 1600px, centred. `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`; heights use `dvh`.

```
DESKTOP ≥1280 (no email open)
  ╭─[▣ Inbox]─[Matrix|List]─[⌕ Search mail ……………… /]────────────(⋯)─[⟳ Sync now]─╮  glass capsule, sticky, 12px from top
  ╰────────────────────────────────────────────────────────────────────────────╯
  [Unread] [All accounts] [● Shcube08 54] [● shubhamiiitdwd 12] [● Cubeshinde 3] [● Velocity Growth 9]  [Category ▾]
  3 to do now                                  12 unread · 4 accounts · updated 2 min ago ⌄
  ⚠ Velocity Growth can't sign in — the password was rejected.  How to fix ›   [Retry sync]
  ⏳ Sorting your mail   12 of 325 ▓▓░░░░░░░░   313 waiting · needs ≈16 of 50 AI calls left today    [Review ⌄]
  ┌■ Do now   3 new · 12┐ ┌● Schedule  5 · 20┐ ┌● Quick reply 2 · 9┐ ┌● Later    40 ⌄┐   1.25fr 1fr 1fr .85fr
  │ card ×8             │ │ card ×8          │ │ card ×8           │ │ (collapsed)   │   then "Show 4 more"
DESKTOP with email open: matrix becomes 2×2 (Do|Schedule / Quick|Later, cap 6 each) + pane clamp(400px,36vw,560px), sticky.
TABLET: matrix 2×2 (cap 6 each); email opens as a right sheet min(480px, 100% − 48px) over the board, no scrim.
PHONE <768
  ╭[Matrix|List]      (⌕)(⋯)[⟳]╮   glass capsule; ⌕ expands to a full-width field on focus (CSS only)
  [Unread][All][● Shcube08 54][● shubh…  →   one row, scrolls sideways, edge fade
  3 to do now
  12 unread · updated 2 min ago ⌄
  [⏳ Sorting · 12 of 325 ▓░░  ›]
  ■ Do now  3 new · 12   → cards (cap 6) → Schedule → Quick reply → Later
  ╭ ■ 3 Do now │ ● 5 Schedule │ ● 2 Quick │ ● 40 Later ╮  glass dock, floating, hides on scroll-down
  Email opens as a full-screen sheet from the right; dock hidden while it is open.
```
Board order (all sizes; serial position): toolbar → filter row → hero + status line → account banners → sorting strip → matrix. Filter row is **not** sticky. Only the toolbar capsule is sticky (NN/g: keep sticky chrome small). Sticky chrome on phone = 68px.

---

## 6. Liquid Glass material (Safari-safe)

Fallback ladder: solid → frosted (all browsers). No SVG refraction (`url()` in `backdrop-filter` renders *nothing* in Safari), no `-apple-visual-effect`, no noise, no ambient canvas glow (Wise canvas stays flat; colour lives in content).

```css
/* A) .glass — direct material. Toast, menus, shortcut sheet, phone dock, pane bars.
      Safe to animate opacity (the blur is on the element itself). Has no glass descendants. */
.glass { position: relative; background: var(--glass-solid); color: var(--glass-text);
  box-shadow: 0 0 0 .5px var(--glass-edge), var(--glass-shadow); }
.glass.thick { box-shadow: 0 0 0 .5px var(--glass-edge), var(--glass-shadow-lg); }
/* B) .glass-host — toolbar capsule only. Material lives on ::before so the capsule is NOT a
      backdrop root and the (⋯) menu inside it can blur the page. Never animate its opacity. */
.glass-host { position: relative; isolation: isolate; color: var(--glass-text);
  box-shadow: 0 0 0 .5px var(--glass-edge), var(--glass-shadow); }
.glass-host::before { content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit;
  background: var(--glass-solid); pointer-events: none; }
@supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  .glass, .glass-host::before { background: var(--glass-tint);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%); }   /* prefixed LAST, literal values, never var() */
  .glass.thick { background: var(--glass-tint-thick);
    backdrop-filter: blur(28px) saturate(170%);
    -webkit-backdrop-filter: blur(28px) saturate(170%); }
}
/* specular rim, light from top-left (both variants) */
.glass::after, .glass-host::after { content: ""; position: absolute; inset: 0; border-radius: inherit;
  padding: 1px; pointer-events: none;
  background: linear-gradient(160deg, rgb(255 255 255 / var(--rim-hi)), rgb(255 255 255 / .25) 28%,
    rgb(255 255 255 / 0) 55%, rgb(255 255 255 / .22));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); mask-composite: exclude; }
/* solid mode: Chromium's reduced-transparency, increased contrast, or the manual switch (Safari has no
   prefers-reduced-transparency, so the switch in (⋯) is the only way there) */
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
  .glass, .glass.thick, .glass-host::before { background: var(--glass-solid); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .glass::after, .glass-host::after { display: none; }
}
:root[data-glass="off"] .glass, :root[data-glass="off"] .glass.thick,
:root[data-glass="off"] .glass-host::before { background: var(--glass-solid);
  backdrop-filter: none; -webkit-backdrop-filter: none; }   /* :is() cannot hold pseudo-elements */
:root[data-glass="off"] :is(.glass, .glass-host)::after { display: none; }
@media (prefers-contrast: more) { .glass, .glass-host { box-shadow: 0 0 0 1.5px var(--text); } }
```
Rules:
- **Budget: ≤ 3 glass surfaces visible** — toolbar + (pane bar *or* phone dock) + one transient (menu *or* toast). The "N newly sorted" pill is a solid inverse pill, not glass.
- **Backdrop roots:** never put `opacity<1`, `filter`, `mask`, `clip-path`, `backdrop-filter` or `will-change` on any ancestor of the toolbar, dock, toast or menus (includes `body`, `main`, `#content` — no "loading" fades on them). The toast `#flash` is a sibling of the header, not inside it. Never animate `blur()`.
- **Thickness ladder:** toolbar/dock/pane bars = regular (blur 20, tint .72/.80); menus, shortcut sheet, toast = `.thick` (blur 28, tint .86/.88, deeper shadow). Bigger surface → thicker.
- **Scroll edge, not dividers:** remove every `border-bottom` on chrome. `.top::after` (behind the capsule, full width, from `var(--bg)` at the top to transparent 16px below the capsule) fades in (opacity, 200ms) when `.top.is-scrolled` (scrollY > 4). Without JS it stays off.
- **iOS 26 Safari tinting:** `html, body { background: var(--bg) }` explicitly; the full-width sticky `.top` wrapper is transparent (glass only on the inset capsule); the dock is inset 12px from every edge. Keep `<meta name="theme-color">` (light `#e8ebe6`, dark `#0e0f0c`) for macOS Safari ≤ 18.
- **Fills on glass** are translucent ink (`--glass-fill`), except the search field (`--glass-field`, near-opaque for legibility). Lime *Sync now* is a solid fill on the glass.
- **Concentric corners:** inner radius = max(outer − padding, 8px). Capsule (pill) holds pill controls (always concentric). Menus r24 / padding 8 → items r16. Pane r24 / ai-box r16. Cards r24; chips inside cards are pills.

---

## 7. Motion

**Springs (v3).** Motion uses Apple's damping/response spring model. In CSS, `--spring` is a critically damped spring (damping 1, no overshoot) sampled into `linear()`; it settles in `--d-spring` (560ms, response 0.4s) or `--d-spring-fast` (400ms, response 0.28s). In `app.js`, `spring()` integrates the same physics per frame, so the drawer, the phone email view and the compose sheet start from wherever they are, keep their velocity when reversed, and take the finger's speed on release (`projection()` = Apple's deceleration, `rubberband()` past edges). `drag()` follows a finger along one axis after 10px of slack, so taps and vertical scrolling still win.

| Gesture / transition | Behaviour | Reduced motion |
|---|---|---|
| Phone drawer | spring slide from the left, scrim follows; drag it (or the scrim) left to close, released by projected position | 150ms fade |
| Tablet drawer | grows out of the rail (clip-path driven by the same spring) | appears |
| Phone email | iOS push: slides in from the right, list drifts 28% left beneath; Back or a swipe right anywhere on the email slides it out | fade |
| Desktop email | rises 12px + fades in; closing eases the list back in | fade |
| Compose window | rises from the bottom right, leaves the same way; minimise/maximise morph (View Transition) | fade |
| Phone compose | sheet up from the bottom; drag the title bar down to put it away (draft kept) | fade |
| Inline reply, Cc/Bcc, Help me write | ease in 8px / 4px | appear |
| Disclosures (Categories, panels, quoted text, Sent rows) | height spring open and closed, interruptible | instant |
| Inbox tab underline | glides to the new tab (cross-document View Transition) | crossfade off |
| Phone Compose button | tucks into an icon while scrolling down, back on scroll up (Gmail) | instant |
| Rows | highlight on press (after 70ms on touch so scrolling never flashes) | same |

The table below is the earlier baseline; where it differs, the rows above win.

Approximate Apple's critically damped springs with `--ease-out` (fast start, no overshoot). Motion animates **transform and opacity only**; colour/shadow state changes are instant or ≤150ms linear. Use **CSS transitions** (not keyframes) for state changes so a reversal starts from the current value (interruptible); entry states via `@starting-style` (Safari 17.5+; older Safari simply appears without animation). **Paths are symmetric:** everything exits the way it came, using the same curve (a mirrored ease-in would delay visible response >80ms). Nothing bounces.

| Interaction | What moves | In | Out | Reduced motion |
|---|---|---|---|---|
| Press (buttons, chips, segments, dock items) | `scale(.97)` on `:active` | 100ms `--ease-press` | 160ms | no scale; background → `--fill-press` / `--glass-fill-hover` |
| Card press | `scale(.985)` | 100ms | 160ms | none (focus/selection ring only) |
| Menu / shortcut sheet | opacity 0→1 + `scale(.96)`→1, `transform-origin` = trigger corner | 220ms `--ease-out` | 160ms same path | opacity 150ms |
| Toast | `translateY(12px)`+opacity → 0/1 (rises from the bottom edge) | 280ms | 200ms back down | opacity 150ms |
| Desktop pane | `translateX(16px)`+opacity | 300ms | 220ms to the right | opacity 150ms |
| Pane content swap (next email) | opacity .4→1 | 150ms | — | same |
| Tablet/phone sheet | `translateX(100%)`→0 from the right | 360ms | 280ms to the right | opacity 150ms |
| Optimistic move: leaving card | opacity →.35, `scale(.98)` | 150ms | — | opacity only |
| Card lands in new column | View Transition (`view-transition-name` on that one card) | 300ms `--ease-out` | — | off |
| Matrix/List/filter navigation | cross-document View Transition (Safari 18.2+) crossfade | 200ms | — | off (`@view-transition` only under `no-preference`) |
| Progress bar | `transform: scaleX(var(--p))`, origin left | 400ms | — | instant |
| Sync icon | rotate 360°, linear, infinite | 1000ms | — | static icon + "Syncing…" text |
| Sync indeterminate line (capsule bottom edge) | 30%-wide bar `translateX(-100%→330%)` | 1200ms ease-in-out infinite | — | static 2px line at 40% |
| Scroll-edge fade | opacity | 200ms linear | 200ms | same |
| Phone dock hide/show on scroll | `translateY(calc(100% + 24px))` | 250ms | 250ms | instant |
| Done check (inbox zero, toast icon) | `scale(.6)`+opacity → 1 | 250ms | — | static |

`@media (prefers-reduced-motion: reduce)` replaces the old blanket `* { transition:none }` with the column above. No looping animation except the sync indicator while a sync actually runs. `scroll-behavior: smooth` only under `no-preference`.

---

## 8. Components

### 8.1 Toolbar (`header.top > .bar.glass-host`)
- Capsule: `border-radius: var(--r-pill)`, height `--bar-h`, padding 8px, gap 8px; inset 12px from the top (8px phone) and the page gutter. Groups (Apple toolbar grouping; never mix text and icon buttons on one shared background): **[brand]** · **[Matrix|List]** · **[search]** · **[⋯]** · **[Sync now]**. Rightmost = the lime CTA (serial position, Fitts corner).
- Brand: inbox glyph in a 32px ink circle + "Inbox" (Small 700). Hidden on phone. Links to `/`.
- **Segmented Matrix|List:** track `--glass-fill`, r pill, 2 segments `min-width 72px`, height `--control`; current = `--glass-selected` raised pill (`0 1px 2px rgb(14 15 12/.12)`), all labels `--glass-text` 600. Plain links with `aria-current="page"` (no JS needed). On `/rules` and `/message/…` neither is current.
- **Search:** desktop `flex: 1 1 320px; max-width: 480px`; `--glass-field`, r pill, height `--control`, 16px text, search glyph left, `<kbd>/</kbd>` hint right (`hover:hover` only). Placeholder "Search sender, subject, text". `enterkeyhint="search"`, `autocapitalize="off"`, `spellcheck="false"`. `Esc` clears and blurs (JS). Phone: rendered as a 44px circle; the transparent input covers the glyph; `.search:focus-within` expands it (`position:absolute; inset: 8px`) over the other capsule items — CSS only, works without JS; an active query shows as a dot on the circle. Any "has a query" selector must target the query field, `.search:has(input[type="search"]:not(:placeholder-shown))`: the form also holds hidden filter inputs, which have no placeholder and would always match.
- **(⋯) More** = `<details class="menu-wrap">` with a 44px circular summary (`aria-label="More"`), menu `.glass.thick`, r24, padding 8, `min-width: 260px`, `width: max-content` (one line per label, capped at the screen), opens down-right-aligned (`transform-origin: top right`). Phone: the ⋯ button sits left of Sync, so a right-anchored menu ran off the left edge — there the menu spans the capsule (`left:0; right:0` of `.bar`), still growing from the ⋯ button. Items (r16, 44px rows): **Sender rules** (link), **Keyboard shortcuts ?** (`<button popovertarget="keys">`, only on `hover:hover`), divider, then three `role="switch"` toggles that JS un-hides (`hidden` without JS): **Compact rows**, **Solid surfaces (less transparency)**, **Open next email after an action** (default on). JS: light-dismiss on outside click/Esc, close after choosing.
- **Sync now** (see 8.2). Phone: icon-only 44px lime circle, `aria-label="Sync now"`.

### 8.2 Sync button state machine (no backend change)
| State | Visual | Behaviour |
|---|---|---|
| idle | lime pill, ⟳ + "Sync now" (16px 600), `title="Fetch new mail and sort it now"` | press → `syncing` at pointer-down |
| syncing | label "Syncing…", icon spins, `disabled`, `aria-busy="true"`, indeterminate line on the capsule's bottom edge | POST `/sync` (JSON). Poll `/api/stats` every 3s → update sorting strip, dock counts, tab badge. Board stays usable. |
| done (2s) | ✓ + "Up to date" (still lime) | success toast with the server message ("Sync done: 12 new emails, 20 sorted") → `idle` |
| error | back to idle look | error toast `role="alert"`: server message + **Retry** (resubmits) + ✕; stays until closed |
| busy elsewhere (HTTP 409) | idle | status toast "A sync is already running — numbers update by themselves" (not an error) |
No-JS: plain POST, PRG flash. Keep `data-busy` and the `#i-sync` icon. Optional later (not this pass): run sync in a thread and report stages.

### 8.3 Filter row (`#filterbar`, only on Matrix/List)
- One row: `display:flex; flex-wrap:nowrap; overflow-x:auto; scroll-snap-type:x proximity; scrollbar-width:none`, edge fade via `mask-image` + `-webkit-mask-image` linear-gradient (16px each side, only when overflowing — JS toggles `.fade-l/.fade-r`; without JS both ends fade).
- Chips (`.chip-link`, links): height 36px (44 coarse), padding 0 14px, r pill, `--surface` bg, `--text` 14px 600; account chips: 8px colour dot + label + unread count (`aria-label="54 unread"`, tabular, `--text-2`). **Selected = inverse** (`--inverse-bg/--inverse-text`), dot keeps its colour. Order: **Unread** (toggle link `f.url(unread='' if f.unread else '1')`, first — most used), **All accounts**, accounts…, then **Category** `<select>` styled as a chip (`appearance:none`, data-URI chevron, 16px font on touch so iOS does not zoom, 14px 600 on fine pointers to match the chips, visible label "Category" via `aria-label` and a leading glyph). Hover (fine pointers): `--surface-2`.
- The search form keeps hidden inputs for `view`, `account`, `unread`, `category` so searching never drops filters.
- **Active-filter summary** (when `f.active`): one line under the row: "Showing **Unread** ✕ · **Shcube08** ✕ · **“invoice”** ✕ — 12 emails · Clear filters". Each ✕ is a link `f.url(x='')` with `aria-label="Remove filter Unread"`. Keep the exact text "Clear filters".

### 8.4 Board head: hero + status line (`.board-head`, inside `#content`)
- Left: `<h1 class="hero">` — no filters: "**3 to do now**" (`stats.unread_do`; same number as the tab badge); 0 → "**Nothing to do now**", but while emails still wait for the AI (`stats.unscored`) → "**Nothing to do yet**" (honest status; JS keeps it in step with the tab badge). Filters active → Title style "12 emails match". List view → Title "All email by priority".
- Right (phone: below): **status line** = `<details class="status-wrap">` whose summary reads "12 unread · 4 accounts · updated 2 min ago" (most recent `synced_ago`; template: `accounts|selectattr('last_synced_at')|sort(attribute='last_synced_at')|last`) + chevron; if any account has `last_error`, append "· 1 problem" with a `--warning-glyph` triangle. Opens a `.glass.thick` menu (r24, 320px) anchored under it: `id="status"`, a `<ul>` of rows `● <b>Label</b> synced 3 min ago` (error rows: class `acct-status err`, triangle, full error text in `--on-negative`), then `AI calls today: 2 / 50` with the plain explanation "Each call sorts up to 20 emails." **Keep test strings** (§12).

### 8.5 Account problem banner (`.banner.warn`, one per failing account, above the sorting strip)
Wise warning family: `--warning-bg`, `--on-warning` text, triangle glyph, r24, padding 12px 16px, body 14px. One short line, the fix one click away (Tesler; on a phone the old two-sentence banner took a quarter of the first screen): "**Velocity Growth** can't sign in — the password was rejected." + **How to fix** (`<details>`: the step, the `set-password` command as a copyable block, the raw error). Copy says what to do: login-type errors (`login|auth|credential|password` in the message) → "**Velocity Growth** can't sign in — the password was rejected. Update its app password in `.env` / `accounts.yaml`, then retry." Other errors → "**Velocity Growth** didn't sync: ⟨first 120 chars⟩." Actions: **Retry sync** (secondary button, `POST /sync`), **Details** (`<details>` with the full error, monospace). No lime.

### 8.6 Sorting strip (replaces the 313-card "Not sorted yet" block)
- `<section class="sorting" data-col="unsorted">` placed **above** the matrix, only when `unsorted.total`. Inside: `<details data-key="unsorted-v2">` **closed by default** (new key so a remembered "open" from the old block doesn't apply). White card, r24, padding 12px 16px (phone: one 52px row).
- Summary row: hourglass glyph in a dashed-outline circle · "**Sorting your mail**" (Small 700) · "12 of 325 sorted" (tabular) · meter (`role="progressbar" aria-valuemin=0 aria-valuemax=325 aria-valuenow=12 aria-valuetext="12 of 325 sorted"`; 8px pill track `--fill`, fill `--text` scaled by `--p` set inline) · "313 waiting" · **Review** chevron. Progress is global (`stats.total − stats.unscored`).
- Second line (Small, `--text-2`): "Needs ≈16 AI calls · 50 left today" (`needed = ceil(unscored / 20)`, the classifier batch size; `left = ai_max − ai_calls`). If `needed > left`: a `--warning-bg` pill: "Today's AI limit covers about ⟨left×20⟩ more. The rest sorts after midnight UTC — or sort any email yourself with 1–4." If `left == 0`: "Daily AI limit reached. Sender rules still work."
- Expanded body: (a) **Top senders waiting** (≤5, computed in the template from the ≤100 fetched unsorted cards with `groupby('from_email')` + a `namespace` list sorted by count; labelled "among the newest 100"), each row: sender · count · **Important** / **Low** secondary buttons = `POST /rules` (`kind=vip|low`, `pattern=<email>`), works without JS. (b) the newest **12** unsorted as compact rows (`unsorted.cards[:12]`, so the DOM stays small). (c) "See all 313 in List →" (`f.url(view='list', sorted='no')` with B1; without B1 → `f.url(view='list')`).
- When `unscored` reaches 0 during a session (JS polling): strip removed on next refresh + toast "All 325 emails sorted" (completion). AI-calls jargon (OpenRouter) never appears in the UI.

### 8.7 Quadrant columns (`section.col.q-{key}` > `details[data-key]`)
- No column background or border (cards on canvas = Wise). Header = `<summary class="col-head">`, min-height 56px, padding 12px 16px, r24: glyph circle 28px (`--q-*` fill, `--q-*-on` glyph: **do = alert-circle, schedule = calendar, quick = bolt, later = moon, unsorted = hourglass in dashed outline**) · title **Do now / Schedule / Quick reply / Later** (Column title) with subtitle "Urgent + important / Important / Urgent / Neither" (Small, `--text-2`, no caps, no colour) · count "**3 new** · 12" (`aria-label="3 unread of 12"`; total only if B2 absent) · chevron (`--mute`, rotates 90° on open, 150ms).
- **Do now is featured** (Von Restorff, Wise polarity flip): its header uses `--inverse-bg/--inverse-text`; its column is the widest on desktop. Dark mode: no light slab (it outshone the lime CTA and glared in a dark room) — a raised warm-dark header `#2a2420` with a 1.5px `--q-do` ring and `--text`.
- Default open: Do now, Schedule, Quick reply; Later collapsed (exact attribute strings in §12). JS remembers per column (`col:<key>`).
- Cards per column: first 8 (desktop 4-col) / 6 (2×2, phone) visible; the rest (already fetched, ≤100) inside `<details class="more-cards"><summary>Show 34 more</summary>…` (tertiary text button, 44px). If `total > fetched`: "Showing 100 of 412 · See all in List →". Never a dead end.
- `id="col-do"` etc. on sections for the phone dock; `scroll-margin-top: calc(var(--bar-h) + 24px)`.

### 8.8 Email card (`_macros.card`)
```
┌────────────────────────────────────────────┐  white, r24, padding 14px 16px, gap 4px, no border
│ ● Shcube08 · 📎                      10:42 │  Caption, --text-2; account dot 8px; time tabular
│ ● Priya Sharma                              │  unread: 8px ink dot + sender 700 / read: no dot, 600
│ Contract needs signature today             │  subject 2 lines max (unread 600 / read 400)
│ Boss needs the contract signed today.      │  AI summary (or snippet) 2 lines, Small, --text-2
│ [due today] [client]                       │  ≤2 chips: due (soon/late colours) + category (--fill)
└────────────────────────────────────────────┘
```
- The whole card is one link (`.card-link`, opens in pane). Accessible name order = sender, subject, summary; `<span class="sr-only">Unread: </span>` stays.
- **Removed from cards:** the per-card "why?" `<details>` (the reason is in the pane), the "action" chip, the score chip (List view keeps a quadrant chip: glyph + "Do now" on `--fill`; the score is its `title`). "Not sorted" chip in List = dashed outline + hourglass.
- States: **unread** (dot + weights); **read** (no dot, lighter weights, same colours — never greyed below `--text-2`); **hover** (fine pointer only) `--shadow-hover`, no movement; **pressed** `scale(.985)`; **focus-visible** `outline: 3px solid var(--focus); outline-offset: 2px` (follows the radius); **selected/open** (`.active`) `box-shadow: inset 0 0 0 2px var(--text)`; **keyboard cursor** = focus on its link (same ring); **leaving** (optimistic move) opacity .35. `content-visibility: auto; contain-intrinsic-size: auto 120px` (compact: 44px).
- **Compact density** (`:root[data-density="compact"]`): one 44px row, r12: unread dot · sender (28%, ellipsis) · subject (ellipsis) · due chip · time. Read rows keep a 16px gutter where the dot would be (names line up, Mail-style). In a column narrower than 460px (container query on `.col`: 4-column board, pane open, phone) the row becomes two lines: sender + time over subject (+ due chip).
- **List view on wide screens** (≥ 1024px, comfortable density): two-line mail rows, r16 — sender / account · subject / summary · chips · time — instead of 1300px-wide cards that put the time far from its email and fit 4 per screen. Summary and chips hidden. Unsorted preview rows always use this form.
- Card attributes for JS: `data-id`, `data-imp`, `data-urg`, `data-read` (after `data-id`).

### 8.9 Empty, done and zero states
- **Column empty** (`.empty-col`): r24, 1.5px dashed `--line-strong`, padding 24px, centred Small `--text-2` + glyph. Do now: "Nothing urgent. You're clear." on `--pale` / `--on-pale` with a check (it is a success) — **only when nothing is waiting for the AI**; otherwise a plain dashed block with the hourglass: "Nothing here yet — 313 still being sorted". Schedule "Nothing to plan." Quick reply "No quick replies waiting." Later "Nothing parked here."
- **All caught up** (filter is exactly Unread, no results): `--pale` card, r24, padding 48px, hero "All caught up" (`--on-pale`), "0 unread across 4 accounts · checked 2 min ago", secondary (white) button "Show read mail". No lime on this green surface.
- **Nothing matches** (other filters): keep heading "Nothing matches", list each active filter as a removable chip, plus "Clear filters".
- **No email yet**: keep heading; "Press Sync now to fetch mail from your accounts." + lime **Sync now** (the only CTA there: the toolbar's Sync turns neutral `btn-secondary on-glass` while this state shows).
- Session moments (JS, once each, `sessionStorage` in try/catch): Do-now unread drops to 0 → toast "Do now is clear ✓"; sorting finishes → toast. Calm, no confetti.

### 8.10 Detail pane / sheet (`aside#pane` > `article.detail`)
- **Desktop:** solid `--surface`, r24, `--shadow-pane`, no border, no scrim, `position: sticky; top: calc(12px + var(--bar-h) + 12px); overflow:auto`; `max-height: calc(100dvh − var(--chrome) − var(--filter-h) − 36px)` — at rest the pane starts below the filter row (`--filter-h`, measured by JS, CSS estimate as fallback), so it must fit from there. A sticky gradient cap (`.pane .detail::before`, `--pane-bg`) hides the email in the 8px gap above the floating bar. **Tablet:** fixed right sheet, same material, full height minus 12px insets, no scrim (parallel task). **Phone:** fixed `inset:0`, background `--bg`, `padding-bottom: env(safe-area-inset-bottom)`, `body:has(.with-pane)` stops page scroll.
- **Top bar** `.detail-bar.glass`, sticky top 0 inside the pane, r pill (desktop: 8px inset), height 52/60: **Close** 44px circle (`title="Close (Esc)"`; phone: "‹ Inbox" text button 44px) · **↑ / ↓** previous/next email icon buttons (`aria-keyshortcuts="k"/"j"`, `hidden` until JS) · spacer · **Mark read / Mark unread** (secondary; exact labels kept) · **Open in Gmail ↗** (lime — the pane's single primary; omitted for non-Gmail accounts).
- Body (padding 24, phone 16): subject (Title) → headers `<dl>` (Small; From / To / Date / Account / Files) → **AI box** (`--fill` = Wise card-feature-sage, r16, padding 16): quadrant chip with glyph + action name ("Do now", not "Urgent + important") · meters "Important ●●●●○ · Urgent ●●●●●" (text alternative "Importance 4 of 5") · chips (category, due) · summary (Body 600) · why line: "Why: ⟨reason⟩ · scored by Gemma" — when `scored_by == 'user'` and no reason: "Why: You moved it here. · scored by you" → **Move to** (8.11) directly under the summary (proximity). Then the email text (Body, `white-space: pre-wrap`, `max-width: 68ch`, autoescaped) → **Fine-tune** panel → **Rules for this sender** panel. Panels are `<details>`, summary 44px, Small 600, separated by 24px space (no rules lines).
- Fine-tune: Importance / Urgency `<select>` 1–5 and Category input (16px, 44px tall, r12, 1px `--line-strong`, Wise text-input; custom chevron), **Save** secondary. Hint unchanged.
- Rules for this sender: "Apply to" select (sender / whole domain), buttons (secondary): "Always important (VIP)", "Always low priority", "Private — never send to AI". Active rules render as chips "Always important (VIP) · boss@corp.com" each with a ✕ form (`POST /rules/{id}/delete`, `aria-label="Remove rule …"`). Hint: "Rules also sort mail that's still waiting. Manage them on the Rules page."
- Phone: the Move control moves to a sticky **bottom bar** `.glass` (r pill, inset 12px + safe area) as 1×4 icon-over-label segments (52px tall).
- Phone bar: ↑/↓ hidden (j/k is a keyboard feature; Back and the Move bar cover it); bar items never shrink (`flex: none`), so the lime Gmail circle stays 44px down to 320px. The phone sheet is modal: the page behind it is `inert` while it is open.
- Focus: opening via keyboard (and any open on a phone) focuses the subject (`tabindex="-1"`); closing returns focus to the card link — if that card is gone, to the first card in view, never `<body>`. `Esc` closes. Browser Back closes (existing `popstate`).

### 8.11 Move-to control (`form.moves`)
A **2×2 mini-matrix** in the pane (natural mapping to the board: Do now | Schedule / Quick reply | Later), `role="group" aria-label="Move to"`. Track `--fill`, r24, padding 4, gap 4; each `<button class="move q-{key}" name="move" value="{key}">` is 44px tall, r20, glyph circle 18px + label Small 600 + `<kbd>1–4</kbd>` hint on fine pointers; `title="Do now (1)"`, `aria-keyshortcuts="1"`. Current = `--surface` raised pill (`0 1px 3px rgb(14 15 12/.14)`; dark `--glass-selected`), `aria-pressed="true"`, class `current`. Others transparent; hover `--fill-press`. No filled quadrant colours, no lime. Press gives instant pressed state; the server round trip follows (optimistic, 8.13).

### 8.12 Toasts (`#flash`, `aria-live="polite"`)
- `.flash.glass.thick`, fixed, centred, `bottom: max(24px, env(safe-area-inset-bottom) + 12px)` (phone with dock: `+ var(--dock-h) + 12px`), max-width `min(520px, 100% − 32px)`, r24, padding 12px 16px, Small 600 `--glass-text`. Anatomy: status glyph (success: `--pale` circle + `--on-pale` check; error: `--negative` circle + white "!") · message · action buttons (`--glass-fill`, 36px, 44px hit, ink text: **Undo** / **Retry** / **Open**) · ✕ on errors.
- One at a time (a new toast replaces the old with a crossfade). Success 6s, with Undo 8s; timers pause on `:hover` / `:focus-within`; errors stay until closed. Errors get `role="alert"`, success `role="status"`. Keep classes `flash ok` / `flash err`. Server flashes (no-JS) render the same box without actions.
- Copy is specific: "Moved to Schedule", "Marked as read", "Rule saved: Always low priority for @linkedin.com", "Rule removed", "Sync done: 12 new emails, 20 sorted". First three mouse-driven moves add "Tip: press 2 next time" (localStorage counter).

### 8.13 Undo (only where the existing endpoints can re-apply the previous value)
| Action | Undo (no backend change) | Notes |
|---|---|---|
| Mark read / unread | `POST /message/{id}/read` with the previous `is_read` | exact inverse |
| Move to / Fine-tune Save on a **scored** email | `POST /message/{id}/score` with previous importance, urgency, category (from `data-imp/-urg/-cat` on `.detail` / card) | adds a corrective feedback row; scored_by becomes "you" — acceptable; B-later could delete the row |
| Move on an **unsorted** email | no Undo (backend can't restore "unsorted"); toast action **Open** reopens that email so it can be moved again | Postel: recoverable, not reversible |
| Add rule | find the new rule's ✕ form after refresh (`[data-kind][data-pattern]`) and submit it | rules page `li` and pane chips carry `data-kind`, `data-pattern` |
| Remove rule | `POST /rules` with the removed `kind` + `pattern` (read from the `li` before removal) | no confirm dialog |
`z` undoes the most recent of a 5-item in-memory stack (works after the toast is gone). Undo itself shows "Undone" (no further undo).

**Optimistic move flow:** press → segment shows pressed + `current` immediately, the board card gets `.leaving` → compute `nextId` (next visible card after the active one: same column first, then the following columns in reading order) → POST → on success open `nextId` in the pane (if auto-advance on; else keep this email) and `refresh()` the board inside `document.startViewTransition` (if supported and motion allowed) → toast. On failure: revert `current`/`.leaving`, error toast with Retry. If nothing is left: close the pane and let the empty/done state show.

### 8.14 Keyboard
| Keys | Action |
|---|---|
| `j` / `k` | next / previous email (visible cards in DOM order; skips closed `<details>`), focus its link, `scrollIntoView({block:'nearest'})`; if the pane is open, open it there |
| `Enter` / `o` | open the focused email · `Esc` closes (order: menu → sheet popover → search → pane) |
| `1` `2` `3` `4` | Move to Do now / Schedule / Quick reply / Later (open email, else the focused card) |
| `e` | mark read and open the next email · `Shift+U` mark unread · `Shift+I` mark read |
| `z` | undo last action |
| `/` | focus search · `g` then `m` / `l` / `r` (within 1s) → Matrix / List / Rules |
| `?` | open the shortcut sheet |
Guards: ignore when `metaKey/ctrlKey/altKey` (never shadow Safari ⌘ keys), `isComposing`, focus in `input/textarea/select/[contenteditable]`, or a menu/sheet open (except `Esc`/`?`). Forms are triggered with `form.requestSubmit(button)` (Safari 16+) so the existing `data-enhance` path is reused. **Shortcut sheet** `<div id="keys" popover class="sheet glass thick">` (no-JS open/close/Esc in Safari 17+), fixed `top: calc(12px + var(--bar-h) + 8px); right: var(--gutter)` (reset the UA popover `inset:auto; margin:0`), 360px, r24, `transform-origin: top right`; three groups (Navigate / Triage / Go to) using `<kbd>` (r8, 1px `--line-strong`, mono 12px), plus the switch **Single-key shortcuts** (WCAG 2.1.4, stored in localStorage). Hints appear in `title`s and `aria-keyshortcuts` on Move, Mark read, Close, Search. Safari note: its Tab key skips links by default, so `j/k` is the main keyboard path there.

### 8.15 Phone dock (`nav.dock.glass`, `aria-label="Quadrants"`, Matrix view, < 768px)
Fixed, `left/right: calc(12px + safe-area)`, `bottom: max(12px, env(safe-area-inset-bottom))`, r pill, padding 4, 4 equal anchors (`href="#col-do"` …, plain links, work without JS), each ≥ 52×44: glyph circle 20px + count (Small 700, tabular; unread with B2, else total) over label (Caption 600: "Do now", "Schedule", "Quick", "Later"). Current section gets the `--glass-selected` pill and `aria-current="location"`: the last section whose top has passed a reading line 30% down the screen (at the page end: the last section in view); a tapped item is current at once and holds while the jump scrolls. (An IntersectionObserver band picked the column above the tapped one and nothing at load.) Hides on scroll-down (> 6px, y > 120) and shows on scroll-up, like Safari's own bars; hidden while the email sheet is open. `main { padding-bottom: calc(var(--dock-h) + 24px + env(safe-area-inset-bottom)) }`.

### 8.16 "N newly sorted" pill
While polling, if the sorted count rises, never swap content under the reader. Show a solid inverse pill, fixed and centred, below the filter row at rest (`top: calc(var(--chrome) + var(--filter-h) + 12px)`, so it never covers a chip) and `top: calc(12px + var(--bar-h) + 12px)` once the page scrolls. When sorting finishes, the board refreshes instead (the strip goes away), then the completion toast: "18 newly sorted · Show" (button → `refresh()`). Disappears after use or on manual refresh.

### 8.17 Rules page (`/rules`)
No filter row. "‹ Inbox" text link (44px) above the title. h1 "Sender rules" (Title). Intro (Body, `--text-2`, ≤ 68ch): "Rules run before the AI, cost nothing, and also sort mail that's still waiting. Use a full address (boss@company.com) or a whole domain (@company.com)." **Add-rule card** (white, r24, padding 24): rule kind as a 3-option radio segmented control (`fieldset`, `name="kind"`: Always important (VIP) · Always low priority · Private — never send to AI; default VIP), "Sender or domain" input (16px, 48px, r12, 1px ink border = Wise text-input, `inputmode="email" autocapitalize="off" spellcheck="false"`, placeholder "boss@company.com or @bank.com"), **Add rule** lime. Inline error (server flash) below the input. Three groups: header = glyph (VIP: do-glyph circle; Low: later-glyph circle; Private: lock in a `--fill` circle) + label (Column title) + count chip + one-line help; list = white card r24, rows ≥ 56px: pattern (600, `overflow-wrap:anywhere`) · "3 emails · added 2026-10-01" (Small `--text-2`) · **Remove** (secondary, `--on-negative` text) → toast with Undo. Empty group: "None yet." in a dashed empty block.

### 8.18 Message page and error page
`/message/{id}`: same detail component in a centred white card (max-width 760px, r24) with "‹ Inbox" in its bar. Error page: centred white card, Title = status, Body = detail, secondary "Back to the inbox". Both use the token CSS; no glass besides the toolbar.

---

## 9. JavaScript (vanilla, CSP-safe; everything optional on top of working forms)
`static/prefs.js` (new, ~12 lines, loaded **without** `defer` in `<head>` before the stylesheet paints): read `pref:density`, `pref:glass`, `pref:advance`, `pref:keys` from localStorage (try/catch) and set `data-density` / `data-glass` on `<html>` so there is no flash. `static/app.js` additions:
1. `document.addEventListener('touchstart', () => {}, {passive:true})` so iOS shows `:active`.
2. One passive, rAF-throttled scroll handler: `.top.is-scrolled`, dock hide/show.
3. `refresh()`: replace only `#filterbar` and `#content`; skip the swap if the HTML is unchanged; keep pane scroll, focus (by `data-id`/id) and column open state; run inside a View Transition when allowed.
4. Pane open/close with enter/exit classes (wait for `transitionend` or 300ms before removing content); ↑/↓ buttons; auto-advance; focus management.
5. Optimistic move, toast with actions, undo stack, keyboard layer, menu light-dismiss + exit animation, `?` sheet, pref switches.
6. Polling `/api/stats`: every 3s while syncing; every 15s while `unscored > 0` and `document.visibilityState === 'visible'`; else 120s. Updates the tab badge `(N) `, strip text and `--p`, dock counts, "N newly sorted" pill, completion toasts.
7. Card links stay real links: modifier-clicks open new tabs as today.

---

## 10. Accessibility checklist
- Selected states (Matrix/List, dock, Move, rule-kind radio, current menu item) add an ink hairline `inset 0 0 0 1.5px var(--text)`: the white-pill-on-track difference alone is ~1.2:1 (WCAG 1.4.11 needs 3:1). Switch off-state ring `1.5px var(--mute)`.
- The shortcut sheet is `role="dialog"`: focus moves to its Close button on open and returns to the invoker (or the ⋯ button) on close. Decorative `<svg class="ic">` get `aria-hidden="true"`.
- Targets: every interactive element ≥ 44×44 on coarse pointers (visual 36px on fine pointers with ≥ 44px hit area via padding/`::before`); ≥ 8px between adjacent targets.
- Focus: `:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px }` everywhere, incl. on lime (ink ring on canvas/glass ≥ 15:1). Never remove outlines; `forced-colors: active` uses system colours (outlines survive).
- Landmarks: `header` (toolbar), `nav[aria-label=Accounts]`, `main`, `aside[aria-label="Selected email"]`, `nav[aria-label=Quadrants]`. Columns `section[aria-labelledby]`. One `h1` per page (hero or page title).
- Live regions: `#flash` polite (exists at page load); errors `role="alert"`; progressbar has `aria-valuetext`; counts have `aria-label`s; `aria-busy` on Sync; `aria-pressed` on Move; `aria-current` on views/dock; switches use `role="switch" aria-checked`.
- Inputs 16px (no iOS zoom), visible or `aria-label` labels, `<noscript>` Apply button kept for the category select.
- Motion, transparency and contrast modes per §2, §6, §7. Email content stays autoescaped plain text.

---

## 11. Files touched
`base.html` (head metas, prefs.js, toolbar, ⋯ menu, shortcut sheet, `#flash`, dock; status strip moves out), `index.html` (board head, banners, sorting strip, columns, empty states), `_macros.html` (card, more), `_detail.html` (bar, AI box, 2×2 Move, panels, rule chips with ✕), `rules.html`, `message.html`, `error.html`, `_icons.html` (+ alert-circle, calendar, bolt, moon, hourglass, check, more, keyboard, lock, star, chevron-down, arrow-up, arrow-down, alert-triangle, undo), `style.css` (rewrite on these tokens), `app.js`, new `prefs.js`.

## 12. Backend changes and test compatibility
**Required (found in review):** `Referrer-Policy: same-origin`, not `no-referrer` — under `no-referrer` browsers (Chromium and WebKit) send `Origin: null` with plain form posts, which the cross-site guard rightly rejects, so every no-JS form got 403.
Also done in review (small, `main.py`): a rejected "Add rule" on `/rules` redirects to `/rules?pattern=…&kind=…` so the typed text survives without JS; the Category menu lists only categories that still have mail under the other filters.
Optional, each a few lines in `app/web/main.py`, each with a template fallback:
- **B1** `sorted=no` filter: `Filters.unsorted` from `params.get("sorted") == "no"`, included in `active` and `url()`, `where()` adds `(m.importance IS NULL OR m.urgency IS NULL)`. Enables "See all 313 in List".
- **B2** per-quadrant unread: `_counts` adds `quadrant_unread`; `_matrix` passes `unread` per column. Enables "3 new · 12" and dock unread counts.
- **B0** copy: `add_rule` message "It applies to new mail." → "It also sorts mail that's still waiting." (true: `classify_pending` applies rules first).
- **B3** (from the browser tests): a new rule sorts that sender's waiting mail at once (`_sort_waiting`: Low and Private; VIP mail still goes to the AI, so its message says "at the next sync"), and a sender with a rule leaves "Sort whole senders at once". A mangled link (`/message/abc`) gets the friendly error page. A plain form posted after the session ended goes to sign in and back, not to a page of JSON. Log out no longer sends `Clear-Site-Data` (it wiped Settings too); drafts still go when the login page loads.

Must survive the restyle (asserted by `tests/test_web.py`): `<section … data-col="{key}">` for `unsorted|do|schedule|quick|later|list` containing the cards, **no nested `<section>`** inside them; exact `<details open data-key="do">` and `<details data-key="later">` (no other attributes on column `details`); `class="card unread active" data-id="…"` (new classes/attrs only after `data-id`); `class="layout with-pane"` (no extra classes); `href="/?view=list" data-close`; `class="chip due soon"`; `class="flash err"`; `aria-label="Has attachments"`; inline `--c: #d93025`; the `(N) ` title prefix; texts "Open in Gmail", "Mark unread", "Nothing matches", "No email yet", "Clear filters", "Rule saved", "Rule removed", "Moved to “Do now”", "1 email ", "scored by Gemma/you/a rule", "Always important (VIP) · boss@corp.com". The `id="status"` element must contain, **before its first `</div>`**, `<b>{label}</b>`, "synced just now", `class="acct-status err"`, the error text and `AI calls today: N / M` — so the status menu body uses `ul/li/span/p`, no inner `div`. Run `python -m pytest -q`.

---

## 13. Laws → decisions
| # Law (skill numbering) | Decision |
|---|---|
| 1 Hick | Toolbar = 5 groups; Rules, shortcuts and display prefs behind (⋯); filter row hidden off-board; one action per Move cell |
| 2 Fitts (size) | 44px targets on touch; Move cells 44px; dock segments 52px; no 17px "why?" links |
| 3 Jakob | Mail conventions: unread dot + bold, search at top, Gmail keys (j/k/e/z//, ⇧U/⇧I, g-chords), auto-advance, iOS-style bottom dock and back button |
| 4 Proximity | Move-to sits under the AI summary; status details under the status line; banners next to Retry |
| 5 Miller | Columns capped at 6–8 cards + "Show N more"; status chunked into one line; shortcut sheet in 3 groups |
| 6 Doherty | Pointer-down press in 100ms; optimistic move; polling numbers update in place; spinner + progress |
| 7 Von Restorff | One lime per area; Do-now header polarity-flipped and widest |
| 8 Fitts (nearby) | Actions in the pane bar next to the email; phone Move bar at the thumb; Sync in the capsule's corner |
| 9 Serial position | Matrix first, unsorted reduced to a strip; Do now first/top-left; Sync last in the toolbar |
| 10 Peak-end | "Do now is clear ✓", "All caught up" card, "All 325 emails sorted" toast |
| 11 Zeigarnik | "313 waiting" stays visible as an open loop with progress; "3 new" per column |
| 12 Prägnanz | No column boxes, no borders, no per-card why/score chips; one card anatomy |
| 13 Sensible defaults | Later collapsed; strip collapsed; auto-advance on; VIP preselected; single-key shortcuts on with an off switch |
| 14 Postel (prevent) | Search keeps filters; rule input accepts `bank.com`/`@bank.com`/any case; 16px inputs; warning before the AI budget runs out |
| 15 Postel (recover) | Undo toasts + `z`; Retry on errors; "Open" for unsorted moves; banners say how to fix; filters removable one by one |
| 16 Similarity | One meaning per colour (red = urgent/error only with a glyph, lime = primary only, green = success); action names everywhere |
| 17 Uniform connectedness | 2×2 Move control mirrors the matrix; toolbar groups in capsules; pane = one card |
| 18 Parkinson | Keys 1–4, `e`, auto-advance, bulk "Important/Low" per top sender, no confirm dialogs |
| 19 Tesler | AI budget, per-account sync and scores revealed on demand (status menu, Fine-tune); jargon removed |
| 20 Goal-gradient | "12 of 325 sorted" meter; queue shrinks visibly with auto-advance; "3 new" counts fall |

Apple principles: **Purpose** — matrix first, nothing decorative. **Agency** — undo over confirm, prefs switches, keyboard and mouse paths. **Responsibility** — undo restores AI training data where possible; private rules stay; honest AI-budget copy. **Familiarity** — Mail/Gmail patterns. **Flexibility** — 3 layouts, density, solid-surface switch, motion/contrast modes. **Simplicity** — fewer controls, one primary each. **Craft** — tokenised type/space/radius, tabular numbers, concentric corners, Safari-specific glass. **Delight** — calm completion moments, material that responds on press.

## 14. Browser tests (`e2e/`, Playwright)
Every test runs on a desktop (1440×900), a phone (iPhone 14, touch) and a tablet (iPad, touch) against `e2e/server.py` (made-up mail, a pretend mail server and AI). Run `npx playwright test`; see the README. They hold the rules above in place: 44px touch targets on coarse pointers (§10), the open menu is modal on every page (§9), Reduce Motion fades instead of sliding but every gesture still works (§7), focus never falls to `<body>` after a window, snackbar or menu closes, one `h1` per page even with an email open, forced colours keep switches and segments readable, and nothing scrolls sideways at 320px or with 200% text.

## 15. Verify in real Safari (not testable in the sandbox's Chromium)
`-webkit-backdrop-filter` renders on macOS Sonoma Safari 18 (literal values); the (⋯) menu inside the capsule blurs the page; `@starting-style` entries; `mask-composite` rim; Tab vs Option-Tab and VoiceOver on cards; `content-visibility` on cards; iPhone: `:active` with the touchstart listener, dock vs Safari 26's own bottom bar, toolbar tint, safe areas. Note: headless Chromium screenshots show blur ≥ 16px on short bars as unblurred — check the glass look on menus or in Safari, do not lower the blur.
