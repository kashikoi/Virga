# Virga — Inventory & Side-Hustle Planner

## Overview
- **Name:** Virga (after virga — rain that streams from a cloud but evaporates before it reaches the desert floor).
- **Purpose:** A local-first, zero-backend planner for a small build-to-order business. Track the **parts** you build with, the **products** you sell and the **options** buyers choose, every **order** and **serial number**, and get usage-based **restock** advice so you order parts before you run dry.
- **First use case:** BMW 1M side indicators sold on eBay — lens (Clear / Smoked) × base (Gloss black / Matte black / Chrome). A one-click template sets this up; everything is editable and the app is fully general.
- **Sister apps:** Shares the sky/cloud design language, settings, and encrypted cloud sync of Cumulus, Nimbus, Cirrus, Stratus, Anvil and Arcus (frosted glass, multi-atmosphere theme, no-build vanilla HTML/CSS/JS).

## Technology & Design Philosophy
- **Stack:** Plain vanilla HTML5, CSS3, ES2015+ JavaScript. No framework, no bundler, no build step.
- **Local-first:** All data persists in `localStorage`; 100% private to the browser. JSON export/import plus optional zero-knowledge encrypted cloud sync.
- **Deploy:** Static site — open `index.html` directly (`file://`) or via GitHub Pages: https://kashikoi.github.io/Virga/

## Concepts
- **Parts** — raw inventory with unit cost, supplier, reorder link, reorder point, usual order qty and lead time. Stock is the sum of movements (counts, adjustments, builds, receipts), so every change has history.
- **Products** — what you sell: default price, serial prefix/digits/next number, parts *every unit uses*, and **options** (e.g. Lens, Base) whose **choices** each add their own parts.
- **Orders** — product + choices, buyer, platform, order #, price, shipping, postage, fees (estimate from your fee %), serials, tracking. Flow: **To build → Built → Shipped → Completed** (or Cancelled).
  - *To build* reserves parts (reduces **available**). *Built* deducts them from stock, snapshots parts cost, and assigns the next free serial.
  - **Past order** checkbox: counts toward sales, profit and usage forecasts but never touches stock — for logging orders that happened before you counted inventory.
- **Restock** — per part: on hand, reserved for orders, incoming (open purchases), available, monthly usage (from orders sold in the look-back window), days of cover, and an **order-by date** = when available + incoming would no longer cover lead time + safety buffer. Suggestions are grouped by supplier and turn into a purchase in one click; receiving a purchase adds stock and updates part cost.
- **Dashboard** — revenue, profit, stock value, what needs attention, a **can-build-now matrix** for every option combination (with the limiting part and how many of each sold), monthly sales, recent orders.
- **Serials** — every recorded serial, duplicates flagged, numbers below "next" that aren't linked to an order.

## Data Model (localStorage)
- `virga_cloud_data` — `{ business, parts, products, orders, purchases, moves }`
  - **business:** `{ name, feePct, feeFixed, bufferDays, lookbackDays }`
  - **part:** `{ id, name, sku, category, unit, unitCost, reorderPoint, reorderQty, leadTimeDays, supplier, url, notes }`
  - **product:** `{ id, name, icon, price, shipping, serialPrefix, serialPad, nextSerial, baseBom[{partId,qty}], options[{id, name, choices[{id, label, bom[{partId,qty}]}]}], notes }`
  - **order:** `{ id, productId, choices{optionId: choiceId}, qty, date, status: "open"|"built"|"shipped"|"closed"|"cancelled", historical, customer, platform, ref, price, shippingCharged, shippingCost, fees, cogs, serials[], tracking, notes, builtAt, shippedAt, closedAt, createdAt, updatedAt }`
  - **purchase:** `{ id, supplier, ref, date, expectedDate, receivedDate, status: "ordered"|"received", shippingCost, lines[{partId, qty, unitCost}], notes }`
  - **move:** `{ id, date, partId, delta, kind: "count"|"adjust"|"build"|"receive", ref: "order:<id>"|"po:<id>"|"", note }`
- `virga_cloud_theme` — `"day"` (default) | `"twilight"` | `"night"` | `"random"`.
- `virga_cloud_view` — last open view.
- `virga_cloud_phrase` — opt-in remembered cloud recovery phrase.

## Settings
Atmosphere (Day / Twilight / Night / Random), Business (name, marketplace fee % + per-order fee, safety buffer days, sales look-back days), Export / Import JSON, Encrypted Cloud Sync (same recovery phrase and shared backup as the other cloud apps), Add 1M indicator template, Randomize data (demo), Clear all data, About.

## Keyboard
`N` new order · `⌘/Ctrl+S` save the open editor · `Esc` close dialogs.

## Files
`index.html`, `styles.css`, `app.js`, `icon.svg`, `manifest.webmanifest`, `build/` (release mirror).
