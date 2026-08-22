# Context Fence — Design System

The complete design language of the Context Fence dashboard: tokens, the
liquid-glass material, surfaces, motion, charts, dark mode, and the
conventions every page follows.

Sources of truth:

| File | Role |
|---|---|
| `frontend/src/styles.css` | Global design tokens + shared component classes |
| `frontend/src/components/Layout.tsx` | App shell, liquid-glass sidebar |
| `frontend/src/components/Toasts.tsx` + `.cf-glass-toast` block | Liquid-glass toasts |
| Each page's co-located `<style>` block | Page-scoped styling (`db-`, `au-`, …) |

---

## 1. Philosophy

Two ideas coexist deliberately:

1. **InsightHub (ui-2.0)** — the current generation, a premium light-SaaS
   editorial look: warm gray app background, white 26px-radius cards,
   hairline borders instead of heavy shadows, oversized light-weight KPI
   numerals, an orange → teal → white color rhythm across card rows, ambient
   radial glows behind content, and count-up numbers that roll rather than
   snap.
2. **Liquid glass** — the material layer. True translucency is reserved for
   things that *float above* the page (sidebar, toasts, login card, chart
   tooltips): they blur whatever is behind them and carry a specular top
   edge. Regular content cards are opaque white/dark surfaces — glass is not
   applied everywhere, which is what keeps it special.

Status by surface (as of the ui-2.0 branch):

| Generation | Pages |
|---|---|
| ui-2.0 (current) | Dashboard, Agents, AgentDetail, Connectors (TestMCP), ConnectorDetailPage, AuditLog, Settings |
| Gen-1 glass (legacy, still themed correctly) | Firewall, Policies, Profile, Login (login is intentionally glassmorphism), modals |

---

## 2. Color system

### 2.1 Light theme (default, `:root` in styles.css)

Premium light SaaS surface — never pure-gray-flat; always slightly cool.

| Token | Value | Use |
|---|---|---|
| `--bg-app` / `--bg-content` | `#eef0f1` | Page background |
| `--bg-surface` | `#ffffff` | Cards, inputs |
| `--bg-surface-elevated` | `#ffffff` | Overlays |
| `--bg-surface-hover` | `rgba(17,17,17,.03)` | Hover wash on any row/link |
| `--bg-inset` | `#f2f3f4` | Wells: segmented controls, range toggles |
| `--border-default` | `rgba(17,17,17,.05)` | Hairlines inside cards |
| `--border-strong` | `rgba(17,17,17,.1)` | Table head rules, secondary buttons |
| `--text-primary` | `#111111` | Headings, values |
| `--text-secondary` | `#666666` | Body |
| `--text-muted` | `#999999` | Labels, captions, axis ticks |

Accents (semantic trio reused everywhere):

| Token | Value | Meaning |
|---|---|---|
| `--accent-coral` | `#ff3144` | Deny/blocked, active nav, primary CTA, danger |
| `--accent-teal` | `#397e70` | Allow/allowed, protected/connected, success |
| `--accent-amber` | `#de911d` | Log/logged, needs-auth, warnings |

Decision colors are **fixed vocabulary** across every chart, badge and table:
allow = teal, deny = coral, log = amber (gray `#9aa1a9` as the neutral
series).

### 2.2 Dark theme ("Dark 2.0")

Deep blue-black surfaces with a **neon accent shift** — accents don't just
invert brightness, they change hue, and active elements get glow shadows so
they read as *lit*, not merely colored:

| Token | Light | Dark |
|---|---|---|
| `--bg-app` | `#eef0f1` | `#0a0d13` |
| `--bg-surface` | `#ffffff` | `#10151d` (cards `rgba(16,21,29,.88)`) |
| `--accent-teal` | `#397e70` (muted pine) | `#2fe6b0` (neon mint) |
| `--accent-amber` | `#de911d` | `#ffb020` |
| `--accent-coral` | `#ff3144` | `#ff3144` (unchanged) |
| glow tokens | — | `--glow-red/teal/amber`: `0 0 26px rgba(...)` halos |

