/* ============================================================
   VIRGA — Inventory & side-hustle planner
   Parts -> products (options + bill of materials) -> orders
   -> serial numbers -> restock planning.
   Zero backend. All state in localStorage.
   ============================================================ */
(function () {
  "use strict";

  const STORE_KEY = "virga_cloud_data";
  const THEME_KEY = "virga_cloud_theme";
  const ACTIVE_THEME_KEY = "virga_cloud_active_theme"; // sessionStorage, resolved random pick
  const VIEW_KEY = "virga_cloud_view";
  const REMEMBER_CLOUD_PHRASE_KEY = "virga_cloud_phrase"; // localStorage, opt-in remembered phrase

  const APP_VERSION = "2026.10.31.1";
  const THEMES = ["day", "twilight", "night"];
  const DEFAULT_THEME = "day";
  const VIEWS = ["dashboard", "orders", "inventory", "restock", "products", "serials"];
  const ORDER_STATUSES = ["open", "built", "shipped", "closed", "cancelled"];
  const ORDER_FLOW = ["open", "built", "shipped", "closed"];
  const STATUS_LABEL = { open: "To build", built: "Built", shipped: "Shipped", closed: "Completed", cancelled: "Cancelled" };
  const STATUS_PILL = { open: "pill--warn", built: "pill--active", shipped: "pill--info", closed: "pill--good", cancelled: "pill--paused" };
  const NEXT_ACTION = { open: "Mark built", built: "Mark shipped", shipped: "Complete" };
  // Orders in these states have physically consumed their parts.
  const CONSUMING = new Set(["built", "shipped", "closed"]);
  const MOVE_KINDS = ["adjust", "count", "build", "receive"];
  const DAY_MS = 86400000;

  // ---------- Cloud sync / unified backup (shared Kashikoi suite worker) ----------
  const CLOUD_SYNC_ENDPOINT = "https://nimbus-sync.nimbus-sync.workers.dev";
  const CLOUD_SYNC_FORMAT = "kashikoi-encrypted-backup-v1";
  const LEGACY_CLOUD_SYNC_FORMAT = "nimbus-encrypted-backup-v1";
  const UNIFIED_BACKUP_SCHEMA = "kashikoi-app-backup-v1";
  // The shared sync Worker only accepts envelopes tagged "Nimbus"/"Cumulus"; since every app
  // reads/writes the same blob, Virga tags it "Nimbus" so the PUT validates and the other apps
  // can still decrypt it. The honest author is recorded separately in `writtenBy`.
  const CLOUD_ENVELOPE_APP = "Nimbus";
  const ACCEPTED_ENVELOPE_APPS = new Set(["Nimbus", "Cumulus", "Cirrus", "Stratus", "Anvil", "Arcus", "Virga"]);
  const RECOVERY_PHRASE_WORD_COUNT = 16;
  const CLOUD_KDF_ITERATIONS = 600000;
  const RECOVERY_WORDS = [
    "anchor", "apricot", "arbor", "aurora", "basalt", "beacon", "birch", "bison",
    "blossom", "boulder", "breeze", "canyon", "cedar", "cinder", "cirrus", "clay",
    "clover", "cobalt", "comet", "coral", "cove", "crater", "crystal", "cumulus",
    "current", "dawn", "delta", "dune", "ember", "evergreen", "fathom", "fern",
    "fjord", "flint", "forge", "fossil", "galaxy", "garnet", "geyser", "glacier",
    "granite", "grove", "harbor", "hazel", "heather", "horizon", "ivory", "jade",
    "juniper", "kelp", "lagoon", "lantern", "lichen", "lilac", "lumen", "magma",
    "maple", "marble", "meadow", "meridian", "mesa", "mica", "mist", "monsoon",
    "moss", "nebula", "nectar", "oasis", "obsidian", "ocean", "onyx", "opal",
    "orchard", "pebble", "petal", "pine", "pollen", "prairie", "quartz", "quill",
    "rapids", "ravine", "reef", "ridge", "ripple", "river", "sable", "saffron",
    "sage", "sandbar", "sapphire", "savanna", "sequoia", "shale", "shore", "sierra",
    "slate", "solstice", "spruce", "storm", "summit", "tempest", "thicket", "thunder",
    "tide", "timber", "topaz", "trellis", "tundra", "valley", "vapor", "verdant",
    "vertex", "vista", "willow", "wisp", "zenith", "zephyr",
  ];

  // ---------- In-memory state ----------
  let db = emptyDb();
  let view = "dashboard";
  let orderFilter = "open";   // open | done | all
  let orderQuery = "";
  let editingOrderId = null;
  let editingPartId = null;
  let adjustPartId = null;
  let adjustMode = "count";
  let poDraft = null;
  let stockCache = null;
  const el = {};

  // ---------- Utilities ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function num(v, fallback) {
    const n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }
  function round2(n) { return Math.round(num(n) * 100) / 100; }
  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function str(v, max) { return String(v == null ? "" : v).slice(0, max || 500); }
  function isoDate(v, fallback) {
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : (fallback === undefined ? "" : fallback);
  }
  function todayISO() { return isoOffset(0); }
  function isoOffset(days) {
    const d = new Date(Date.now() + days * DAY_MS);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  function parseDate(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }
  function daysUntil(iso) {
    const d = parseDate(iso);
    if (!d) return null;
    const t = new Date();
    return Math.round((d - new Date(t.getFullYear(), t.getMonth(), t.getDate())) / DAY_MS);
  }
  function fmtDate(iso, opts) {
    const d = parseDate(iso);
    if (!d) return "";
    return d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" });
  }
  function fmtShortDate(iso) { return fmtDate(iso, { month: "short", day: "numeric" }); }
  function fmtMoney(v) {
    const n = num(v);
    return (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney0(v) {
    const n = num(v);
    return (n < 0 ? "-$" : "$") + Math.round(Math.abs(n)).toLocaleString();
  }
  function fmtQty(v) {
    const n = num(v);
    return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
  function humanDays(days) {
    if (!Number.isFinite(days)) return "—";
    if (days <= 0) return "0 days";
    if (days < 14) return plural(Math.round(days), "day");
    if (days < 70) return plural(Math.round(days / 7), "week");
    if (days < 730) return plural(Math.round(days / 30.44), "month");
    return (days / 365.25).toFixed(1) + " yrs";
  }
  function toast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.toast.hidden = true; }, 3200);
  }
  function $(id) { return document.getElementById(id); }

  // ---------- Model / normalization ----------
  function emptyDb() {
    return { business: defaultBusiness(), parts: [], products: [], orders: [], purchases: [], moves: [] };
  }
  function defaultBusiness() {
    return { name: "", feePct: 13.25, feeFixed: 0.4, bufferDays: 7, lookbackDays: 90 };
  }
  function normalizeBusiness(b) {
    const o = b && typeof b === "object" ? b : {};
    const d = defaultBusiness();
    return {
      name: str(o.name, 80),
      feePct: clamp(num(o.feePct, d.feePct), 0, 100),
      feeFixed: Math.max(0, num(o.feeFixed, d.feeFixed)),
      bufferDays: clamp(Math.round(num(o.bufferDays, d.bufferDays)), 0, 365),
      lookbackDays: clamp(Math.round(num(o.lookbackDays, d.lookbackDays)), 30, 365),
    };
  }
  function normalizeBom(list) {
    return (Array.isArray(list) ? list : [])
      .filter((b) => b && typeof b === "object")
      .map((b) => ({ partId: typeof b.partId === "string" ? b.partId : "", qty: Math.max(0, num(b.qty, 1)) }));
  }
  function normalizePart(p) {
    const o = p && typeof p === "object" ? p : {};
    return {
      id: str(o.id, 40) || uid(),
      name: str(o.name || "Untitled part", 120),
      sku: str(o.sku, 60),
      category: str(o.category, 60),
      unit: str(o.unit || "pcs", 12),
      unitCost: Math.max(0, num(o.unitCost)),
      reorderPoint: Math.max(0, num(o.reorderPoint)),
      reorderQty: Math.max(0, num(o.reorderQty)),
      leadTimeDays: Math.max(0, Math.round(num(o.leadTimeDays, 14))),
      supplier: str(o.supplier, 80),
      url: str(o.url, 500),
      notes: str(o.notes, 4000),
    };
  }
  function normalizeProduct(p) {
    const o = p && typeof p === "object" ? p : {};
    return {
      id: str(o.id, 40) || uid(),
      name: str(o.name || "Untitled product", 120),
      icon: str(o.icon || "📦", 8),
      price: Math.max(0, num(o.price)),
      shipping: Math.max(0, num(o.shipping)),
      serialPrefix: str(o.serialPrefix, 20),
      serialPad: clamp(Math.round(num(o.serialPad, 3)), 0, 8),
      nextSerial: Math.max(1, Math.round(num(o.nextSerial, 1))),
      baseBom: normalizeBom(o.baseBom),
      options: (Array.isArray(o.options) ? o.options : []).filter((x) => x && typeof x === "object").map((opt) => ({
        id: str(opt.id, 40) || uid(),
        name: str(opt.name || "Option", 60),
        choices: (Array.isArray(opt.choices) ? opt.choices : []).filter((c) => c && typeof c === "object").map((c) => ({
          id: str(c.id, 40) || uid(),
          label: str(c.label || "Choice", 60),
          bom: normalizeBom(c.bom),
        })),
      })),
      notes: str(o.notes, 4000),
    };
  }
  function normalizeOrder(x) {
    const o = x && typeof x === "object" ? x : {};
    const choices = {};
    if (o.choices && typeof o.choices === "object") Object.keys(o.choices).forEach((k) => { choices[k] = str(o.choices[k], 40); });
    const now = new Date().toISOString();
    return {
      id: str(o.id, 40) || uid(),
      productId: str(o.productId, 40),
      choices,
      qty: Math.max(1, Math.round(num(o.qty, 1))),
      date: isoDate(o.date, todayISO()),
      status: ORDER_STATUSES.includes(o.status) ? o.status : "open",
      historical: !!o.historical,
      customer: str(o.customer, 120),
      platform: str(o.platform, 40),
      ref: str(o.ref, 80),
      price: Math.max(0, num(o.price)),
      shippingCharged: Math.max(0, num(o.shippingCharged)),
      shippingCost: Math.max(0, num(o.shippingCost)),
      fees: Math.max(0, num(o.fees)),
      cogs: Math.max(0, num(o.cogs)),
      serials: (Array.isArray(o.serials) ? o.serials : []).map((s) => str(s, 40).trim()).filter(Boolean),
      tracking: str(o.tracking, 80),
      notes: str(o.notes, 4000),
      builtAt: isoDate(o.builtAt),
      shippedAt: isoDate(o.shippedAt),
      closedAt: isoDate(o.closedAt),
      createdAt: o.createdAt || now,
      updatedAt: o.updatedAt || now,
    };
  }
  function normalizePurchase(x) {
    const o = x && typeof x === "object" ? x : {};
    return {
      id: str(o.id, 40) || uid(),
      supplier: str(o.supplier, 80),
      ref: str(o.ref, 200),
      date: isoDate(o.date, todayISO()),
      expectedDate: isoDate(o.expectedDate),
      receivedDate: isoDate(o.receivedDate),
      status: o.status === "received" ? "received" : "ordered",
      shippingCost: Math.max(0, num(o.shippingCost)),
      lines: (Array.isArray(o.lines) ? o.lines : []).filter((l) => l && typeof l === "object").map((l) => ({
        partId: str(l.partId, 40),
        qty: Math.max(0, num(l.qty)),
        unitCost: Math.max(0, num(l.unitCost)),
      })),
      notes: str(o.notes, 4000),
    };
  }
  function normalizeMove(x) {
    const o = x && typeof x === "object" ? x : {};
    return {
      id: str(o.id, 40) || uid(),
      date: isoDate(o.date, todayISO()),
      partId: str(o.partId, 40),
      delta: num(o.delta),
      kind: MOVE_KINDS.includes(o.kind) ? o.kind : "adjust",
      ref: str(o.ref, 60),
      note: str(o.note, 300),
    };
  }
  function sanitizeDb(raw) {
    const o = raw && typeof raw === "object" ? raw : {};
    const out = {
      business: normalizeBusiness(o.business),
      parts: (Array.isArray(o.parts) ? o.parts : []).map(normalizePart),
      products: (Array.isArray(o.products) ? o.products : []).map(normalizeProduct),
      orders: (Array.isArray(o.orders) ? o.orders : []).map(normalizeOrder),
      purchases: (Array.isArray(o.purchases) ? o.purchases : []).map(normalizePurchase),
      moves: (Array.isArray(o.moves) ? o.moves : []).map(normalizeMove),
    };
    const partIds = new Set(out.parts.map((p) => p.id));
    out.moves = out.moves.filter((m) => partIds.has(m.partId));
    return out;
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      db = raw ? sanitizeDb(JSON.parse(raw)) : emptyDb();
    } catch (e) {
      db = emptyDb();
    }
    const v = localStorage.getItem(VIEW_KEY);
    view = VIEWS.includes(v) ? v : "dashboard";
  }
  function save() {
    stockCache = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (e) {
      toast("Couldn't save — browser storage may be full.");
    }
  }

  // ---------- Lookups ----------
  function partById(id) { return db.parts.find((p) => p.id === id) || null; }
  function productById(id) { return db.products.find((p) => p.id === id) || null; }
  function orderById(id) { return db.orders.find((o) => o.id === id) || null; }
  function purchaseById(id) { return db.purchases.find((p) => p.id === id) || null; }
  function partName(id) { const p = partById(id); return p ? p.name : "(deleted part)"; }
  function uniqueSorted(list) { return [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b)); }

  // ---------- Bill of materials ----------
  function choiceFor(product, opt, choices) {
    return opt.choices.find((c) => c.id === (choices || {})[opt.id]) || null;
  }
  function unitBom(product, choices) {
    const need = new Map();
    const add = (list) => list.forEach((b) => {
      if (b.partId && b.qty > 0) need.set(b.partId, (need.get(b.partId) || 0) + b.qty);
    });
    add(product.baseBom);
    product.options.forEach((opt) => { const c = choiceFor(product, opt, choices); if (c) add(c.bom); });
    return need;
  }
  function orderBom(order) {
    const product = productById(order.productId);
    const out = new Map();
    if (!product) return out;
    unitBom(product, order.choices).forEach((q, id) => out.set(id, q * order.qty));
    return out;
  }
  function bomCost(map) {
    let total = 0;
    map.forEach((q, id) => { const p = partById(id); if (p) total += q * p.unitCost; });
    return total;
  }
  function describeChoices(product, choices) {
    if (!product) return "";
    return product.options.map((opt) => { const c = choiceFor(product, opt, choices); return c ? c.label : ""; }).filter(Boolean).join(" · ");
  }
  function comboKey(product, choices) {
    return product.options.map((opt) => (choices || {})[opt.id] || "").join("|");
  }
  function allCombos(product) {
    let list = [{}];
    product.options.forEach((opt) => {
      if (!opt.choices.length) return;
      const next = [];
      list.forEach((c) => opt.choices.forEach((ch) => next.push(Object.assign({}, c, { [opt.id]: ch.id }))));
      list = next.slice(0, 120);
    });
    return list;
  }

  // ---------- Stock math (single source of truth) ----------
  // On hand = sum of stock movements. Committed = parts needed by orders not yet built.
  // Usage rate = parts consumed by orders sold within the look-back window (includes past
  // orders flagged "historical", so the forecast works from day one).
  function computeStock() {
    if (stockCache) return stockCache;
    const biz = db.business;
    const since = isoOffset(-biz.lookbackDays);
    const map = new Map();
    db.parts.forEach((p) => map.set(p.id, { onHand: 0, committed: 0, incoming: 0, used: 0, sold: 0 }));
    db.moves.forEach((m) => { const s = map.get(m.partId); if (s) s.onHand += m.delta; });
    let earliest = null;
    db.orders.forEach((o) => {
      if (o.status === "cancelled") return;
      const bom = orderBom(o);
      if (o.status === "open") {
        if (!o.historical) bom.forEach((q, id) => { const s = map.get(id); if (s) s.committed += q; });
      }
      if (o.date >= since) {
        bom.forEach((q, id) => { const s = map.get(id); if (s) s.used += q; });
        if (!earliest || o.date < earliest) earliest = o.date;
      }
    });
    db.purchases.forEach((po) => {
      if (po.status !== "ordered") return;
      po.lines.forEach((l) => { const s = map.get(l.partId); if (s) s.incoming += l.qty; });
    });
    // Measure the rate over the span we actually have data for (min 30 days) so a young
    // business isn't diluted by empty months.
    const span = earliest ? clamp(1 - daysUntil(earliest), 30, biz.lookbackDays) : biz.lookbackDays;
    db.parts.forEach((p) => {
      const s = map.get(p.id);
      s.available = s.onHand - s.committed;
      s.position = s.available + s.incoming;
      s.rate = s.used / span;
      s.perMonth = s.rate * 30.44;
      s.cover = s.rate > 0 ? Math.max(0, s.available) / s.rate : Infinity;
      const lead = p.leadTimeDays + biz.bufferDays;
      s.reorderIn = s.rate > 0 ? Math.floor(s.position / s.rate - lead) : Infinity;
      const belowPoint = p.reorderPoint > 0 && s.position <= p.reorderPoint;
      const active = s.rate > 0 || p.reorderPoint > 0 || s.committed > 0;
      const needsOrder = belowPoint || s.reorderIn <= 0 || s.position < 0 || (s.position === 0 && active);
      if (needsOrder) s.status = s.available < 0 ? "short" : s.available === 0 ? "out" : "reorder";
      else if (s.available <= 0 && active) s.status = "waiting";
      else if (s.reorderIn <= 14) s.status = "soon";
      else s.status = "ok";
      s.orderBy = needsOrder ? todayISO() : (Number.isFinite(s.reorderIn) ? isoOffset(s.reorderIn) : "");
      if (needsOrder || s.status === "soon") {
        const target = Math.ceil(s.rate * (lead + 30)) + p.reorderPoint;
        s.suggest = Math.max(p.reorderQty, Math.ceil(target - s.position), 1);
      } else {
        s.suggest = 0;
      }
    });
    stockCache = map;
    return map;
  }
  const STOCK_STATUS = {
    short: { label: "Short", pill: "pill--overdue", rank: 0 },
    out: { label: "Out", pill: "pill--overdue", rank: 1 },
    reorder: { label: "Reorder", pill: "pill--warn", rank: 2 },
    soon: { label: "Soon", pill: "pill--warn", rank: 3 },
    waiting: { label: "Incoming", pill: "pill--info", rank: 4 },
    ok: { label: "OK", pill: "pill--good", rank: 5 },
  };
  function alertParts() {
    const stock = computeStock();
    return db.parts.filter((p) => ["short", "out", "reorder"].includes(stock.get(p.id).status));
  }
  function buildable(product, choices, stock) {
    const bom = unitBom(product, choices);
    if (!bom.size) return { n: null, limit: null };
    let n = Infinity, limit = null;
    bom.forEach((q, id) => {
      const s = stock.get(id);
      const can = Math.floor(Math.max(0, s ? s.available : 0) / q);
      if (can < n) { n = can; limit = id; }
    });
    return { n, limit };
  }

  // ---------- Serial numbers ----------
  function fmtSerial(product, n) {
    return (product.serialPrefix || "") + String(n).padStart(product.serialPad || 0, "0");
  }
  function usedSerials(exceptOrderId) {
    const set = new Set();
    db.orders.forEach((o) => { if (o.id !== exceptOrderId) o.serials.forEach((s) => set.add(s.toLowerCase())); });
    return set;
  }
  function nextSerialsFor(product, count, exceptOrderId) {
    const used = usedSerials(exceptOrderId);
    const out = [];
    let n = product.nextSerial;
    while (out.length < count && n < product.nextSerial + 100000) {
      const s = fmtSerial(product, n);
      if (!used.has(s.toLowerCase())) out.push(s);
      n++;
    }
    return out;
  }
  function serialNumber(product, serial) {
    const pre = (product.serialPrefix || "").toLowerCase();
    const s = serial.toLowerCase();
    if (pre && !s.startsWith(pre)) return null;
    const rest = s.slice(pre.length);
    return /^\d+$/.test(rest) ? parseInt(rest, 10) : null;
  }
  function bumpNextSerial(product, serials) {
    serials.forEach((s) => {
      const n = serialNumber(product, s);
      if (n !== null && n >= product.nextSerial) product.nextSerial = n + 1;
    });
  }
  function parseSerials(text) {
    return String(text || "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  }

  // ---------- Order lifecycle ----------
  function syncOrderMoves(order) {
    const ref = "order:" + order.id;
    db.moves = db.moves.filter((m) => m.ref !== ref);
    if (order.historical || !CONSUMING.has(order.status)) return;
    const date = order.builtAt || order.date || todayISO();
    orderBom(order).forEach((q, partId) => {
      db.moves.push({ id: uid(), date, partId, delta: -q, kind: "build", ref, note: "" });
    });
  }
  function finalizeOrder(order) {
    const product = productById(order.productId);
    if (CONSUMING.has(order.status) && !order.builtAt) order.builtAt = order.date;
    if (product) {
      if (CONSUMING.has(order.status) && !order.serials.length && !order.historical) {
        order.serials = nextSerialsFor(product, order.qty, order.id);
      }
      bumpNextSerial(product, order.serials);
    }
    order.cogs = round2(bomCost(orderBom(order)));
    order.updatedAt = new Date().toISOString();
    syncOrderMoves(order);
  }
  function shortagesAfter(order) {
    stockCache = null;
    const stock = computeStock();
    const short = [];
    orderBom(order).forEach((q, id) => { const s = stock.get(id); if (s && s.onHand < 0) short.push(partName(id)); });
    return short;
  }
  function advanceOrder(id) {
    const o = orderById(id);
    if (!o) return;
    const i = ORDER_FLOW.indexOf(o.status);
    if (i < 0 || i >= ORDER_FLOW.length - 1) return;
    o.status = ORDER_FLOW[i + 1];
    const today = todayISO();
    if (o.status === "built" && !o.builtAt) o.builtAt = today;
    if (o.status === "shipped" && !o.shippedAt) o.shippedAt = today;
    if (o.status === "closed" && !o.closedAt) o.closedAt = today;
    finalizeOrder(o);
    save();
    renderAll();
    const short = shortagesAfter(o);
    const serialNote = o.status === "built" && o.serials.length ? " Serial " + o.serials.join(", ") + "." : "";
    toast(STATUS_LABEL[o.status] + "." + serialNote + (short.length ? " ⚠ Stock went negative: " + short.join(", ") : ""));
  }
  function orderProfit(o) {
    return round2(o.price + o.shippingCharged - o.fees - o.shippingCost - o.cogs);
  }
  function estimateFees(price, shipping) {
    const b = db.business;
    return round2((num(price) + num(shipping)) * b.feePct / 100 + b.feeFixed);
  }

  // ---------- Purchases ----------
  function syncPurchaseMoves(po) {
    const ref = "po:" + po.id;
    db.moves = db.moves.filter((m) => m.ref !== ref);
    if (po.status !== "received") return;
    po.lines.forEach((l) => {
      if (!l.partId || !(l.qty > 0)) return;
      db.moves.push({ id: uid(), date: po.receivedDate || po.date, partId: l.partId, delta: l.qty, kind: "receive", ref, note: po.supplier });
    });
  }
  function poTotal(po) {
    return round2(po.lines.reduce((s, l) => s + l.qty * l.unitCost, 0) + po.shippingCost);
  }
  function receivePurchase(id) {
    const po = purchaseById(id);
    if (!po || po.status === "received") return;
    po.status = "received";
    po.receivedDate = todayISO();
    applyPurchaseCosts(po);
    syncPurchaseMoves(po);
    save();
    renderAll();
    toast("Received — " + plural(po.lines.length, "item") + " added to stock.");
  }
  function applyPurchaseCosts(po) {
    po.lines.forEach((l) => { const p = partById(l.partId); if (p && l.unitCost > 0) p.unitCost = l.unitCost; });
  }

  // ---------- Templates & demo ----------
  // A generic starting point for the BMW 1M side-indicator business. Everything is editable.
  function indicatorTemplate() {
    const P = (name, category, cost, extra) => normalizePart(Object.assign({
      id: uid(), name, category, unitCost: cost, reorderPoint: 6, reorderQty: 20, leadTimeDays: 21, supplier: "AliExpress",
    }, extra || {}));
    const parts = {
      clear: P("Clear lens", "Lenses", 4.5),
      smoked: P("Smoked lens", "Lenses", 5),
      gloss: P("Gloss black base", "Bases", 3.5),
      matte: P("Matte black base", "Bases", 3.5),
      chrome: P("Chrome base", "Bases", 4.25),
      led: P("LED module (amber)", "Electrical", 2.2, { reorderPoint: 10, reorderQty: 40 }),
      gasket: P("Gasket", "Hardware", 0.4, { reorderPoint: 10, reorderQty: 50, supplier: "Amazon", leadTimeDays: 5 }),
      box: P("Shipping box + padding", "Packaging", 1.1, { reorderPoint: 5, reorderQty: 25, supplier: "Uline", leadTimeDays: 4 }),
    };
    const product = normalizeProduct({
      id: uid(),
      name: "BMW 1M side indicators (pair)",
      icon: "💡",
      price: 89.99,
      shipping: 0,
      serialPrefix: "1M-",
      serialPad: 3,
      nextSerial: 24,
      baseBom: [
        { partId: parts.led.id, qty: 2 },
        { partId: parts.gasket.id, qty: 2 },
        { partId: parts.box.id, qty: 1 },
      ],
      options: [
        { id: uid(), name: "Lens", choices: [
          { id: uid(), label: "Clear", bom: [{ partId: parts.clear.id, qty: 2 }] },
          { id: uid(), label: "Smoked", bom: [{ partId: parts.smoked.id, qty: 2 }] },
        ] },
        { id: uid(), name: "Base", choices: [
          { id: uid(), label: "Gloss black", bom: [{ partId: parts.gloss.id, qty: 2 }] },
          { id: uid(), label: "Matte black", bom: [{ partId: parts.matte.id, qty: 2 }] },
          { id: uid(), label: "Chrome", bom: [{ partId: parts.chrome.id, qty: 2 }] },
        ] },
      ],
      notes: "Sold as a left + right pair. Serials 1M-001 to 1M-023 were used before Virga.",
    });
    return { parts: Object.values(parts), product };
  }
  function addTemplate() {
    if (db.products.some((p) => /1M side indicator/i.test(p.name)) &&
        !confirm("You already have a 1M side-indicator product. Add another copy of the template?")) return;
    const t = indicatorTemplate();
    db.parts.push(...t.parts);
    db.products.push(t.product);
    if (!db.business.name) db.business.name = "1M Side Indicators";
    save();
    closeModals();
    setView("inventory");
    toast("Template added — set your on-hand counts with ± on each part.");
  }

  function demoData() {
    const t = indicatorTemplate();
    t.product.nextSerial = 1;
    const out = emptyDb();
    out.business.name = "1M Side Indicators";
    out.parts = t.parts;
    out.products = [t.product];
    const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    db = out;
    const prod = t.product;
    const lens = prod.options[0], base = prod.options[1];
    const buyers = ["m3_dave", "e82_fan", "bimmerboy", "nurburg_nate", "valencia_orange", "n54tuner", "sapphire_1m", "jw_motorsport", "carbonkid", "alpine_white"];
    const makeOrder = (daysAgo, status) => {
      const smoked = Math.random() < 0.62;
      const baseChoice = Math.random() < 0.5 ? base.choices[0] : (Math.random() < 0.6 ? base.choices[1] : base.choices[2]);
      const price = pick([84.99, 89.99, 89.99, 94.99]);
      const o = normalizeOrder({
        productId: prod.id,
        choices: { [lens.id]: (smoked ? lens.choices[1] : lens.choices[0]).id, [base.id]: baseChoice.id },
        date: isoOffset(-daysAgo),
        status,
        customer: pick(buyers) + rnd(1, 99),
        platform: "eBay",
        ref: rnd(10, 27) + "-" + rnd(10000, 99999) + "-" + rnd(10000, 99999),
        price,
        shippingCharged: 0,
        shippingCost: pick([5.2, 5.75, 6.1]),
        builtAt: status === "open" ? "" : isoOffset(-daysAgo + 2),
        shippedAt: status === "closed" || status === "shipped" ? isoOffset(-daysAgo + 3) : "",
        closedAt: status === "closed" ? isoOffset(-daysAgo + 10) : "",
      });
      o.fees = estimateFees(o.price, o.shippingCharged);
      db.orders.push(o);
      finalizeOrder(o);
    };
    const ages = [];
    for (let i = 0; i < 23; i++) ages.push(rnd(12, 190));
    ages.sort((a, b) => b - a).forEach((d) => makeOrder(d, "closed"));
    makeOrder(6, "shipped");
    makeOrder(3, "built");
    makeOrder(1, "open");
    makeOrder(0, "open");
    const po1 = normalizePurchase({
      supplier: "AliExpress", date: isoOffset(-95), status: "received", receivedDate: isoOffset(-74),
      lines: [{ partId: t.parts[1].id, qty: 20, unitCost: 5 }, { partId: t.parts[4].id, qty: 10, unitCost: 4.25 }], shippingCost: 6.5,
    });
    const po2 = normalizePurchase({
      supplier: "AliExpress", date: isoOffset(-9), expectedDate: isoOffset(12), status: "ordered",
      lines: [{ partId: t.parts[1].id, qty: 20, unitCost: 5 }, { partId: t.parts[2].id, qty: 20, unitCost: 3.5 }], shippingCost: 5,
    });
    db.purchases.push(po1, po2);
    syncPurchaseMoves(po1);
    // Opening counts sized so the demo ends with a realistic mix of healthy and low stock.
    stockCache = null;
    const stock = computeStock();
    out.parts.forEach((p, i) => {
      const left = [1, 9, 3, 7, 12, 30, 8, 14][i % 8];
      out.moves.push({ id: uid(), date: isoOffset(-200), partId: p.id, delta: left - stock.get(p.id).onHand + stock.get(p.id).committed, kind: "count", ref: "", note: "Opening count" });
    });
    stockCache = null;
    return db;
  }
  function randomizeData() {
    if ((db.orders.length || db.parts.length) && !confirm("Replace everything with a demo business? Export first if you want to keep your current data.")) return;
    db = demoData();
    save();
    closeModals();
    setView("dashboard");
    toast("Demo data loaded.");
  }
  function clearAll() {
    if (!confirm("Delete ALL parts, products, orders, purchases and stock history? This cannot be undone.")) return;
    db = emptyDb();
    save();
    closeModals();
    setView("dashboard");
    toast("All data cleared.");
  }

  // ---------- Rendering: shell ----------
  const NAV = [
    { id: "dashboard", icon: "📊", label: "Dashboard" },
    { id: "orders", icon: "🧾", label: "Orders" },
    { id: "inventory", icon: "📦", label: "Inventory" },
    { id: "restock", icon: "🚚", label: "Restock" },
    { id: "products", icon: "🧩", label: "Products" },
    { id: "serials", icon: "🔢", label: "Serials" },
  ];
  function setView(v) {
    view = VIEWS.includes(v) ? v : "dashboard";
    localStorage.setItem(VIEW_KEY, view);
    renderAll();
    el.canvas.scrollTop = 0;
  }
  function renderAll() {
    renderRail();
    renderCrumb();
    renderCanvas();
  }
  function renderRail() {
    const open = db.orders.filter((o) => ["open", "built", "shipped"].includes(o.status)).length;
    const closed = db.orders.filter((o) => o.status === "closed").length;
    const alerts = alertParts().length;
    el.railSummary.innerHTML =
      `<div class="stat-mini"><span class="stat-mini__val">${open}</span><span class="stat-mini__lbl">Open</span></div>` +
      `<div class="stat-mini"><span class="stat-mini__val">${closed}</span><span class="stat-mini__lbl">Completed</span></div>` +
      `<div class="stat-mini${alerts ? " is-alert" : ""}"><span class="stat-mini__val">${alerts}</span><span class="stat-mini__lbl">Restock</span></div>`;
    const toBuild = db.orders.filter((o) => o.status === "open").length;
    const openPOs = db.purchases.filter((p) => p.status === "ordered").length;
    const badges = { orders: [toBuild, toBuild > 0], inventory: [alerts, alerts > 0], restock: [openPOs, false] };
    el.navList.innerHTML = NAV.map((n) => {
      const b = badges[n.id];
      const badge = b && b[0] ? `<span class="nav-item__badge${b[1] ? " nav-item__badge--alert" : ""}">${b[0]}</span>` : "";
      return `<li><button type="button" class="nav-item${view === n.id ? " is-active" : ""}" data-nav="${n.id}">` +
        `<span class="nav-item__icon">${n.icon}</span><span class="nav-item__label">${n.label}</span>${badge}</button></li>`;
    }).join("");
    el.brandTag.textContent = db.business.name || "Inventory · Orders · Restock";
  }
  function renderCrumb() {
    const n = NAV.find((x) => x.id === view);
    el.crumb.innerHTML = `<button type="button" class="crumb__item crumb__home" data-nav="dashboard">VIRGA</button>` +
      (view !== "dashboard" ? `<span class="crumb__sep">›</span><span class="crumb__item is-current">${n.label}</span>` : "");
  }
  function renderCanvas() {
    let html;
    if (!db.parts.length && !db.products.length && !db.orders.length) html = welcomeHtml();
    else html = ({
      dashboard: dashboardHtml, orders: ordersHtml, inventory: inventoryHtml,
      restock: restockHtml, products: productsHtml, serials: serialsHtml,
    })[view]();
    el.canvas.innerHTML = `<div class="canvas__inner">${html}</div>`;
  }
  function pageHead(title, sub, actions) {
    return `<header class="page-head"><div><h2 class="page-head__title">${title}</h2>` +
      (sub ? `<p class="page-head__sub">${sub}</p>` : "") + `</div>` +
      (actions ? `<div class="page-head__actions">${actions}</div>` : "") + `</header>`;
  }
  function stat(label, value, extra) {
    return `<div class="stat"><span class="stat__lbl">${label}</span><span class="stat__val${extra ? " " + extra : ""}">${value}</span></div>`;
  }
  function welcomeHtml() {
    return `<div class="empty">
      <div class="empty__icon">🌵</div>
      <h2 class="empty__title">Welcome to Virga</h2>
      <p class="empty__text">Track the parts you build with, the products and options you sell, every order and serial number &mdash; and know exactly when to restock before you run dry.</p>
      <div class="empty__actions">
        <button type="button" class="btn btn--beacon" data-act="template">Start with the BMW 1M indicator template</button>
        <button type="button" class="btn btn--ghost" data-act="new-part">Start blank</button>
        <button type="button" class="btn btn--ghost" data-act="demo">Explore demo data</button>
      </div>
      <div class="welcome-steps">
        <div class="welcome-step"><strong>1 · Parts</strong>Your raw inventory (lenses, bases, LEDs, boxes) with cost, supplier and lead time.</div>
        <div class="welcome-step"><strong>2 · Products</strong>What you sell, the options buyers pick, and which parts each choice uses.</div>
        <div class="welcome-step"><strong>3 · Orders</strong>Log each sale; building it deducts parts and assigns the next serial.</div>
        <div class="welcome-step"><strong>4 · Restock</strong>Usage-based forecasts tell you what to order and by when.</div>
      </div>
    </div>`;
  }

  // ---------- Dashboard ----------
  function salesTotals() {
    const sold = db.orders.filter((o) => o.status !== "cancelled");
    const closed = db.orders.filter((o) => o.status === "closed");
    const revenue = sold.reduce((s, o) => s + o.price + o.shippingCharged, 0);
    const profit = sold.reduce((s, o) => s + orderProfit(o), 0);
    return { sold, closed, revenue, profit };
  }
  function stockValue() {
    const stock = computeStock();
    return db.parts.reduce((s, p) => s + Math.max(0, stock.get(p.id).onHand) * p.unitCost, 0);
  }
  function dashboardHtml() {
    const t = salesTotals();
    const stock = computeStock();
    const open = db.orders.filter((o) => ["open", "built", "shipped"].includes(o.status));
    const head = pageHead(escapeHtml(db.business.name || "Dashboard"), fmtDate(todayISO(), { weekday: "long", month: "long", day: "numeric" }),
      `<button type="button" class="btn btn--ghost" data-act="new-purchase">+ Purchase</button><button type="button" class="btn btn--beacon" data-act="new-order">+ New order</button>`);
    const stats = `<div class="stats">
      ${stat("Completed orders", t.closed.length)}
      ${stat("Open orders", open.length)}
      ${stat("Revenue", fmtMoney0(t.revenue))}
      ${stat("Profit", fmtMoney0(t.profit), t.profit < 0 ? "neg" : "")}
      ${stat("Avg profit / order", t.sold.length ? fmtMoney(t.profit / t.sold.length) : "—")}
      ${stat("Stock value", fmtMoney0(stockValue()))}
    </div>`;

    const insights = [];
    db.parts.map((p) => ({ p, s: stock.get(p.id) }))
      .filter((x) => ["short", "out", "reorder", "soon"].includes(x.s.status))
      .sort((a, b) => STOCK_STATUS[a.s.status].rank - STOCK_STATUS[b.s.status].rank)
      .slice(0, 6)
      .forEach(({ p, s }) => {
        const bad = s.status === "short" || s.status === "out";
        const cover = Number.isFinite(s.cover) ? ` · ${humanDays(s.cover)} of cover` : "";
        const when = s.status === "soon" ? `by <strong>${fmtShortDate(s.orderBy)}</strong>` : "<strong>now</strong>";
        insights.push(`<div class="insight insight--${bad ? "bad" : "warn"}"><span>${bad ? "⛔" : "⚠️"}</span><span>Order <strong>${fmtQty(s.suggest)} × ${escapeHtml(p.name)}</strong> ${when} &mdash; ${fmtQty(s.available)} available${cover}, ${p.leadTimeDays}-day lead time.</span></div>`);
      });
    const toBuild = db.orders.filter((o) => o.status === "open").length;
    if (toBuild) insights.push(`<div class="insight"><span>🛠️</span><span><strong>${plural(toBuild, "order")}</strong> waiting to be built. <button type="button" class="link-btn" data-nav="orders">View</button></span></div>`);
    const dupes = duplicateSerials();
    if (dupes.length) insights.push(`<div class="insight insight--bad"><span>🔢</span><span>Duplicate serial${dupes.length > 1 ? "s" : ""}: <strong>${dupes.map(escapeHtml).join(", ")}</strong></span></div>`);
    if (!insights.length && db.parts.length) insights.push(`<div class="insight insight--good"><span>✅</span><span>Stock looks healthy &mdash; nothing needs reordering in the next two weeks.</span></div>`);

    const matrices = db.products.map((p) => `<section><h3 class="section-title">${escapeHtml(p.icon)} ${escapeHtml(p.name)} &mdash; can build now</h3>${buildMatrixHtml(p, stock)}</section>`).join("");
    const recent = db.orders.slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 6);
    return head + stats +
      (insights.length ? `<section><h3 class="section-title">Needs attention</h3><div class="insights">${insights.join("")}</div></section>` : "") +
      matrices +
      `<section><h3 class="section-title">Sales by month</h3><div class="panel">${monthlyChartHtml()}</div></section>` +
      `<section><h3 class="section-title">Recent orders <button type="button" class="link-btn" data-nav="orders">All orders</button></h3>${orderTableHtml(recent, true)}</section>`;
  }
  function buildMatrixHtml(product, stock) {
    const combos = allCombos(product);
    const sold = new Map();
    db.orders.forEach((o) => { if (o.productId === product.id && o.status !== "cancelled") { const k = comboKey(product, o.choices); sold.set(k, (sold.get(k) || 0) + o.qty); } });
    const cell = (choices) => {
      const b = buildable(product, choices, stock);
      const k = comboKey(product, choices);
      const n = b.n === null ? "—" : b.n;
      const cls = b.n === 0 ? " is-zero" : (b.n !== null && b.n <= 2 ? " is-low" : "");
      const limit = b.limit && b.n !== null ? "limit: " + partName(b.limit) : "no parts linked";
      return `<div class="matrix__cell${cls}" title="${escapeHtml(limit)}"><span class="matrix__n">${n}</span><span class="matrix__lbl">${escapeHtml(limit)}</span><span class="matrix__lbl">${sold.get(k) || 0} sold</span></div>`;
    };
    const opts = product.options.filter((o) => o.choices.length);
    if (opts.length === 2) {
      const [rows, cols] = opts[0].choices.length <= opts[1].choices.length ? [opts[0], opts[1]] : [opts[1], opts[0]];
      let html = `<div class="matrix" style="grid-template-columns: minmax(80px, auto) repeat(${cols.choices.length}, minmax(0, 1fr))"><span></span>`;
      html += cols.choices.map((c) => `<span class="matrix__head">${escapeHtml(c.label)}</span>`).join("");
      rows.choices.forEach((r) => {
        html += `<span class="matrix__row-head">${escapeHtml(r.label)}</span>`;
        html += cols.choices.map((c) => cell({ [rows.id]: r.id, [cols.id]: c.id })).join("");
      });
      return html + `</div>`;
    }
    return `<ul class="matrix-list">${combos.map((c) => `<li><div class="cell-sub">${escapeHtml(describeChoices(product, c) || "Standard")}</div>${cell(c)}</li>`).join("")}</ul>`;
  }
  function monthlyChartHtml() {
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"), label: d.toLocaleDateString(undefined, { month: "short" }), count: 0, revenue: 0 });
    }
    db.orders.forEach((o) => {
      if (o.status === "cancelled") return;
      const m = months.find((x) => x.key === o.date.slice(0, 7));
      if (m) { m.count += o.qty; m.revenue += o.price + o.shippingCharged; }
    });
    const max = Math.max(1, ...months.map((m) => m.revenue));
    const W = 720, H = 170, pad = 22, bw = (W - 20) / 12;
    const bars = months.map((m, i) => {
      const h = Math.round((m.revenue / max) * (H - pad * 2 - 10));
      const x = 10 + i * bw + 6, y = H - pad - h;
      return `<rect class="chart__bar${i === 11 ? " is-now" : ""}" x="${x}" y="${y}" width="${bw - 12}" height="${Math.max(h, m.revenue ? 2 : 0)}" rx="4"><title>${m.label}: ${m.count} sold, ${fmtMoney(m.revenue)}</title></rect>` +
        (m.count ? `<text class="chart__val" x="${x + (bw - 12) / 2}" y="${y - 5}" text-anchor="middle">${m.count}</text>` : "") +
        `<text class="chart__lbl" x="${x + (bw - 12) / 2}" y="${H - 5}" text-anchor="middle">${m.label}</text>`;
    }).join("");
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Units sold per month">${bars}</svg>`;
  }

  // ---------- Orders ----------
  function orderMatches(o, q) {
    if (!q) return true;
    const p = productById(o.productId);
    const hay = [o.customer, o.ref, o.platform, o.tracking, o.notes, o.serials.join(" "), p ? p.name : "", describeChoices(p, o.choices)].join(" ").toLowerCase();
    return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  }
  function ordersHtml() {
    const inFilter = (o) => orderFilter === "all" ? true : orderFilter === "done" ? ["closed", "cancelled"].includes(o.status) : ["open", "built", "shipped"].includes(o.status);
    const list = db.orders.filter((o) => inFilter(o) && orderMatches(o, orderQuery))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    const seg = ["open", "done", "all"].map((f) => `<button type="button" class="seg__btn${orderFilter === f ? " is-active" : ""}" data-order-filter="${f}">${{ open: "Open", done: "Completed", all: "All" }[f]}</button>`).join("");
    const head = pageHead("Orders", `${plural(db.orders.length, "order")} logged`,
      `<input class="search" id="orderSearch" type="search" placeholder="Search buyer, order #, serial…" value="${escapeHtml(orderQuery)}" />` +
      `<div class="seg seg--inline">${seg}</div><button type="button" class="btn btn--beacon" data-act="new-order">+ New order</button>`);
    if (!db.products.length) return head + `<div class="insight insight--warn"><span>🧩</span><span>Add a product first so orders know which parts to use. <button type="button" class="link-btn" data-nav="products">Set up products</button></span></div>`;
    if (!list.length) return head + `<p class="muted">No ${orderFilter === "open" ? "open " : ""}orders${orderQuery ? " match your search" : ""}.</p>`;
    const totals = list.reduce((s, o) => ({ rev: s.rev + o.price + o.shippingCharged, profit: s.profit + orderProfit(o) }), { rev: 0, profit: 0 });
    return head + orderTableHtml(list, false, totals);
  }
  function orderTableHtml(list, compact, totals) {
    if (!list.length) return `<p class="muted">No orders yet.</p>`;
    const rows = list.map((o) => {
      const p = productById(o.productId);
      const next = NEXT_ACTION[o.status];
      const profit = orderProfit(o);
      return `<tr data-row data-edit-order="${o.id}">
        <td class="mono">${escapeHtml(fmtShortDate(o.date))}<div class="cell-sub">${escapeHtml(o.date.slice(0, 4))}</div></td>
        <td><div class="cell-title">${escapeHtml(describeChoices(p, o.choices) || (p ? p.name : "—"))}${o.qty > 1 ? " ×" + o.qty : ""}</div>
            <div class="cell-sub">${escapeHtml([o.customer, o.platform, o.ref].filter(Boolean).join(" · "))}${o.historical ? " · past order" : ""}</div></td>
        <td class="mono hide-sm">${o.serials.length ? o.serials.map(escapeHtml).join(", ") : '<span class="muted">—</span>'}</td>
        <td><span class="pill ${STATUS_PILL[o.status]}">${STATUS_LABEL[o.status]}</span></td>
        <td class="num">${fmtMoney(o.price + o.shippingCharged)}</td>
        <td class="num hide-sm ${profit < 0 ? "neg" : ""}">${fmtMoney(profit)}</td>
        <td class="actions">${next && !compact ? `<button type="button" class="btn btn--tiny" data-advance="${o.id}">${next}</button>` : ""}</td>
      </tr>`;
    }).join("");
    const foot = totals ? `<tfoot><tr><td colspan="4">${plural(list.length, "order")}</td><td class="num">${fmtMoney(totals.rev)}</td><td class="num hide-sm">${fmtMoney(totals.profit)}</td><td></td></tr></tfoot>` : "";
    return `<div class="panel panel--flush table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Configuration / buyer</th><th class="hide-sm">Serial</th><th>Status</th><th class="num">Sale</th><th class="num hide-sm">Profit</th><th></th></tr></thead><tbody>${rows}</tbody>${foot}</table></div>`;
  }

  // ---------- Inventory ----------
  function stockPill(s) {
    const st = STOCK_STATUS[s.status];
    const label = s.available < 0 ? "Short " + fmtQty(-s.available) + (s.status === "waiting" ? " · incoming" : "") : st.label;
    return `<span class="pill ${st.pill}">${label}</span>`;
  }
  function inventoryHtml() {
    const stock = computeStock();
    const head = pageHead("Inventory", `${plural(db.parts.length, "part")} · stock value ${fmtMoney(stockValue())}`,
      `<button type="button" class="btn btn--ghost" data-act="new-purchase">+ Purchase</button><button type="button" class="btn btn--beacon" data-act="new-part">+ New part</button>`);
    if (!db.parts.length) return head + `<p class="muted">No parts yet. Add the raw materials you build with.</p>`;
    const list = db.parts.slice().sort((a, b) =>
      STOCK_STATUS[stock.get(a.id).status].rank - STOCK_STATUS[stock.get(b.id).status].rank ||
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    const rows = list.map((p) => {
      const s = stock.get(p.id);
      const orderBy = s.status === "soon" ? `<div class="cell-sub">order by ${fmtShortDate(s.orderBy)}</div>` : "";
      return `<tr data-row data-edit-part="${p.id}">
        <td><div class="cell-title">${escapeHtml(p.name)}</div><div class="cell-sub">${escapeHtml([p.category, p.sku, p.supplier].filter(Boolean).join(" · "))}</div></td>
        <td class="num">${fmtQty(s.onHand)}</td>
        <td class="num hide-sm">${s.committed ? fmtQty(s.committed) : '<span class="muted">0</span>'}</td>
        <td class="num hide-sm">${s.incoming ? "+" + fmtQty(s.incoming) : '<span class="muted">0</span>'}</td>
        <td class="num ${s.available < 0 ? "neg" : ""}"><strong>${fmtQty(s.available)}</strong></td>
        <td class="num hide-sm">${s.perMonth ? s.perMonth.toFixed(1) : '<span class="muted">0</span>'}</td>
        <td class="num hide-sm">${humanDays(s.cover)}</td>
        <td>${stockPill(s)}${orderBy}</td>
        <td class="actions"><button type="button" class="btn btn--tiny" data-adjust="${p.id}" title="Count or adjust stock">±</button></td>
      </tr>`;
    }).join("");
    return head + `<div class="panel panel--flush table-wrap"><table class="tbl"><thead><tr>
      <th>Part</th><th class="num">On hand</th><th class="num hide-sm">For orders</th><th class="num hide-sm">Incoming</th><th class="num">Available</th><th class="num hide-sm">Use / mo</th><th class="num hide-sm">Cover</th><th>Status</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <p class="field__hint"><strong>Available</strong> = on hand − parts promised to orders not built yet. <strong>Use / mo</strong> comes from orders sold in the last ${db.business.lookbackDays} days. A part is flagged when available + incoming falls to its reorder point, or won't last its lead time + ${db.business.bufferDays}-day buffer.</p>`;
  }

  // ---------- Restock ----------
  function restockHtml() {
    const stock = computeStock();
    const head = pageHead("Restock", "What to order, and by when", `<button type="button" class="btn btn--beacon" data-act="new-purchase">+ Purchase</button>`);
    const suggestions = db.parts.filter((p) => stock.get(p.id).suggest > 0)
      .sort((a, b) => STOCK_STATUS[stock.get(a.id).status].rank - STOCK_STATUS[stock.get(b.id).status].rank);
    let html = head;
    if (suggestions.length) {
      const bySupplier = new Map();
      suggestions.forEach((p) => { const k = p.supplier || ""; if (!bySupplier.has(k)) bySupplier.set(k, []); bySupplier.get(k).push(p); });
      html += `<section><h3 class="section-title">Suggested orders</h3>`;
      bySupplier.forEach((parts, supplier) => {
        const total = parts.reduce((s, p) => s + stock.get(p.id).suggest * p.unitCost, 0);
        const rows = parts.map((p) => {
          const s = stock.get(p.id);
          const link = p.url ? ` <a class="link-btn" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">link</a>` : "";
          return `<tr><td><div class="cell-title">${escapeHtml(p.name)}${link}</div><div class="cell-sub">${fmtQty(s.available)} available · ${s.perMonth.toFixed(1)}/mo · ${p.leadTimeDays}d lead</div></td>
            <td>${stockPill(s)}</td>
            <td class="num">${s.status === "soon" ? fmtShortDate(s.orderBy) : "Now"}</td>
            <td class="num"><strong>${fmtQty(s.suggest)}</strong> ${escapeHtml(p.unit)}</td>
            <td class="num hide-sm">${fmtMoney(s.suggest * p.unitCost)}</td></tr>`;
        }).join("");
        html += `<div class="panel panel--flush table-wrap" style="margin-bottom:10px"><table class="tbl"><thead><tr><th>${escapeHtml(supplier || "No supplier")}</th><th>Status</th><th class="num">Order by</th><th class="num">Qty</th><th class="num hide-sm">Est.</th></tr></thead>
          <tbody>${rows}</tbody><tfoot><tr><td colspan="4"><button type="button" class="btn btn--tiny btn--beacon" data-draft-po="${escapeHtml(supplier)}">Create purchase from these</button></td><td class="num hide-sm">${fmtMoney(total)}</td></tr></tfoot></table></div>`;
      });
      html += `</section>`;
    } else {
      html += `<div class="insight insight--good"><span>✅</span><span>Nothing to reorder right now. Parts appear here when they hit their reorder point or won't outlast their lead time.</span></div>`;
    }
    const pos = db.purchases.slice().sort((a, b) => (a.status === b.status ? b.date.localeCompare(a.date) : a.status === "ordered" ? -1 : 1));
    html += `<section><h3 class="section-title">Purchases</h3>`;
    if (!pos.length) return html + `<p class="muted">No purchases logged yet.</p></section>`;
    const rows = pos.map((po) => {
      const items = po.lines.map((l) => fmtQty(l.qty) + " × " + partName(l.partId)).join(", ");
      const due = po.status === "ordered" && po.expectedDate ? (daysUntil(po.expectedDate) < 0 ? `<span class="neg">late · ${fmtShortDate(po.expectedDate)}</span>` : "due " + fmtShortDate(po.expectedDate)) : "";
      return `<tr data-row data-edit-po="${po.id}">
        <td class="mono">${fmtShortDate(po.date)}<div class="cell-sub">${po.date.slice(0, 4)}</div></td>
        <td><div class="cell-title">${escapeHtml(po.supplier || "Purchase")}</div><div class="cell-sub">${escapeHtml(items)}</div></td>
        <td><span class="pill ${po.status === "ordered" ? "pill--info" : "pill--good"}">${po.status === "ordered" ? "Incoming" : "Received"}</span><div class="cell-sub">${po.status === "received" ? fmtShortDate(po.receivedDate) : due}</div></td>
        <td class="num">${fmtMoney(poTotal(po))}</td>
        <td class="actions">${po.status === "ordered" ? `<button type="button" class="btn btn--tiny" data-receive="${po.id}">Receive</button>` : ""}</td></tr>`;
    }).join("");
    return html + `<div class="panel panel--flush table-wrap"><table class="tbl"><thead><tr><th>Date</th><th>Supplier / items</th><th>Status</th><th class="num">Total</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  // ---------- Products (inline editor) ----------
  function partOptions(selected) {
    return `<option value="">— choose part —</option>` + db.parts.slice().sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<option value="${p.id}"${p.id === selected ? " selected" : ""}>${escapeHtml(p.name)}</option>`).join("");
  }
  function bomHtml(list, ctx) {
    const rows = list.map((b, i) => `<div class="bom-row">
        <select class="field__input field__input--sm" ${ctx} data-bom="${i}" data-field="partId">${partOptions(b.partId)}</select>
        <input class="field__input field__input--sm" type="number" min="0" step="any" value="${b.qty}" ${ctx} data-bom="${i}" data-field="qty" aria-label="Quantity" />
        <button type="button" class="mini-btn" data-pact="del-bom" ${ctx} data-bom="${i}" title="Remove">✕</button>
      </div>`).join("");
    return `<div class="bom">${rows || '<p class="bom__empty">No parts.</p>'}<button type="button" class="btn btn--tiny btn--ghost" style="align-self:flex-start" data-pact="add-bom" ${ctx}>+ Part</button></div>`;
  }
  function productsHtml() {
    const head = pageHead("Products", "What you sell, the options buyers choose, and the parts each uses",
      `<button type="button" class="btn btn--ghost" data-act="template">+ 1M template</button><button type="button" class="btn btn--beacon" data-pact="new-product">+ New product</button>`);
    if (!db.products.length) return head + `<p class="muted">No products yet.</p>`;
    const noParts = !db.parts.length ? `<div class="insight insight--warn"><span>📦</span><span>Add parts in <button type="button" class="link-btn" data-nav="inventory">Inventory</button> so you can link them here.</span></div>` : "";
    return head + noParts + db.products.map((p) => {
      const ctx = `data-prod="${p.id}"`;
      const unitCost = bomCost(unitBom(p, {}));
      const options = p.options.map((o) => {
        const octx = `${ctx} data-opt="${o.id}"`;
        const choices = o.choices.map((c) => {
          const cctx = `${octx} data-choice="${c.id}"`;
          return `<div class="choice"><div class="choice__head">
              <input class="field__input field__input--sm" value="${escapeHtml(c.label)}" ${cctx} data-field="label" aria-label="Choice name" />
              <button type="button" class="mini-btn" data-pact="del-choice" ${cctx} title="Remove choice">✕</button></div>
              ${bomHtml(c.bom, cctx)}</div>`;
        }).join("");
        return `<div class="option-block"><div class="option-block__head">
            <label class="field"><span class="field__label">Option buyers choose</span><input class="field__input" value="${escapeHtml(o.name)}" ${octx} data-field="name" /></label>
            <button type="button" class="btn btn--tiny btn--danger" data-pact="del-option" ${octx}>Remove option</button></div>
            <div class="choice-list">${choices}</div>
            <button type="button" class="btn btn--tiny btn--ghost" style="align-self:flex-start" data-pact="add-choice" ${octx}>+ Choice</button></div>`;
      }).join("");
      return `<section class="panel product-card">
        <div class="product-card__head">
          <label class="field field--icon"><span class="field__label">Icon</span><input class="field__input" maxlength="4" value="${escapeHtml(p.icon)}" ${ctx} data-field="icon" /></label>
          <label class="field"><span class="field__label">Product</span><input class="field__input" value="${escapeHtml(p.name)}" ${ctx} data-field="name" /></label>
          <button type="button" class="btn btn--tiny btn--danger" data-pact="del-product" ${ctx}>Delete</button>
        </div>
        <div class="product-card__grid">
          <label class="field"><span class="field__label">Default price ($)</span><input class="field__input" type="number" step="0.01" min="0" value="${p.price}" ${ctx} data-field="price" /></label>
          <label class="field"><span class="field__label">Serial prefix</span><input class="field__input field__input--mono" value="${escapeHtml(p.serialPrefix)}" ${ctx} data-field="serialPrefix" placeholder="e.g. 1M-" /></label>
          <label class="field"><span class="field__label">Digits</span><input class="field__input" type="number" min="0" max="8" step="1" value="${p.serialPad}" ${ctx} data-field="serialPad" /></label>
          <label class="field"><span class="field__label">Next serial #</span><input class="field__input" type="number" min="1" step="1" value="${p.nextSerial}" ${ctx} data-field="nextSerial" /></label>
        </div>
        <p class="field__hint">Next serial: <strong class="mono">${escapeHtml(fmtSerial(p, p.nextSerial))}</strong> · base parts cost ${fmtMoney(unitCost)} per unit (before options)</p>
        <div><h4 class="subhead">Every unit uses</h4>${bomHtml(p.baseBom, ctx)}</div>
        <div class="bom"><h4 class="subhead">Options</h4>${options || '<p class="bom__empty">No options — every unit is the same.</p>'}
          <button type="button" class="btn btn--tiny btn--ghost" style="align-self:flex-start" data-pact="add-option" ${ctx}>+ Option</button></div>
        <label class="field"><span class="field__label">Notes</span><textarea class="field__input field__input--area" rows="2" ${ctx} data-field="notes">${escapeHtml(p.notes)}</textarea></label>
      </section>`;
    }).join("");
  }
  function productCtx(d) {
    const p = productById(d.prod);
    if (!p) return {};
    const opt = d.opt ? p.options.find((o) => o.id === d.opt) : null;
    const choice = opt && d.choice ? opt.choices.find((c) => c.id === d.choice) : null;
    const bom = choice ? choice.bom : (d.opt ? null : p.baseBom);
    return { p, opt, choice, bom };
  }
  function onProductChange(t) {
    const d = t.dataset;
    const c = productCtx(d);
    if (!c.p) return;
    if (d.bom !== undefined) {
      const row = c.bom && c.bom[Number(d.bom)];
      if (!row) return;
      if (d.field === "partId") row.partId = t.value;
      else row.qty = Math.max(0, num(t.value, 1));
    } else if (c.choice) {
      c.choice.label = str(t.value, 60) || "Choice";
    } else if (c.opt) {
      c.opt.name = str(t.value, 60) || "Option";
    } else {
      const f = d.field;
      if (f === "price") c.p.price = Math.max(0, num(t.value));
      else if (f === "serialPad") c.p.serialPad = clamp(Math.round(num(t.value, 3)), 0, 8);
      else if (f === "nextSerial") c.p.nextSerial = Math.max(1, Math.round(num(t.value, 1)));
      else if (f === "name") c.p.name = str(t.value, 120) || "Untitled product";
      else if (f === "icon") c.p.icon = str(t.value, 8) || "📦";
      else if (f === "serialPrefix") c.p.serialPrefix = str(t.value, 20);
      else if (f === "notes") c.p.notes = str(t.value, 4000);
    }
    save();
    renderRail();
    // Re-render for fields that change derived text (serial preview, costs); keep typing flow otherwise.
    if (["partId", "qty", "serialPrefix", "serialPad", "nextSerial"].includes(d.field)) renderCanvas();
  }
  function onProductAction(b) {
    const d = b.dataset;
    if (d.pact === "new-product") {
      db.products.push(normalizeProduct({ name: "New product", options: [] }));
      save(); renderAll();
      el.canvas.scrollTop = el.canvas.scrollHeight;
      return;
    }
    const c = productCtx(d);
    if (!c.p) return;
    switch (d.pact) {
      case "add-bom": (c.bom || []).push({ partId: "", qty: 1 }); break;
      case "del-bom": c.bom.splice(Number(d.bom), 1); break;
      case "add-option": c.p.options.push({ id: uid(), name: "Option", choices: [{ id: uid(), label: "Choice A", bom: [] }] }); break;
      case "del-option":
        if (!confirm(`Remove the "${c.opt.name}" option? Existing orders keep their saved choice ids but will no longer show this option.`)) return;
        c.p.options = c.p.options.filter((o) => o !== c.opt); break;
      case "add-choice": c.opt.choices.push({ id: uid(), label: "New choice", bom: [] }); break;
      case "del-choice":
        if (db.orders.some((o) => o.productId === c.p.id && o.choices[c.opt.id] === c.choice.id) &&
            !confirm(`Some orders use "${c.choice.label}". Remove it anyway?`)) return;
        c.opt.choices = c.opt.choices.filter((x) => x !== c.choice); break;
      case "del-product": {
        const used = db.orders.filter((o) => o.productId === c.p.id).length;
        if (used) { alert(`${plural(used, "order")} use this product. Delete those orders first.`); return; }
        if (!confirm(`Delete "${c.p.name}"?`)) return;
        db.products = db.products.filter((x) => x !== c.p); break;
      }
      default: return;
    }
    save();
    renderAll();
  }

  // ---------- Serials ----------
  function duplicateSerials() {
    const seen = new Map();
    db.orders.forEach((o) => o.serials.forEach((s) => { const k = s.toLowerCase(); seen.set(k, (seen.get(k) || []).concat(s)); }));
    return [...seen.values()].filter((v) => v.length > 1).map((v) => v[0]);
  }
  function serialsHtml() {
    const rows = [];
    db.orders.forEach((o) => o.serials.forEach((s) => rows.push({ s, o })));
    const dupes = new Set(duplicateSerials().map((s) => s.toLowerCase()));
    rows.sort((a, b) => b.s.localeCompare(a.s, undefined, { numeric: true }));
    const summary = db.products.map((p) => {
      const nums = [];
      db.orders.forEach((o) => { if (o.productId === p.id) o.serials.forEach((s) => { const n = serialNumber(p, s); if (n !== null) nums.push(n); }); });
      const used = new Set(nums);
      const gaps = [];
      for (let n = 1; n < p.nextSerial && gaps.length < 40; n++) if (!used.has(n)) gaps.push(fmtSerial(p, n));
      return `<div class="panel"><div class="cell-title">${escapeHtml(p.icon)} ${escapeHtml(p.name)}</div>
        <div class="stats" style="margin-top:10px">${stat("Next serial", `<span class="mono">${escapeHtml(fmtSerial(p, p.nextSerial))}</span>`)}${stat("Recorded", used.size)}${stat("Unrecorded below next", gaps.length >= 40 ? "40+" : gaps.length)}</div>
        ${gaps.length ? `<p class="field__hint" style="margin-top:8px">Not linked to an order: <span class="mono">${gaps.map(escapeHtml).join(", ")}${gaps.length >= 40 ? "…" : ""}</span></p>` : ""}</div>`;
    }).join("");
    const head = pageHead("Serial numbers", `${plural(rows.length, "serial")} recorded`);
    const table = rows.length ? `<div class="panel panel--flush table-wrap"><table class="tbl"><thead><tr><th>Serial</th><th>Configuration</th><th>Buyer</th><th>Sold</th><th>Status</th></tr></thead><tbody>${
      rows.map(({ s, o }) => {
        const p = productById(o.productId);
        return `<tr data-row data-edit-order="${o.id}"><td class="mono ${dupes.has(s.toLowerCase()) ? "neg" : ""}"><strong>${escapeHtml(s)}</strong>${dupes.has(s.toLowerCase()) ? " ⚠ duplicate" : ""}</td>
          <td>${escapeHtml(describeChoices(p, o.choices) || (p ? p.name : "—"))}</td><td>${escapeHtml(o.customer || "—")}</td>
          <td class="mono">${fmtShortDate(o.date)} ${o.date.slice(0, 4)}</td><td><span class="pill ${STATUS_PILL[o.status]}">${STATUS_LABEL[o.status]}</span></td></tr>`;
      }).join("")}</tbody></table></div>` : `<p class="muted">No serials recorded yet. They're assigned automatically when you mark an order built, or you can type them on past orders.</p>`;
    return head + summary + table;
  }

  // ---------- Modals (shared) ----------
  const MODALS = ["orderModal", "partModal", "adjustModal", "poModal", "settingsModal", "aboutModal"];
  function openModal(id) { el[id].hidden = false; }
  function closeModals() { MODALS.forEach((id) => { el[id].hidden = true; }); }
  function anyModalOpen() { return MODALS.some((id) => !el[id].hidden); }

  // ---------- Order editor ----------
  function openOrderEditor(id) {
    if (!db.products.length) { toast("Add a product first."); setView("products"); return; }
    const o = id ? orderById(id) : null;
    editingOrderId = o ? o.id : null;
    const productId = o ? o.productId : db.products[0].id;
    el.orderTitle.textContent = o ? "Edit order" : "New order";
    el.oProduct.innerHTML = db.products.map((p) => `<option value="${p.id}">${escapeHtml(p.icon + " " + p.name)}</option>`).join("");
    el.oProduct.value = productId;
    const p = productById(productId);
    el.oStatus.value = o ? o.status : "open";
    el.oDate.value = o ? o.date : todayISO();
    el.oQty.value = o ? o.qty : 1;
    el.oPlatform.value = o ? o.platform : (db.orders.length ? db.orders[db.orders.length - 1].platform : "eBay");
    el.oCustomer.value = o ? o.customer : "";
    el.oRef.value = o ? o.ref : "";
    el.oPrice.value = o ? o.price : (p ? p.price : "");
    el.oShipCharged.value = o ? o.shippingCharged : (p && p.shipping ? p.shipping : 0);
    el.oShipCost.value = o ? o.shippingCost : "";
    el.oFees.value = o ? o.fees : (p ? estimateFees(p.price, p.shipping) : "");
    el.oSerials.value = o ? o.serials.join(", ") : "";
    el.oTracking.value = o ? o.tracking : "";
    el.oHistorical.checked = o ? o.historical : false;
    el.oNotes.value = o ? o.notes : "";
    el.oDelete.hidden = !o;
    renderOrderOptions(o ? o.choices : null);
    updateOrderPreview();
    openModal("orderModal");
    setTimeout(() => (o ? el.oCustomer : el.oOptions.querySelector("select") || el.oCustomer).focus(), 30);
  }
  function renderOrderOptions(choices) {
    const p = productById(el.oProduct.value);
    if (!p) { el.oOptions.innerHTML = ""; return; }
    el.oOptions.innerHTML = p.options.map((opt) => {
      const sel = (choices && choices[opt.id]) || (opt.choices[0] ? opt.choices[0].id : "");
      return `<label class="field"><span class="field__label">${escapeHtml(opt.name)}</span><select class="field__input" data-order-opt="${opt.id}">` +
        opt.choices.map((c) => `<option value="${c.id}"${c.id === sel ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("") +
        `</select></label>`;
    }).join("");
    el.oOptions.hidden = !p.options.length;
  }
  function readOrderForm() {
    const choices = {};
    el.oOptions.querySelectorAll("[data-order-opt]").forEach((s) => { choices[s.dataset.orderOpt] = s.value; });
    return normalizeOrder({
      id: editingOrderId || undefined,
      productId: el.oProduct.value,
      choices,
      qty: el.oQty.value,
      date: el.oDate.value,
      status: el.oStatus.value,
      historical: el.oHistorical.checked,
      customer: el.oCustomer.value.trim(),
      platform: el.oPlatform.value.trim(),
      ref: el.oRef.value.trim(),
      price: el.oPrice.value,
      shippingCharged: el.oShipCharged.value,
      shippingCost: el.oShipCost.value,
      fees: el.oFees.value,
      serials: parseSerials(el.oSerials.value),
      tracking: el.oTracking.value.trim(),
      notes: el.oNotes.value,
    });
  }
  function updateOrderPreview() {
    const draft = readOrderForm();
    const stock = computeStock();
    const existing = editingOrderId ? orderById(editingOrderId) : null;
    const alreadyCounted = existing && !existing.historical && existing.status !== "cancelled" ? orderBom(existing) : new Map();
    const bom = orderBom(draft);
    const lines = [];
    bom.forEach((q, id) => {
      const s = stock.get(id);
      const avail = s ? s.available + (alreadyCounted.get(id) || 0) : 0;
      lines.push(`<li>${fmtQty(q)} × ${escapeHtml(partName(id))} <span class="${avail < q ? "neg" : "muted"}">(${fmtQty(avail)} available)</span></li>`);
    });
    const cost = bomCost(bom);
    const profit = draft.price + draft.shippingCharged - draft.fees - draft.shippingCost - cost;
    const dupes = draft.serials.filter((s) => usedSerials(editingOrderId).has(s.toLowerCase()));
    let msg;
    if (draft.historical) msg = "Past order: counts toward sales, profit and usage forecasts, but won't change stock.";
    else if (CONSUMING.has(draft.status)) msg = "These parts are deducted from stock:";
    else if (draft.status === "open") msg = "These parts are reserved now and deducted when you mark it built:";
    else msg = "Cancelled: no parts used.";
    el.oPreview.innerHTML = `<div>${msg}</div>` + (lines.length && draft.status !== "cancelled" ? `<ul>${lines.join("")}</ul>` : "") +
      `<div style="margin-top:6px">Parts ${fmtMoney(cost)} · est. profit <strong class="${profit < 0 ? "neg" : ""}">${fmtMoney(profit)}</strong></div>` +
      (dupes.length ? `<div class="neg" style="margin-top:6px">⚠ Serial already used: ${dupes.map(escapeHtml).join(", ")}</div>` : "");
  }
  function saveOrder(e) {
    e.preventDefault();
    const draft = readOrderForm();
    if (!productById(draft.productId)) { toast("Pick a product."); return; }
    const existing = editingOrderId ? orderById(editingOrderId) : null;
    if (existing) {
      draft.createdAt = existing.createdAt;
      ["builtAt", "shippedAt", "closedAt"].forEach((k) => { draft[k] = existing[k]; });
      if (!CONSUMING.has(draft.status)) draft.builtAt = "";
      db.orders[db.orders.indexOf(existing)] = draft;
    } else {
      db.orders.push(draft);
    }
    const today = todayISO();
    if (draft.status === "shipped" && !draft.shippedAt) draft.shippedAt = today;
    if (draft.status === "closed" && !draft.closedAt) draft.closedAt = draft.historical ? draft.date : today;
    finalizeOrder(draft);
    save();
    closeModals();
    renderAll();
    const short = draft.historical ? [] : shortagesAfter(draft);
    toast((existing ? "Order updated." : "Order added.") + (draft.serials.length ? " Serial " + draft.serials.join(", ") + "." : "") + (short.length ? " ⚠ Stock went negative: " + short.join(", ") : ""));
  }
  function deleteOrder() {
    const o = orderById(editingOrderId);
    if (!o || !confirm("Delete this order? Any parts it used go back into stock.")) return;
    db.orders = db.orders.filter((x) => x !== o);
    db.moves = db.moves.filter((m) => m.ref !== "order:" + o.id);
    save();
    closeModals();
    renderAll();
    toast("Order deleted.");
  }

  // ---------- Part editor ----------
  function fillDatalists() {
    el.categoryList.innerHTML = uniqueSorted(db.parts.map((p) => p.category)).map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
    el.supplierList.innerHTML = uniqueSorted(db.parts.map((p) => p.supplier).concat(db.purchases.map((p) => p.supplier))).map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
  }
  function openPartEditor(id) {
    const p = id ? partById(id) : null;
    editingPartId = p ? p.id : null;
    fillDatalists();
    el.partTitle.textContent = p ? "Edit part" : "New part";
    el.pName.value = p ? p.name : "";
    el.pCategory.value = p ? p.category : "";
    el.pSku.value = p ? p.sku : "";
    el.pUnit.value = p ? p.unit : "pcs";
    el.pCost.value = p ? p.unitCost : "";
    el.pReorderPoint.value = p ? p.reorderPoint : 5;
    el.pReorderQty.value = p ? p.reorderQty : 20;
    el.pLead.value = p ? p.leadTimeDays : 14;
    el.pSupplier.value = p ? p.supplier : "";
    el.pUrl.value = p ? p.url : "";
    el.pNotes.value = p ? p.notes : "";
    el.pStart.value = 0;
    el.pStartWrap.hidden = !!p;
    el.pDelete.hidden = !p;
    el.pHistory.innerHTML = p ? partHistoryHtml(p) : "";
    openModal("partModal");
    setTimeout(() => el.pName.focus(), 30);
  }
  function partHistoryHtml(p) {
    const moves = db.moves.filter((m) => m.partId === p.id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25);
    if (!moves.length) return "";
    const label = { adjust: "Adjusted", count: "Counted", build: "Built order", receive: "Received" };
    return `<div class="field"><span class="field__label">Stock history</span><ul class="history">${moves.map((m) => {
      const o = m.ref.startsWith("order:") ? orderById(m.ref.slice(6)) : null;
      const what = o && o.serials.length ? label[m.kind] + " " + o.serials.join(", ") : label[m.kind];
      const del = m.kind === "adjust" || m.kind === "count" ? `<button type="button" class="mini-btn" data-del-move="${m.id}" title="Undo">✕</button>` : "<span></span>";
      return `<li class="history__item"><span class="history__date">${fmtShortDate(m.date)}</span><span class="history__text"><strong>${escapeHtml(what)}</strong>${m.note ? " · " + escapeHtml(m.note) : ""}</span><span class="history__delta${m.delta < 0 ? " is-back" : ""}">${m.delta > 0 ? "+" : ""}${fmtQty(m.delta)}</span>${del}</li>`;
    }).join("")}</ul></div>`;
  }
  function savePart(e) {
    e.preventDefault();
    const fields = {
      name: el.pName.value.trim(), category: el.pCategory.value.trim(), sku: el.pSku.value.trim(), unit: el.pUnit.value.trim() || "pcs",
      unitCost: el.pCost.value, reorderPoint: el.pReorderPoint.value, reorderQty: el.pReorderQty.value, leadTimeDays: el.pLead.value,
      supplier: el.pSupplier.value.trim(), url: el.pUrl.value.trim(), notes: el.pNotes.value,
    };
    if (!fields.name) { el.pName.focus(); return; }
    const existing = editingPartId ? partById(editingPartId) : null;
    if (existing) {
      Object.assign(existing, normalizePart(Object.assign({ id: existing.id }, fields)));
    } else {
      const p = normalizePart(fields);
      db.parts.push(p);
      const start = num(el.pStart.value);
      if (start) db.moves.push({ id: uid(), date: todayISO(), partId: p.id, delta: start, kind: "count", ref: "", note: "Opening count" });
    }
    save();
    closeModals();
    renderAll();
    toast(existing ? "Part updated." : "Part added.");
  }
  function deletePart() {
    const p = partById(editingPartId);
    if (!p) return;
    const inBom = db.products.some((pr) => pr.baseBom.some((b) => b.partId === p.id) || pr.options.some((o) => o.choices.some((c) => c.bom.some((b) => b.partId === p.id))));
    const msg = `Delete "${p.name}"?` + (inBom ? " It will be removed from product parts lists." : "") + " Its stock history is deleted too.";
    if (!confirm(msg)) return;
    const strip = (list) => list.filter((b) => b.partId !== p.id);
    db.products.forEach((pr) => {
      pr.baseBom = strip(pr.baseBom);
      pr.options.forEach((o) => o.choices.forEach((c) => { c.bom = strip(c.bom); }));
    });
    db.purchases.forEach((po) => { po.lines = strip(po.lines); });
    db.moves = db.moves.filter((m) => m.partId !== p.id);
    db.parts = db.parts.filter((x) => x !== p);
    save();
    closeModals();
    renderAll();
    toast("Part deleted.");
  }
  function deleteMove(id) {
    db.moves = db.moves.filter((m) => m.id !== id);
    save();
    renderAll();
    const p = partById(editingPartId);
    if (p) el.pHistory.innerHTML = partHistoryHtml(p);
  }

  // ---------- Adjust stock ----------
  function openAdjust(id) {
    const p = partById(id);
    if (!p) return;
    adjustPartId = id;
    const s = computeStock().get(id);
    el.adjustTitle.textContent = p.name;
    el.aInfo.textContent = `On hand: ${fmtQty(s.onHand)} ${p.unit}` + (s.committed ? ` · ${fmtQty(s.committed)} reserved for open orders` : "");
    setAdjustMode("count");
    el.aAmount.value = "";
    el.aDate.value = todayISO();
    el.aNote.value = "";
    openModal("adjustModal");
    setTimeout(() => el.aAmount.focus(), 30);
  }
  function setAdjustMode(mode) {
    adjustMode = mode;
    el.aMode.querySelectorAll(".seg__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === mode));
    el.aAmountLabel.textContent = mode === "count" ? "Counted on hand" : "Change (+ added, − used/broken)";
  }
  function saveAdjust(e) {
    e.preventDefault();
    const p = partById(adjustPartId);
    if (!p || el.aAmount.value === "") return;
    const amount = num(el.aAmount.value);
    const onHand = computeStock().get(p.id).onHand;
    const delta = adjustMode === "count" ? amount - onHand : amount;
    if (!delta) { closeModals(); toast("No change."); return; }
    db.moves.push({ id: uid(), date: el.aDate.value || todayISO(), partId: p.id, delta, kind: adjustMode === "count" ? "count" : "adjust", ref: "", note: el.aNote.value.trim() });
    save();
    closeModals();
    renderAll();
    toast(`${p.name}: ${delta > 0 ? "+" : ""}${fmtQty(delta)} → ${fmtQty(onHand + delta)} on hand.`);
  }

  // ---------- Purchase editor ----------
  function openPurchaseEditor(id, preset) {
    const po = id ? purchaseById(id) : null;
    poDraft = po ? JSON.parse(JSON.stringify(po)) : normalizePurchase(Object.assign({ date: todayISO(), lines: [] }, preset || {}));
    if (!poDraft.lines.length) poDraft.lines.push({ partId: "", qty: 1, unitCost: 0 });
    fillDatalists();
    el.poTitle.textContent = po ? "Edit purchase" : "New purchase";
    el.poSupplier.value = poDraft.supplier;
    el.poRef.value = poDraft.ref;
    el.poDate.value = poDraft.date;
    el.poExpected.value = poDraft.expectedDate;
    el.poStatus.value = poDraft.status;
    el.poShipping.value = poDraft.shippingCost || "";
    el.poNotes.value = poDraft.notes;
    el.poDelete.hidden = !po;
    renderPoLines();
    openModal("poModal");
  }
  function renderPoLines() {
    el.poLines.innerHTML = poDraft.lines.map((l, i) => `<div class="po-line">
      <select class="field__input field__input--sm" data-line="${i}" data-field="partId">${partOptions(l.partId)}</select>
      <input class="field__input field__input--sm" type="number" min="0" step="any" value="${l.qty}" data-line="${i}" data-field="qty" aria-label="Quantity" />
      <input class="field__input field__input--sm" type="number" min="0" step="0.01" value="${l.unitCost}" data-line="${i}" data-field="unitCost" aria-label="Cost each" title="Cost each" />
      <button type="button" class="mini-btn" data-del-line="${i}" title="Remove">✕</button></div>`).join("");
    updatePoTotal();
  }
  function updatePoTotal() {
    poDraft.shippingCost = Math.max(0, num(el.poShipping.value));
    el.poTotal.textContent = "Total " + fmtMoney(poTotal(poDraft));
  }
  function draftPurchaseFor(supplier) {
    const stock = computeStock();
    const lines = db.parts.filter((p) => (p.supplier || "") === supplier && stock.get(p.id).suggest > 0)
      .map((p) => ({ partId: p.id, qty: stock.get(p.id).suggest, unitCost: p.unitCost }));
    const lead = Math.max(0, ...lines.map((l) => partById(l.partId).leadTimeDays));
    openPurchaseEditor(null, { supplier, lines, expectedDate: isoOffset(lead) });
  }
  function savePurchase(e) {
    e.preventDefault();
    const existing = poDraft.id ? purchaseById(poDraft.id) : null;
    const po = normalizePurchase(Object.assign({}, poDraft, {
      supplier: el.poSupplier.value.trim(), ref: el.poRef.value.trim(), date: el.poDate.value, expectedDate: el.poExpected.value,
      status: el.poStatus.value, shippingCost: el.poShipping.value, notes: el.poNotes.value,
      lines: poDraft.lines.filter((l) => l.partId && l.qty > 0),
    }));
    if (!po.lines.length) { toast("Add at least one item."); return; }
    if (po.status === "received" && !po.receivedDate) po.receivedDate = todayISO();
    if (po.status === "ordered") po.receivedDate = "";
    if (po.status === "received" && (!existing || existing.status !== "received")) applyPurchaseCosts(po);
    if (existing) db.purchases[db.purchases.indexOf(existing)] = po;
    else db.purchases.push(po);
    syncPurchaseMoves(po);
    save();
    closeModals();
    renderAll();
    toast(po.status === "received" ? "Purchase saved and added to stock." : "Purchase saved — shown as incoming.");
  }
  function deletePurchase() {
    const po = purchaseById(poDraft.id);
    if (!po || !confirm("Delete this purchase?" + (po.status === "received" ? " Its items are removed from stock." : ""))) return;
    db.purchases = db.purchases.filter((x) => x !== po);
    db.moves = db.moves.filter((m) => m.ref !== "po:" + po.id);
    save();
    closeModals();
    renderAll();
    toast("Purchase deleted.");
  }

  // ---------- Theme / atmosphere ----------
  function getThemePref() {
    const pref = localStorage.getItem(THEME_KEY);
    return pref === "day" || pref === "twilight" || pref === "night" || pref === "random" ? pref : DEFAULT_THEME;
  }
  function applyThemeClass(mode) {
    const root = document.documentElement;
    root.classList.remove("day", "twilight");
    if (mode === "day") root.classList.add("day");
    else if (mode === "twilight") root.classList.add("twilight");
  }
  function setTheme(pref) {
    localStorage.setItem(THEME_KEY, pref);
    if (pref === "random") {
      const active = THEMES[Math.floor(Math.random() * THEMES.length)];
      sessionStorage.setItem(ACTIVE_THEME_KEY, active);
      applyThemeClass(active);
    } else {
      sessionStorage.removeItem(ACTIVE_THEME_KEY);
      applyThemeClass(pref);
    }
    updateThemePicker();
  }
  function updateThemePicker() {
    const pref = getThemePref();
    el.themePicker.querySelectorAll(".theme-chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.themeVal === pref);
    });
  }

  // ---------- Settings / About ----------
  function openSettings() {
    updateThemePicker();
    const b = db.business;
    el.bName.value = b.name;
    el.bFeePct.value = b.feePct;
    el.bFeeFixed.value = b.feeFixed;
    el.bBuffer.value = b.bufferDays;
    el.bLookback.value = b.lookbackDays;
    openModal("settingsModal");
  }
  function saveBusiness() {
    db.business = normalizeBusiness({
      name: el.bName.value.trim(), feePct: el.bFeePct.value, feeFixed: el.bFeeFixed.value,
      bufferDays: el.bBuffer.value, lookbackDays: el.bLookback.value,
    });
    save();
    renderAll();
  }
  function openAbout() { closeModals(); openModal("aboutModal"); }
  function initVersion() {
    el.appVersion.textContent = "v" + APP_VERSION;
    el.aboutVersion.textContent = "Version " + APP_VERSION;
  }

  // ---------- Unified backup (Kashikoi suite schema) ----------
  function createVirgaBackupData() {
    return Object.assign({ version: 1, appName: "Virga", exportedAt: new Date().toISOString(), theme: getThemePref() }, JSON.parse(JSON.stringify(db)));
  }

  // Preserves every other app's slice so saving from Virga never clobbers the sister apps.
  function getExistingBackupApps(existingBackup) {
    if (!existingBackup || typeof existingBackup !== "object") return {};
    if (existingBackup.schema === UNIFIED_BACKUP_SCHEMA && existingBackup.apps && typeof existingBackup.apps === "object") {
      return Object.assign({}, existingBackup.apps);
    }
    if (existingBackup.appName === "Nimbus" || Array.isArray(existingBackup.tabs)) return { nimbus: existingBackup };
    if (existingBackup.appName === "Cumulus" || Array.isArray(existingBackup.accounts)) return { cumulus: existingBackup };
    if (existingBackup.appName === "Cirrus" || Array.isArray(existingBackup.movies)) return { cirrus: existingBackup };
    if (existingBackup.appName === "Stratus" || Array.isArray(existingBackup.stamps)) return { stratus: existingBackup };
    if (existingBackup.appName === "Anvil" || Array.isArray(existingBackup.runbooks)) return { anvil: existingBackup };
    if (existingBackup.appName === "Arcus" || Array.isArray(existingBackup.goals)) return { arcus: existingBackup };
    if (existingBackup.appName === "Virga" || (Array.isArray(existingBackup.parts) && Array.isArray(existingBackup.orders))) return { virga: existingBackup };
    return {};
  }

  function createBackupData(existingBackup) {
    const apps = getExistingBackupApps(existingBackup);
    apps.virga = createVirgaBackupData();
    return {
      schema: UNIFIED_BACKUP_SCHEMA,
      version: 1,
      appName: "Kashikoi Apps",
      exportedAt: new Date().toISOString(),
      apps,
    };
  }

  function normalizeBackupData(data) {
    if (!data || typeof data !== "object") throw new Error("Invalid format");
    const virga = data.schema === UNIFIED_BACKUP_SCHEMA && data.apps ? data.apps.virga : data;
    if (!virga || typeof virga !== "object" || !Array.isArray(virga.parts) || !Array.isArray(virga.orders)) throw new Error("No Virga data");
    return { db: sanitizeDb(virga), theme: typeof virga.theme === "string" ? virga.theme : null };
  }

  function applyRestoredData(imported, sourceLabel) {
    const d = imported.db;
    const summary = `${plural(d.parts.length, "part")}, ${plural(d.products.length, "product")} and ${plural(d.orders.length, "order")}`;
    if (!confirm(`Restore ${summary} from ${sourceLabel}? This replaces your current Virga data.`)) return false;
    db = d;
    if (imported.theme && ["day", "twilight", "night", "random"].includes(imported.theme)) setTheme(imported.theme);
    save();
    renderAll();
    return true;
  }

  function downloadBackup(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportJSON() {
    downloadBackup(createBackupData(), "virga-backup-" + todayISO() + ".json");
    toast("Backup exported.");
  }
  function importJSON(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const imported = normalizeBackupData(JSON.parse(reader.result));
        if (applyRestoredData(imported, "backup file")) { closeModals(); toast("Backup imported."); }
      } catch (e) {
        toast("That file doesn't contain Virga data.");
      }
      el.importFile.value = "";
    };
    reader.readAsText(file);
  }

  // ---------- Encrypted cloud sync (zero-knowledge, shared worker) ----------
  function getCloudPhrase() {
    return el.cloudPhrase.value.trim().replace(/\s+/g, " ");
  }
  function setCloudStatus(msg, kind) {
    el.cloudStatus.textContent = msg || "";
    el.cloudStatus.className = "cloud-data-status" + (kind ? " cloud-data-status--" + kind : "");
  }
  function createRecoveryPhrase() {
    const idx = new Uint32Array(RECOVERY_PHRASE_WORD_COUNT);
    crypto.getRandomValues(idx);
    return [...idx].map((n) => RECOVERY_WORDS[n % RECOVERY_WORDS.length]).join(" ");
  }
  function generateCloudPhrase() {
    if (getCloudPhrase() && !confirm("Replace the phrase in the box with a brand-new one? If you already use a phrase in your other cloud apps, use that instead so they share one backup.")) return;
    el.cloudPhrase.value = createRecoveryPhrase();
    el.cloudPhrase.type = "text";
    el.togglePhraseBtn.textContent = "Hide";
    el.togglePhraseBtn.setAttribute("aria-pressed", "true");
    el.cloudPhraseOut.hidden = false;
    el.cloudPhraseOut.textContent = "Write these 16 words down. They are the ONLY key to your cloud backup — they can't be recovered.";
    saveRememberedPhrase();
    setCloudStatus("New recovery phrase created. Save to cloud to use it.", "info");
  }
  function togglePhraseVisibility() {
    const show = el.cloudPhrase.type === "password";
    el.cloudPhrase.type = show ? "text" : "password";
    el.togglePhraseBtn.textContent = show ? "Hide" : "Show";
    el.togglePhraseBtn.setAttribute("aria-pressed", String(show));
  }
  function saveRememberedPhrase() {
    if (el.rememberPhrase.checked && getCloudPhrase()) localStorage.setItem(REMEMBER_CLOUD_PHRASE_KEY, getCloudPhrase());
    else if (!el.rememberPhrase.checked) localStorage.removeItem(REMEMBER_CLOUD_PHRASE_KEY);
  }
  function loadRememberedPhrase() {
    const saved = localStorage.getItem(REMEMBER_CLOUD_PHRASE_KEY) || "";
    if (!saved) return;
    el.cloudPhrase.value = saved;
    el.rememberPhrase.checked = true;
  }
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function getCloudSyncKey(phrase) {
    return sha256Hex("kashikoi-cloud-sync-v1:" + phrase);
  }
  async function deriveCloudKey(phrase, salt) {
    const phraseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(phrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: CLOUD_KDF_ITERATIONS },
      phraseKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  async function encryptCloudBackup(phrase, backupData) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveCloudKey(phrase, salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(backupData));
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return {
      app: CLOUD_ENVELOPE_APP,
      writtenBy: "Virga",
      format: CLOUD_SYNC_FORMAT,
      updatedAt: new Date().toISOString(),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: CLOUD_KDF_ITERATIONS, salt: arrayBufferToBase64(salt) },
      cipher: { name: "AES-GCM", iv: arrayBufferToBase64(iv) },
      payload: arrayBufferToBase64(encrypted),
    };
  }
  async function decryptCloudBackup(phrase, envelope) {
    if (!envelope || typeof envelope !== "object" || !ACCEPTED_ENVELOPE_APPS.has(envelope.app) ||
        (envelope.format !== CLOUD_SYNC_FORMAT && envelope.format !== LEGACY_CLOUD_SYNC_FORMAT) ||
        !envelope.kdf || !envelope.cipher || typeof envelope.payload !== "string") {
      throw new Error("Invalid envelope");
    }
    const salt = new Uint8Array(base64ToArrayBuffer(envelope.kdf.salt));
    const iv = new Uint8Array(base64ToArrayBuffer(envelope.cipher.iv));
    const key = await deriveCloudKey(phrase, salt);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64ToArrayBuffer(envelope.payload));
    return JSON.parse(new TextDecoder().decode(decrypted));
  }
  async function fetchEncryptedBackupAtKey(syncKey) {
    const bust = Date.now() + "-" + Math.random().toString(36).slice(2);
    const response = await fetch(`${CLOUD_SYNC_ENDPOINT}/sync/${syncKey}?t=${bust}`, { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("HTTP " + response.status);
    return response.json();
  }
  async function createMergedCloudBackup(phrase) {
    const syncKey = await getCloudSyncKey(phrase);
    let existingBackup = null;
    const envelope = await fetchEncryptedBackupAtKey(syncKey);
    if (envelope) {
      try {
        existingBackup = await decryptCloudBackup(phrase, envelope);
      } catch (e) {
        throw new Error("decrypt-existing");
      }
    }
    return { syncKey, backup: createBackupData(existingBackup) };
  }
  async function saveCloudData() {
    const phrase = getCloudPhrase();
    if (!phrase) { setCloudStatus("Enter or create a recovery phrase first.", "error"); return; }
    setCloudStatus("Encrypting and saving cloud backup…", "info");
    try {
      const merged = await createMergedCloudBackup(phrase);
      const envelope = await encryptCloudBackup(phrase, merged.backup);
      const response = await fetch(`${CLOUD_SYNC_ENDPOINT}/sync/${merged.syncKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      saveRememberedPhrase();
      setCloudStatus("Saved to cloud. Use the same phrase to restore on another device.", "success");
    } catch (error) {
      if (error && error.message === "decrypt-existing") {
        setCloudStatus("A different cloud backup exists for this phrase and couldn't be decrypted. Check the phrase.", "error");
      } else {
        setCloudStatus("Could not save to cloud. Your local Virga data is still safe here.", "error");
      }
    }
  }
  async function loadCloudData() {
    const phrase = getCloudPhrase();
    if (!phrase) { setCloudStatus("Enter your recovery phrase first.", "error"); return; }
    setCloudStatus("Loading encrypted cloud backup…", "info");
    let data;
    try {
      const syncKey = await getCloudSyncKey(phrase);
      const envelope = await fetchEncryptedBackupAtKey(syncKey);
      if (!envelope) { setCloudStatus("No cloud backup exists for this phrase yet. Save from your first device first.", "error"); return; }
      data = await decryptCloudBackup(phrase, envelope);
    } catch (error) {
      setCloudStatus("Could not decrypt cloud backup. Check the phrase or try again later.", "error");
      return;
    }
    let imported;
    try {
      imported = normalizeBackupData(data);
    } catch (e) {
      setCloudStatus("This cloud backup has no Virga data yet. Save to cloud from Virga first.", "error");
      return;
    }
    saveRememberedPhrase();
    if (applyRestoredData(imported, "encrypted cloud sync")) setCloudStatus("Restored from cloud.", "success");
    else setCloudStatus("Cloud restore cancelled.", "info");
  }

  // ---------- Events ----------
  function onCanvasClick(e) {
    const btn = e.target.closest("button, a, [data-row]");
    if (!btn || btn.tagName === "A") return;
    const d = btn.dataset;
    if (d.nav) return setView(d.nav);
    if (d.pact) return onProductAction(btn);
    if (d.advance) return advanceOrder(d.advance);
    if (d.adjust) return openAdjust(d.adjust);
    if (d.receive) return receivePurchase(d.receive);
    if (d.draftPo !== undefined) return draftPurchaseFor(d.draftPo);
    if (d.orderFilter) { orderFilter = d.orderFilter; return renderCanvas(); }
    if (d.editOrder) return openOrderEditor(d.editOrder);
    if (d.editPart) return openPartEditor(d.editPart);
    if (d.editPo) return openPurchaseEditor(d.editPo);
    switch (d.act) {
      case "new-order": return openOrderEditor(null);
      case "new-part": return openPartEditor(null);
      case "new-purchase": return openPurchaseEditor(null);
      case "template": return addTemplate();
      case "demo": return randomizeData();
    }
  }

  function bindEvents() {
    el.canvas.addEventListener("click", onCanvasClick);
    el.canvas.addEventListener("change", (e) => {
      if (e.target.dataset.prod) onProductChange(e.target);
    });
    el.canvas.addEventListener("input", (e) => {
      if (e.target.id === "orderSearch") {
        orderQuery = e.target.value;
        const pos = e.target.selectionStart;
        renderCanvas();
        const s = $("orderSearch");
        s.focus();
        s.setSelectionRange(pos, pos);
      }
    });
    el.navList.addEventListener("click", (e) => { const b = e.target.closest("[data-nav]"); if (b) setView(b.dataset.nav); });
    el.crumb.addEventListener("click", (e) => { const b = e.target.closest("[data-nav]"); if (b) setView(b.dataset.nav); });
    el.newOrderBtn.addEventListener("click", () => openOrderEditor(null));
    el.topNewOrderBtn.addEventListener("click", () => openOrderEditor(null));

    // Modal close (backdrop, ✕, Cancel)
    MODALS.forEach((id) => el[id].addEventListener("click", (e) => { if (e.target.closest("[data-close]")) el[id].hidden = true; }));

    // Order editor
    el.orderForm.addEventListener("submit", saveOrder);
    el.orderForm.addEventListener("input", updateOrderPreview);
    el.orderForm.addEventListener("change", updateOrderPreview);
    el.oProduct.addEventListener("change", () => {
      const p = productById(el.oProduct.value);
      renderOrderOptions(null);
      if (p && !editingOrderId) { el.oPrice.value = p.price; el.oFees.value = estimateFees(p.price, el.oShipCharged.value); }
      updateOrderPreview();
    });
    el.oFeeEstimate.addEventListener("click", () => { el.oFees.value = estimateFees(el.oPrice.value, el.oShipCharged.value); updateOrderPreview(); });
    el.oSerialAuto.addEventListener("click", () => {
      const p = productById(el.oProduct.value);
      if (!p) return;
      el.oSerials.value = nextSerialsFor(p, Math.max(1, Math.round(num(el.oQty.value, 1))), editingOrderId).join(", ");
      updateOrderPreview();
    });
    el.oDelete.addEventListener("click", deleteOrder);

    // Part editor
    el.partForm.addEventListener("submit", savePart);
    el.pDelete.addEventListener("click", deletePart);
    el.pHistory.addEventListener("click", (e) => { const b = e.target.closest("[data-del-move]"); if (b) deleteMove(b.dataset.delMove); });

    // Adjust
    el.adjustForm.addEventListener("submit", saveAdjust);
    el.aMode.addEventListener("click", (e) => { const b = e.target.closest("[data-mode]"); if (b) setAdjustMode(b.dataset.mode); });

    // Purchases
    el.poForm.addEventListener("submit", savePurchase);
    el.poDelete.addEventListener("click", deletePurchase);
    el.poAddLine.addEventListener("click", () => { poDraft.lines.push({ partId: "", qty: 1, unitCost: 0 }); renderPoLines(); });
    el.poShipping.addEventListener("input", updatePoTotal);
    el.poLines.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.line === undefined) return;
      const line = poDraft.lines[Number(t.dataset.line)];
      if (t.dataset.field === "partId") {
        line.partId = t.value;
        const p = partById(t.value);
        if (p) { line.unitCost = p.unitCost; if (!el.poSupplier.value && p.supplier) el.poSupplier.value = p.supplier; }
        renderPoLines();
      } else {
        line[t.dataset.field] = Math.max(0, num(t.value));
        updatePoTotal();
      }
    });
    el.poLines.addEventListener("click", (e) => {
      const b = e.target.closest("[data-del-line]");
      if (!b) return;
      poDraft.lines.splice(Number(b.dataset.delLine), 1);
      renderPoLines();
    });

    // Settings
    el.settingsBtn.addEventListener("click", openSettings);
    el.themePicker.addEventListener("click", (e) => {
      const chip = e.target.closest(".theme-chip");
      if (chip) setTheme(chip.dataset.themeVal);
    });
    el.businessForm.addEventListener("change", saveBusiness);
    el.businessForm.addEventListener("submit", (e) => e.preventDefault());
    el.exportBtn.addEventListener("click", exportJSON);
    el.importBtn.addEventListener("click", () => el.importFile.click());
    el.importFile.addEventListener("change", () => importJSON(el.importFile.files[0]));
    el.templateBtn.addEventListener("click", addTemplate);
    el.randomizeBtn.addEventListener("click", randomizeData);
    el.clearBtn.addEventListener("click", clearAll);
    el.aboutBtn.addEventListener("click", openAbout);

    // Cloud sync
    el.cloudPhraseForm.addEventListener("submit", (e) => e.preventDefault());
    el.generatePhraseBtn.addEventListener("click", generateCloudPhrase);
    el.togglePhraseBtn.addEventListener("click", togglePhraseVisibility);
    el.rememberPhrase.addEventListener("change", saveRememberedPhrase);
    el.cloudSaveBtn.addEventListener("click", saveCloudData);
    el.cloudLoadBtn.addEventListener("click", loadCloudData);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && anyModalOpen()) { closeModals(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        const form = !el.orderModal.hidden ? el.orderForm : !el.partModal.hidden ? el.partForm : !el.poModal.hidden ? el.poForm : null;
        if (form) { e.preventDefault(); form.requestSubmit(); }
        return;
      }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (typing || anyModalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" || e.key === "N") { e.preventDefault(); openOrderEditor(null); }
    });
  }

  function cacheEls() {
    [
      "crumb", "topNewOrderBtn", "settingsBtn", "railSummary", "navList", "newOrderBtn", "appVersion", "canvas", "brandTag",
      "orderModal", "orderTitle", "orderForm", "oProduct", "oStatus", "oOptions", "oDate", "oQty", "oPlatform", "oCustomer", "oRef",
      "oPrice", "oShipCharged", "oShipCost", "oFees", "oFeeEstimate", "oSerials", "oSerialAuto", "oTracking", "oHistorical", "oNotes", "oPreview", "oDelete",
      "partModal", "partTitle", "partForm", "pName", "pCategory", "pSku", "pUnit", "pCost", "pReorderPoint", "pReorderQty", "pLead",
      "pSupplier", "pUrl", "pStart", "pStartWrap", "pNotes", "pHistory", "pDelete", "categoryList", "supplierList",
      "adjustModal", "adjustTitle", "adjustForm", "aInfo", "aMode", "aAmount", "aAmountLabel", "aDate", "aNote",
      "poModal", "poTitle", "poForm", "poSupplier", "poRef", "poDate", "poExpected", "poStatus", "poLines", "poAddLine", "poShipping", "poTotal", "poNotes", "poDelete",
      "settingsModal", "themePicker", "businessForm", "bName", "bFeePct", "bFeeFixed", "bBuffer", "bLookback",
      "exportBtn", "importBtn", "importFile", "templateBtn", "randomizeBtn", "aboutBtn", "clearBtn",
      "cloudPhraseForm", "cloudPhrase", "togglePhraseBtn", "cloudPhraseOut", "rememberPhrase", "generatePhraseBtn",
      "cloudSaveBtn", "cloudLoadBtn", "cloudStatus", "aboutModal", "aboutVersion", "toast",
    ].forEach((id) => { el[id] = $(id); });
  }

  function init() {
    cacheEls();
    load();
    initVersion();
    loadRememberedPhrase();
    bindEvents();
    renderAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
