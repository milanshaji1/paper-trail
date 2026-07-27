# Design

Captured from `public/styles.css`, so this describes what actually ships.

## Theme

Dark, committed. The scene: one person at a desk before the US open, or glancing at a phone in bed — scanning for anything that moved. A light UI would glare in both; the darkness matches the ambient condition of the use.

A warm violet-tinted ink rather than the generic cool blue-black, so amber sits on it as one temperature family instead of a foreign accent.

## Color

OKLCH-equivalent hexes as shipped. Restrained: tinted neutrals carry the surface, one accent under 10%.

| Token | Value | Role |
|---|---|---|
| `--ink` | `#0c0b0e` | body; warm near-black |
| `--ink-2` | `#100d13` | recessed wells, sidebar |
| `--surface` | `#16131b` | panels |
| `--surface-2` / `--surface-hi` | `#1b1723` / `#221d2b` | nested surfaces, hover |
| `--line` / `--line-soft` | `#2c2634` / `#211b28` | borders |
| `--text` | `#f3ede4` | warm paper-white body |
| `--text-dim` / `--text-faint` | `#a79d92` / `#6f665f` | secondary / tertiary |
| `--amber` | `#ffb23e` | **the signal color** — brand, active nav, focus ring, pulse trace, entry zones |
| `--up` / `--down` | `#4ec99a` / `#f0616d` | semantic only: price up / down |

Amber is the identity and marks what matters. Green/red are functional, never decorative: finance requires them and they appear nowhere else. This separation is the palette's core rule.

## Typography

Paired on a contrast axis: geometric-technical display against humanist-engineered body.

- **Display** — `Space Grotesk` (500/600/700): headings, tickers, big readouts. Technical character; suits an instrument.
- **Body** — `IBM Plex Sans` (400–700): UI prose, labels. Engineered heritage, chosen over Inter.
- **Data** — `IBM Plex Mono` (400–600): every number, eyebrow, table header, level chip. `font-variant-numeric: tabular-nums` throughout so columns align while ticking.

Mono eyebrows (10px, 0.22em tracking, amber) are a recurring structural device, used as section register marks rather than as a kicker above every heading.

## Layout

App shell: fixed `--sidebar-w: 232px` rail + `--topbar-h: 58px` sticky bar + `--tape-h: 34px` marquee. Content max-width 1520px.

Radii are deliberately tight (`--radius: 4px`, panels 6px), closer to an instrument than a friendly app. Grids use `repeat(auto-fit, minmax(…, 1fr))` for breakpoint-free response. Tables are dense by intent: 9px padding, mono, hairline row borders.

Responsive: 1150px → sidebar collapses to a 64px icon rail; 980px → columns stack; 720px → sidebar becomes an overlay drawer + scrim.

## Signature

The **oscilloscope hero**: an amber trace of the S&P's real path, drawn on load with a `stroke-dasharray` sweep, with the readout overlaid and a dashed baseline. Everything around it stays quiet, so this is where the boldness is spent.

## Motion

Sparse and functional. Tape marquee (60s linear, pauses on hover), connection dot pulse, the hero's one-time trace draw, 0.14s hover transitions, modal entrance. `@media (prefers-reduced-motion: reduce)` disables tape + pulse.

## Components

Panels, stat tiles (`.m-stat`), signal chips (`.sig`), conviction star rows, entry level chips (`.lvl`), score badges, segmented tabs, the bias gauge, skeleton shimmers. `.sim-badge` uses a dashed amber border, and the dash is semantic: it marks the paper-trading section as simulated.