Dark-only conventions:

- Card shadow becomes `0 0 0 1px rgba(255,255,255,.02), 0 10px 36px rgba(0,0,0,.5)`
  — a faint outer ring plus deep lift.
- `.chart-card` gets a **dark outline border** (`rgba(0,0,0,.45)`) so panels read crisp.
- Metric-card top accent bars glow via `color-mix(in srgb, var(--accent) 42%, transparent)`.
- `.pattern-grid` hairlines switch from black-alpha to white-alpha.
- Big headings may take a faint white text-shadow halo.

### 2.3 Gradient treatments

Filled KPI cards use a subtle 160° two-stop gradient of their accent, plus a
large soft shadow of the same hue:

```css
.db-kpi-orange { background: linear-gradient(160deg, #ff5163, #ff3144);
                 box-shadow: 0 14px 34px rgba(255,49,68,.28); }
.db-kpi-teal   { background: linear-gradient(160deg, #43907f, #397e70); … }
```

In dark mode these deepen (`#ff4d5e→#e51f33`, `#17b28c→#e8a6d`) and swap the
soft shadow for the neon `--glow-*` token.

---

## 3. Theme architecture

Three-state theming (system / light / dark) implemented with one attribute
and one media query — no JS class swapping beyond setting `data-theme`:

```
:root                          → light values
:root[data-theme="dark"]       → manual dark override (wins over OS)
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { … } }  → OS dark
```

Rules:

- `data-theme="light"` simply leaves `:root` values in force; OS dark only
  applies when **no** attribute is set.
- Because there are two dark paths, **every dark-mode override must be
  written twice**: once under `:root[data-theme="dark"]` and once under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme]) … }`. This
  duplication is intentional and appears throughout the codebase (tokens,
  vibrancy rules, per-page blocks). Never write only one.
- Applied by `lib/theme.ts` → `applyTheme()` sets/removes `data-theme` on
  `<html>`; `'system'` removes the attribute entirely.
- Body transitions `background-color`/`color` over 400ms so theme switches
  fade instead of flash.

---

## 4. The liquid-glass material

Glass = translucent fill + backdrop blur/saturation + white hairline +
**inset specular top highlight** + deep drop shadow. The specular edge
(`inset 0 1px 0 rgba(255,255,255,…)` as the first box-shadow) is what makes
it read as physical glass rather than plain transparency.

### 4.1 The recipes

**Sidebar** (`Layout.tsx` `.lyt-sidebar`) — the flagship surface:

```css
position: fixed; inset-block: 16px; left: 16px;
background: var(--glass-bg);              /* light rgba(255,255,255,.65)
                                             dark  rgba(13,17,24,.72) */
backdrop-filter: blur(20px) saturate(180%);
border: 1px solid var(--card-border);
border-radius: 28px;
box-shadow:
  inset 0 1px 0 rgba(255, 255, 255, 0.35),   /* specular edge */
  0 10px 36px rgba(16, 24, 32, 0.1);         /* float shadow */
/* expanded state deepens the float: 0 18px 56px rgba(16,24,32,.16) */
```

**Toast** (`.cf-glass-toast` in styles.css):

```css
background: rgba(255, 255, 255, 0.62);
backdrop-filter: blur(28px) saturate(180%);
border: 1px solid rgba(255, 255, 255, 0.6);
box-shadow:
  inset 0 1px 0 rgba(255, 255, 255, 0.55),
  0 1px 2px rgba(16,24,32,.06),
  0 16px 40px rgba(16,24,32,.16);
/* dark: bg rgba(16,21,29,.72), border white .09, specular .08,
   deeper black drop */
