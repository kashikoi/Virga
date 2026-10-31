# Virga — agent context / project memory

Checked-in snapshot of working context for the Virga app. If you're an agent picking
this up in a new session, read this first.

## What this is
- A personal, local-first **inventory & side-hustle planner**, part of the kashikoi
  cloud-themed app suite (Cumulus, Nimbus, Cirrus, Stratus, Anvil, Arcus). Repo:
  github.com/kashikoi/Virga. Pages: https://kashikoi.github.io/Virga/ (served from `main` /).
- First use case: the owner's BMW 1M side-indicator eBay business (lens Clear/Smoked ×
  base Gloss black/Matte black/Chrome, sold as pairs, serials `1M-001`…). `indicatorTemplate()`
  seeds it; the app itself stays generic (any parts / products / options).
- Named after virga. Scenic background is an inline SVG of Monument Valley-style buttes under a
  charcoal storm deck with golden virga streaks (based on a user photo); Day is the default.
  The sagebrush ellipses and virga paths were generated once with a seeded script — edit in place.
- Plain vanilla HTML/CSS/JS, no build step, no backend.

## Architecture & conventions
- `app.js` is one IIFE; element refs cached in `el` via `cacheEls()`. Rendering is
  string-template `innerHTML` with `escapeHtml()` on every user string; clicks are handled by
  delegation on `#canvas` via `data-*` attributes (`data-nav`, `data-act`, `data-advance`,
  `data-adjust`, `data-edit-order`, `data-pact` for the products editor, ...).
- **Stock is never stored directly.** On hand = sum of `db.moves` deltas. Orders and purchases
  own their moves via `ref` (`order:<id>` / `po:<id>`) and are re-synced with
  `syncOrderMoves()` / `syncPurchaseMoves()` after any change (delete + recreate). Always go
  through `finalizeOrder()` after editing an order (serials, cogs snapshot, moves).
- `computeStock()` is the single source of stock math (memoized in `stockCache`; `save()`
  clears it). Committed = BOM of `open` non-historical orders. Usage rate = BOM of every
  non-cancelled order (including `historical`) sold within `lookbackDays`, over the observed
  span (min 30 days). Status: short / out / reorder / soon / waiting / ok.
- BOM per unit = `product.baseBom` + each selected choice's `bom` (`unitBom()`); × `order.qty`.
- `historical` orders never create moves (stock count already reflects them) but count for
  sales, profit and forecasts.
- Serials: `nextSerialsFor()` skips any serial already used by another order; `bumpNextSerial()`
  advances `product.nextSerial` past any typed serial with the product prefix.
- Products page edits inline on `change` (not `input`) and only re-renders for fields that
  affect derived text, so tabbing between fields keeps focus.
- `[hidden] { display:none !important }` is required (modals use `display:flex`).
- The "beacon" CSS token name is kept for suite parity but is desert sandstone orange in Virga.

## Cloud sync (shared with the suite)
- Same worker (`nimbus-sync.nimbus-sync.workers.dev`), same PBKDF2(600k)/AES-GCM envelope,
  same `kashikoi-cloud-sync-v1:` key derivation and 16-word phrase as Arcus/Anvil/Cirrus/etc.
- The worker only accepts `app: "Nimbus" | "Cumulus"`, so the envelope is tagged `Nimbus`
  with `writtenBy: "Virga"`. Data lives at `apps.virga` inside the unified
  `kashikoi-app-backup-v1` blob; saving always merges and preserves other apps' slices.

## Release flow
Same as the other cloud apps: work on `develop` → bump `APP_VERSION` in app.js and every
`?v=` string + About version in index.html → `cp app.js index.html styles.css icon.svg
manifest.webmanifest build/` → commit "Release Virga <version>" → push `develop` →
`git checkout main && git merge develop -m "Merge develop for Virga <version>"` → push
`main` → switch back to `develop`.
