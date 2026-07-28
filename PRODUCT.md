# Product

## Register

product

## Platform

web

## Users

One user: the owner, a self-directed retail investor in Australia. He checks it from a Mac at his desk and from his phone on the same Wi-Fi (installed to the home screen). The job to be done: find candidates worth researching across a wide market, judge whether a setup is strong, and know *when* to act — without reading 1,500 charts by hand. He is not a professional trader and has no Bloomberg terminal; this is his instrument.

## Product Purpose

PaperTrail scans ~1,552 US-listed stocks (S&P 1500 + ADRs + momentum names) and the top 50 crypto every 60 seconds, then does three things a screener usually doesn't: rates each name 1–5 on transparent sub-scores (trend, momentum, quality, value, risk, real analyst consensus), computes a concrete **entry plan** with real price levels and a stated reason, and runs a simulated autopilot that trades its own signals so the system accumulates an honest track record.

Success is the user making better-informed decisions with less time, and being able to answer *"are these signals actually any good?"* from evidence.

## Positioning

A screener that shows its work: every rating decomposes into inputs you can inspect, every entry names a price and a reason, and the system paper-trades its own advice so its hit rate is visible before real money is ever involved.

## Brand Personality

Precise, unsentimental, fast. It reads like a working instrument rather than a product demo, in the voice of a terminal that respects the user's time and never oversells. Numbers are tabular and scannable; claims are hedged exactly as much as the evidence warrants and no more. It states limitations plainly ("delayed ~15 min", "not a forecast", "SIMULATED · FAKE MONEY") because credibility is the whole product. No hype, no celebration of wins, no manufactured urgency.

## Anti-references

Not a consumer fintech app (Robinhood confetti, gamified green candy, "you're crushing it" tone). Not a SaaS dashboard (hero-metric card with a gradient accent, identical rounded card grids, purple-blue gradients). Not a crypto-bro terminal (neon, glow-for-glow's-sake, moon language). Not a Bloomberg pastiche either: density is earned by information rather than performed as costume.

## Design Principles

**Show the work, not the verdict.** A rating with no visible inputs can't be checked or debugged. Every score decomposes; every entry states its reason and price level.

**State uncertainty at full volume.** Confidence labels, "not advice" disclosures, and the simulated banner are working UI, not legal boilerplate to be minimized. Real money follows this screen.

**Density is a feature, decoration is not.** The user scans hundreds of rows. Tabular numerals, mono data, tight rhythm. Anything that doesn't help him decide gets cut.

**One accent, spent deliberately.** Amber is the instrument's signal color and marks what matters. Green/red appear only where finance requires them (up/down). Adding more colors would dilute what each one signals.

**Answer "so what do I do?"** A number that leads to neither an action nor a reason to wait has no place on the screen. Every surface should push toward a decision or say plainly that there isn't one yet.

## Accessibility & Inclusion

WCAG AA as the working target: body text ≥4.5:1, keyboard focus visible (amber `:focus-visible` ring), and `prefers-reduced-motion` respected (ticker tape and pulse animation disable). No specific personal accommodations required. Given the domain, up/down state should not rest on hue alone — signed numbers, arrows and position carry the meaning too.