```

**Login card** (`LoginPage.tsx` `.auth-card`): `rgba(255,255,255,.82)` +
`blur(28px)` + near-invisible border, floating over animated ambient radial
spots (`.auth-ambient-spot-*`, slow 30s-ish drift keyframes). Heavier fill
because it sits over a decorative gradient, not content.

**Legacy glass classes** (still used by gen-1 pages): `.glass`,
`.glass-panel` = `var(--glass-bg)` + `blur(30px)` + `var(--glass-border)`;
`.chart-tooltip` = same material at 16px radius. Modals use a scrim of
`rgba(0,0,0,.35–.5)` + `blur(4–6px)` behind a solid panel.

### 4.2 Where glass is allowed

| Surface | Material |
|---|---|
| Floating sidebar | blur 20px + saturate 180% |
| Toasts | blur 28px + saturate 180% |
| Login/auth card | blur 28px, heavier fill |
| Chart tooltip (`.chart-tooltip`) | blur 30px |
| Modal scrims | blur 4–6px, dim only |

Everything else (cards, tables, inputs, headers) stays **opaque**. If a new
floating element wants glass, copy the toast recipe — keep all four layers
(fill, blur+saturation, hairline, specular inset) or none of them.

### 4.3 Fallbacks

- `@media (prefers-reduced-transparency: reduce)` → sidebar falls back to
  opaque `var(--bg-surface)` and drops the backdrop filter. Apply the same
  fallback to any new glass surface.
- Always ship `-webkit-backdrop-filter` alongside `backdrop-filter`
  (Electron's Chromium honors the standard property, but the pairing is the
  convention).

---

## 5. Surfaces, radii, elevation

Radius scale (fully rounded pills are the default gesture for anything
interactive):

| Radius | Used by |
|---|---|
| `999px` / `9999px` | Buttons, nav links, badges, inputs, selects, chips, segmented controls' items |
| `26px` | ui-2.0 cards (`.db-card`, `.qc-card`, page cards) |
| `24px` | `.glass-panel`, auth inner panels |
| `22px` | `.glass-card`, `.stat-card`, `.chart-card` |
| `20px` | `.data-table-card`, toast |
| `16px` | Textareas, tooltips |
| `12px` / `11px` / `10px` / `8px` | Icon tiles, small buttons, range-toggle items |
| `28–32px` | Sidebar, auth card (hero-level surfaces) |

Elevation philosophy: **light mode barely uses shadows** — separation comes
from hairline borders on a tinted page. Shadows appear on hover, on colored
KPI cards (tinted with their own hue), and on floating glass. Dark mode
replaces borders with ring+deep-lift shadows.

Base card recipe (ui-2.0):

```css
.card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 28px;
  box-shadow: 0 1px 2px rgba(16,24,32,.04);
}
```

Hairline discipline: internal separators use `--border-default` (5% ink);
only structural rules (table heads, section dividers) use
`--border-strong` (10%). Nothing stronger than 12% alpha anywhere.

---

## 6. Typography

System stack only (no webfonts):
`-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`;
monospace spots use `'SF Mono', Menlo, monospace`.

Scale and voice:

| Style | Spec |
|---|---|
| Page heading (`.db-heading`) | 24px / 650 / -0.02em |
| Card title (`.db-h3`) | 21px / 550 / -0.015em |
| KPI label (on filled cards) | clamp(24px, 2vw, 29px) / **400** — big, airy words |
| KPI value | clamp(42px, 4.2vw, 52px) / **400** / -0.03em — the hero numeral |
| Legacy stat value (`.stat-value`) | 36px / 800 |
| Body / table cells | 13–15px / 500–600 |
| Micro-labels, th, captions | 10–11px / 700 / uppercase / letter-spacing .06em |

Editorial habits: sentence-case headings, muted subhead line under every
title (`.db-h3-sub`, 12.5px muted), tabular numerals
(`font-variant-numeric: tabular-nums`) wherever numbers align in columns,
negative tracking (-0.02em) on everything large.

---

## 7. Layout grammar (ui-2.0 page anatomy)

Every redesigned page follows the same vertical skeleton:

```
ambient-glow root (::before fixed radial gradients, pointer-events:none)
└─ z-index:1 content
   ├─ slim header        h1 + one-line subhead, action pill right-aligned
   ├─ status strip       live facts in a row (counts · pulse dot · stream state)
   ├─ toolbar            segmented controls / filters (optional)
   ├─ KPI band           orange → teal → white → large-white rhythm
   ├─ main split         e.g. 2fr table + 1fr charts column
   └─ footer bands       paired two-column cards
```

Canonical grids:

- Dashboard KPI row: `grid-template-columns: 1fr 1fr 1fr 2.2fr`, min-height
  480px; collapses 2-col ≤1180px, 1-col ≤720px.
- Bottom split: `2fr 1fr`; collapses to single column ≤1180px.
- Content container max-width **1404px**, centered; main content clears the
  collapsed rail with `margin-left: 104px` (the expanded sidebar overlays,
  it doesn't push).
- Gaps between cards: **18px** consistently; card padding **28px**.

The KPI rhythm (orange card, teal card, white card, big white chart card)
is the signature of the redesign — repeat it on Agents, AgentDetail,
Connectors, ConnectorDetailPage. When adding a band, keep exactly one
filled-orange, one filled-teal, rest white.

Ambient glow recipe (page root `::before`):

```css
content:''; position:fixed; inset:0; pointer-events:none; z-index:0;
background:
  radial-gradient(560px 420px at 10% 6%,  rgba(255,49,68,.06), transparent 65%),
  radial-gradient(680px 500px at 90% 92%, rgba(57,126,112,.07), transparent 65%);
/* dark: higher alphas (.14/.10) + optional third amber blob at 70% 20% */
```

---

## 8. Components

### Buttons

| Class | Look | Hover |
|---|---|---|
| `.btn-primary` / pill CTAs | coral fill, white text, 999px | scale(1.02) translateY(-1px) + hue shadow |
| `.btn-secondary` | transparent, 1px `--border-strong` | hover wash + same micro-lift |
| `.btn-ghost` | card-bg quiet pill; `.active` = coral fill | wash |
| Quiet utility (`.db-refresh`, export pills) | `--bg-inset` fill, 38px tall, 12.5px/650 text | darker inset |
| Black pill (`.db-pill`) | `#111` fill white text (dark mode inverts to `#f2f5f9`) | opacity .85, active scale .97 |

Spring timing on interactive elements:
`300ms cubic-bezier(.34, 1.56, .64, 1)` (overshoot). Utility hovers use plain
160ms ease.

### Segmented controls & chips

Inset track (`--bg-inset`, 3px padding, 10px radius) holding 8px-radius
items; active item = coral fill white text; inactive = muted text, hover =
wash. Decision filter pills and theme switcher both follow this. Status
chips (`.qc-state`) are dot + label with tinted backgrounds per state.

### Badges

Pill, 12px/600, accent-on-tint: `.badge-allow` teal on `rgba(0,166,153,.15)`,
`.badge-deny` coral on `rgba(255,90,95,.15)`, `.badge-log` amber on
`rgba(252,180,0,.15)`. Outlined variants (protect on/off) add a 1px
30%-alpha border of the same hue.

### Inputs

`.glass-input/-select/-textarea`: surface fill, hairline border, 999px
radius (inputs/selects) or 16px (textarea), focus = coral border +
`0 0 0 3px rgba(255,90,95,.15)` ring. Selects draw a custom inline-SVG
chevron. Placeholder = `--text-muted`.

### Tables

Two systems: legacy `.glass-table`/`.data-table` (global classes, zebra
striping via even-row wash) and the ui-2.0 editorial table (`.db-table`):
15px type, generous 15px row padding, uppercase 11px header, hairline row
rules fading out on last row. AuditLog adds Excel-style drag column
resizing (pointer events on colgroup widths) — kept behavior, restyled skin.

### Sidebar (Layout.tsx)

Floating liquid-glass rail: 76px collapsed ↔ 244px expanded (hover or pin).
Collapsed shows centered circular icon chips; expansion animates width at
260ms `cubic-bezier(.22,1,.36,1)` while labels fade/slide in (opacity 180ms
delayed 80ms + width 260ms). Active item: coral text on 8%-alpha coral wash
(expanded), and its icon chip lights with the coral gradient
`linear-gradient(150deg,#ff5163,#ff3144)` + inner specular + coral shadow.
The same chip morphs between states — nothing jumps. Avatar gradient is
teal (`linear-gradient(150deg,#397e70,#2c6156)`). Lenis smooth scrolling
(`lerp: 0.08`), skipped under reduced-motion.

### Toasts

Sonner `toast.custom` renders `.cf-glass-toast` (bottom-right, max 4, gap
10). Anatomy: 32px tinted icon tile (per-kind hue at ~12% bg) + bold 13px
title + 12px muted message + quiet close button. Loading toasts live until
dismissed and swap to success/error. API: `notify.{success,error,warn,info,
loading,dismiss}` — callable outside React (WS handler uses it).

### Tooltips

- Static chart tooltips: solid white (dark: `#161c26`) 12px-radius card,
  soft double shadow — deliberately NOT glass where legibility matters most
  (dashboard tooltips); the shared `.chart-tooltip` glass variant exists for
  gen-1 pages.
- `AnimatedTooltip` (connector binding avatars): Aceternity-style spring
  physics — tooltip tilts ±45° and drifts ±50px following cursor offset via
  `useSpring(useTransform(x))`, stiffness 260/damping 10 entrance from
  y:20/scale:.6, gradient hairlines above the name.

### Modals

Scrim `rgba(0,0,0,.35–.5)` + blur 4–6px; solid surface panel; spring/scale
entrance. `TestCallModal`, `AddMCPModal`, `AddAgentModal` share this shape.

---

## 9. Motion system

### Shared variants (copy-paste contract)

Every ui-2.0 page uses identical framer-motion stagger so cards land the
same everywhere:

```tsx
const containerVariants = { hidden: {},
  visible: { transition: { staggerChildren: 0.05 } } };
const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1,
             transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } } };
```

### Easing vocabulary

| Curve | Use |
|---|---|
| `cubic-bezier(0.22, 1, 0.36, 1)` | Entrances, width/size morphs (sidebar, labels) — fast start, long settle |
| `cubic-bezier(0.34, 1.56, 0.64, 1)` | Interactive overshoot: buttons, nav links, range toggles |
| plain `ease` 160–250ms | Hovers, color/background changes |

### Count-up numbers

`useCountUp(value, 900)` rAF hook, ease-out cubic; KPI figures roll from
previous value to new value instead of snapping. Paired with
`formatNumber()` (K/M compaction) and tabular-nums alignment.

### Charts animate, they don't restart

- Area series: `animationBegin={180} animationDuration={700} ease-out`.
- Period switches keep the chart mounted so the curve **morphs**; the
  remount `key` flips exactly once (empty → loaded) so only first landing
  replays the draw-in.
- Y-axis domain uses a stable function `yMax(max)=max(4, ceil(max*1.2))` —
  function identity prevents axis rebuild flicker.
- "Today" view starts at the first hour containing data (empty-canvas rule).

### Ambient/looping motion

Firewall shield breathes (scale/glow loop); login ambient spots drift
slowly; spinners rotate 900ms–1s linear. All decorative loops must respect
`prefers-reduced-motion` (Lenis already skips; framer sections gate via
variants).

---

## 10. Charts (recharts conventions)

- Palette: allow=teal, deny=coral, log=gray `#9aa1a9`, amber for needs-auth
  series; categorical extras `#c4cad0`.
- Area fills: vertical linearGradient, accent at 14–16% opacity → 0 at 95%;
  stroke 2–2.4px, `type="monotone"`, `dot={false}`,
  `activeDot={{r:4, strokeWidth:2, stroke:'#fff'}}`.
- Axes: no tick lines, no axis lines, 11px `#999999` ticks, dashed
  `4 4` cursor line.
- Doughnuts: `innerRadius 54/outerRadius 74`, `paddingAngle 3`,
  `strokeWidth 0`, center label absolutely positioned over the pie; legend
  rows = dot + name + right-aligned tabular value.
- Tooltip content is a custom component (see §8) — never the browser default.
- Dark mode: tooltips flip to `#161c26`, grids to white 5%.

---

## 11. Icons

Two libraries, strict split:

- **Phosphor** (`@phosphor-icons/react`) — app chrome: sidebar nav, always
  `weight="fill"` at 18px inside circular chips.
- **Lucide** (`lucide-react`) — in-page UI: actions, empty states, toast
  icons; stroke 1.75–2.2, sizes 9–16px.

Brand logos come from `lib/agentLogos.ts` (CDN map + inline SVG fallback);
suspended agents render desaturated via `.at-avatar-off`.

---

## 12. CSS organization

Global `styles.css` owns: tokens, `.glass*` family, `.data-table[-card]`,
buttons, badges, sidebar-link (legacy), stat cards, chart-card family,
toast styles, pattern-grid, focus rings, responsive tweaks. Tailwind v4 is
imported but used sparingly — the system is hand-rolled custom properties.

Page-scoped styling lives in a co-located `<style>{`…`}</style>` block at
the bottom of each component, namespaced by a stable prefix so blocks never
collide:

| Prefix | Owner |
|---|---|
| `lyt-` | Layout shell |
| `db-` | Dashboard |
| `ag-` | Agents / AgentDetail |
| `qc-`, `cdp-`, `cx-` | ConnectorCard, ConnectorDetailPage, ConnectorDetail |
| `au-` | AuditLog |
| `fw-` | Firewall |
| `auth-` | LoginPage |
| `at-` | AnimatedTooltip |
| `cf-glass-toast` | Toasts |
| `ob-`, `tcm-`, `mcp-`, `ad-`, etc. | Onboarding, TestCallModal, AddMCPModal, AddAgentModal |

Conventions inside a page block:

1. Root element + ambient glow first.
2. Layout, then components, then tooltips/modals.
3. Dark overrides at the end — **always duplicated** for
   `[data-theme="dark"]` and `prefers-color-scheme` (see §3).
4. One-line comments explaining *why* for non-obvious choices (UTC
   handling, key-flip tricks, chip sizing) — this is house style.

---

## 13. Accessibility

- Focus: `.focus-ring:focus-visible` → `0 0 0 3px rgba(255,90,95,.2)`; inputs get the same ring on focus.
- `prefers-reduced-motion`: Lenis disabled; `.motion-safe:animate-none`
  utility kills animations/transitions; storyboard and loops degrade.
- `prefers-reduced-transparency`: glass → opaque surface, no backdrop-filter.
- Contrast: body text `#666` on white passes AA; `#999` reserved for
  non-essential labels. Dark theme text is high-alpha white
  (`.68` secondary floor).
- Interactive cards are `role="button"` + keyboard activated
  (Enter/Space handlers in ConnectorCard et al.).

---

## 14. Checklist — new page or component

1. Root div gets prefix-X classes; add `::before` ambient glow if it's a full page.
2. Copy `containerVariants`/`cardVariants` verbatim; wrap bands in
   `<motion.section variants={containerVariants}>`.
3. Slim header: 24px/650 title + muted subhead + one quiet pill action.
4. Cards: `var(--card-bg)` / `--card-border` / 26px / 28px padding.
5. Colors only via tokens; decision data only in teal/coral/amber.
6. Numbers: `useCountUp` + `formatNumber` + `tabular-nums`.
7. Feedback via `notify.*` toasts — never alert() or inline "Saved".
8. Dark mode: duplicate every override under both selectors.
9. Floating element? Use the glass recipe (§4.1) complete with specular
   edge + transparency fallback.
10. Leave a why-comment anywhere the code would look wrong without context.
