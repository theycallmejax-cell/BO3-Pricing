// Tom, round 2: independent verification of collection pooling in cartTransformRun.
// Written from the rule (Cheyne, 2026-10-25), not from Lex's tests or from my round-1 helpers.
//
// RULE: eligible collection = The Club Pricing. Within a cart, across all member lines (any product,
// any size), the very first unit is full price; after that units are at the customer's tier allowance
// at cost (twin 2, triplet 3, quad-and-above 6, highest tier among held tags); units beyond are full.
// Non-members are never touched and take no pool units. Each at-cost unit costs its own line's product
// cost x presentmentCurrencyRate. A line failing a guard takes no discount, uses no allowance and is not
// the first unit. Hand-check: quad, one product on two lines 3+3, retail 20, cost 8 => 60.00.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse, Kind } from "graphql";
import { cartTransformRun as repoRun, ELIGIBLE_COLLECTION_IDS } from "../src/cart_transform_run.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_JS = readFileSync(join(HERE, "../src/cart_transform_run.js"), "utf8");
const SRC_GQL = readFileSync(join(HERE, "../src/cart_transform_run.graphql"), "utf8");

const CLUB = "gid://shopify/Collection/330356261047";
const OTHER = "gid://shopify/Collection/999000111222"; // second eligible collection, test-only
const GROWN = "gid://shopify/Collection/330038804663"; // Grown-Ups, never eligible
const COLOUR = "gid://shopify/Collection/329910452407"; // Colour Theory, never eligible

// ---- independent tier table (oracle's own) ----
const TAG_QUERY = ["twin", "twins", "twin-fam", "amba-twin", "triplet", "triplets", "triplet-fam", "amba-triplet", "amba-quad", "hero", "quad", "quads", "amba", "amba-member"];
const TIER_OF = {
  // Round 3 (Cheyne 2026-10-25): twin 1, triplet 2, quad-and-above 6. This table is the only place the oracle holds allowances.
  twin: 1, twins: 1, "twin-fam": 1, "amba-twin": 1,
  triplet: 2, triplets: 2, "triplet-fam": 2, "amba-triplet": 2,
  "amba-quad": 6, hero: 6, quad: 6, quads: 6, amba: 6, "amba-member": 6,
};
const TIER_NAMES = { twin: ["twin"], triplet: ["triplet"], quad: ["quad"] };

// ---- load a copy of the module with a different eligible list / a mutation, without touching the repo ----
function loadCopy(ids, mutate) {
  let code = SRC_JS;
  const before = code;
  code = code.replace(/export const ELIGIBLE_COLLECTION_IDS = \[[^\]]*\];/, `const ELIGIBLE_COLLECTION_IDS = ${JSON.stringify(ids)};`);
  code = code.replace("export function cartTransformRun", "function cartTransformRun");
  if (code === before) throw new Error("could not rewrite module copy");
  if (mutate) {
    const m = code.replace(mutate[0], mutate[1]);
    if (m === code) throw new Error("mutation did not apply: " + mutate[0]);
    code = m;
  }
  return new Function(code + "\nreturn cartTransformRun;")();
}

// ---- builders ----
const meta = (amount, cc = "AUD") => ({ value: JSON.stringify({ amount, currency_code: cc }) });
let LID = 0;
// members: collection ids the product is a member of. universe: collection ids the query asked about.
function mk(qty, { product = 1, variant, retail = 20, cost = 8, members = [CLUB], universe = [CLUB], metafield, typename = "ProductVariant", noProductId = false, inColl } = {}) {
  const id = `gid://shopify/CartLine/${++LID}`;
  const vid = `gid://shopify/ProductVariant/${variant ?? LID}`;
  const prod = {
    id: noProductId ? undefined : `gid://shopify/Product/${product}`,
    inCollections: inColl !== undefined ? inColl : universe.map((c) => ({ collectionId: c, isMember: members.includes(c) })),
    metafield: metafield !== undefined ? metafield : meta(String(cost.toFixed ? cost.toFixed(2) : cost)),
  };
  if (noProductId) delete prod.id;
  return {
    id, quantity: qty,
    merchandise: typename === "ProductVariant" ? { __typename: "ProductVariant", id: vid, product: prod } : { __typename: typename, id: vid },
    cost: { amountPerQuantity: { amount: Number(retail).toFixed(2), currencyCode: "AUD" } },
  };
}
const tagsFor = (held) => TAG_QUERY.map((t) => ({ tag: t, hasTag: held.includes(t) }));
function cart(lines, { held = ["twin"], rate = 1, customer = true } = {}) {
  const input = { cart: { buyerIdentity: { customer: customer ? { hasTags: tagsFor(held) } : null }, lines } };
  if (rate !== "ABSENT") input.presentmentCurrencyRate = rate;
  return input;
}

// ---- THE ORACLE ----
function oracleRate(r) {
  if (r === undefined || r === null) return 1;
  const n = typeof r === "number" ? r : Number(r);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function oracleCost(mf) {
  if (!mf || typeof mf.value !== "string") return null;
  let o; try { o = JSON.parse(mf.value); } catch { return null; }
  if (!o || typeof o.amount !== "string" || typeof o.currency_code !== "string") return null;
  const n = Number(o.amount.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}
const r2 = (x) => Math.round((x + 1e-9) * 100) / 100;
// Returns per cart line: array of units { atCost, price } (length = quantity for sane quantities, else []).
function oracle(input, eligible) {
  const lines = input.cart.lines;
  const res = lines.map((l) => ({ id: l.id, retail: Number(l.cost.amountPerQuantity.amount), qty: l.quantity, units: null, touched: false }));
  const cust = input.cart.buyerIdentity.customer;
  const held = cust ? (cust.hasTags || []).filter((t) => t && t.hasTag === true).map((t) => String(t.tag).toLowerCase().trim()) : [];
  const allow = held.reduce((m, t) => Math.max(m, TIER_OF[t] ?? 0), 0);
  const rate = oracleRate(input.presentmentCurrencyRate);
  const live = cust && allow > 0 && rate !== null;
  const pools = {};
  lines.forEach((l, i) => {
    const out = res[i];
    const full = () => Array.from({ length: Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 0 }, () => ({ atCost: false, price: out.retail }));
    out.units = full();
    if (!live) return;
    const m = l.merchandise;
    if (!m || m.__typename !== "ProductVariant") return;
    const p = m.product;
    if (!p || !p.id) return;
    let key = null;
    for (const e of eligible) { if ((p.inCollections || []).some((c) => c && c.collectionId === e && c.isMember === true)) { key = e; break; } }
    if (key === null) return;
    if (!Number.isInteger(l.quantity) || l.quantity < 1) return;
    const base = oracleCost(p.metafield);
    if (base === null) return;
    const conv = base * rate;
    if (!(conv < out.retail)) return;
    out.touched = true; // candidate
    const pool = (pools[key] ||= { n: 0 }); // n = eligible units seen so far in this pool
    out.units = out.units.map(() => {
      const idx = pool.n++;
      const atCost = idx >= 1 && idx <= allow; // unit 0 full, units 1..allow at cost, rest full
      return atCost ? { atCost: true, price: r2(conv) } : { atCost: false, price: out.retail };
    });
  });
  return res;
}

// ---- reading the function output ----
function flatten(input, out) {
  const map = new Map();
  for (const op of out.operations) map.set(op.lineExpand.cartLineId, op);
  return input.cart.lines.map((l) => {
    const op = map.get(l.id);
    const retail = Number(l.cost.amountPerQuantity.amount);
    if (!op) return { op: null, units: Array.from({ length: Number.isInteger(l.quantity) && l.quantity > 0 ? l.quantity : 0 }, () => ({ atCost: false, price: retail })) };
    const units = [];
    for (const it of op.lineExpand.expandedCartItems) {
      const fixed = it.price?.adjustment?.fixedPricePerUnit?.amount;
      for (let k = 0; k < it.quantity; k++) units.push(fixed !== undefined ? { atCost: true, price: Number(fixed) } : { atCost: false, price: retail });
    }
    return { op, units };
  });
}
const sumUnits = (us) => us.reduce((s, u) => s + u.price, 0);

let CHECKS = 0;
function fail(label, msg) { throw new Error(`[${label}] ${msg}`); }
function ok(label, cond, msg) { CHECKS++; if (!cond) fail(label, msg); }

// Every assertion the brief lists, plus per-unit equality with the oracle.
function verify(label, input, out, eligible = [CLUB]) {
  const exp = oracle(input, eligible);
  const act = flatten(input, out);
  // top-level shape
  ok(label, JSON.stringify(Object.keys(out)) === '["operations"]', "output keys are not exactly [operations]");
  ok(label, Array.isArray(out.operations), "operations is not an array");
  ok(label, !JSON.stringify(out).includes("currencyCode"), "currencyCode appears in output");
  const seen = new Set();
  const ids = new Set(input.cart.lines.map((l) => l.id));
  for (const op of out.operations) {
    ok(label, JSON.stringify(Object.keys(op)) === '["lineExpand"]', "operation key is not only lineExpand: " + Object.keys(op));
    const le = op.lineExpand;
    ok(label, ids.has(le.cartLineId), "operation for unknown line");
    ok(label, !seen.has(le.cartLineId), "two operations for one line");
    seen.add(le.cartLineId);
    ok(label, JSON.stringify(Object.keys(le).sort()) === JSON.stringify(["cartLineId", "expandedCartItems", "title"]), "lineExpand keys: " + Object.keys(le));
    const src = input.cart.lines.find((l) => l.id === le.cartLineId);
    ok(label, Array.isArray(le.expandedCartItems) && le.expandedCartItems.length >= 1, "empty expandedCartItems");
    let sum = 0, anyCost = false, prev = null;
    for (const it of le.expandedCartItems) {
      ok(label, Number.isInteger(it.quantity) && it.quantity > 0, "quantity not positive integer: " + it.quantity);
      ok(label, it.merchandiseId === src.merchandise.id, "merchandiseId changed");
      sum += it.quantity;
      const priced = it.price !== undefined;
      ok(label, JSON.stringify(Object.keys(it).sort()) === JSON.stringify(priced ? ["merchandiseId", "price", "quantity"] : ["merchandiseId", "quantity"]), "item keys: " + Object.keys(it));
      if (priced) {
        anyCost = true;
        ok(label, JSON.stringify(it.price) === JSON.stringify({ adjustment: { fixedPricePerUnit: { amount: it.price.adjustment.fixedPricePerUnit.amount } } }), "price shape");
        ok(label, typeof it.price.adjustment.fixedPricePerUnit.amount === "string" && /^\d+\.\d{2}$/.test(it.price.adjustment.fixedPricePerUnit.amount), "amount not 2-dp string: " + it.price.adjustment.fixedPricePerUnit.amount);
      }
      ok(label, prev === null || prev !== priced, "adjacent groups not run-length merged");
      prev = priced;
    }
    ok(label, sum === src.quantity, `units not conserved: ${sum} vs ${src.quantity}`);
    ok(label, anyCost, "operation on a line with no at-cost unit");
  }
  // per line vs oracle
  input.cart.lines.forEach((l, i) => {
    const e = exp[i], a = act[i];
    ok(label, a.units.length === e.units.length, `line ${i}: unit count ${a.units.length} vs ${e.units.length}`);
    if (a.op) ok(label, e.touched, `line ${i}: operation on a line the rule never touches (non-member or failed guard)`);
    for (let k = 0; k < e.units.length; k++) {
      const eu = e.units[k], au = a.units[k];
      ok(label, au.atCost === eu.atCost, `line ${i} unit ${k}: atCost ${au.atCost} vs expected ${eu.atCost}`);
      // A converted cost landing exactly on a half cent (e.g. 9.50 x 0.65 = 6.175) may legitimately round either way.
      let tol = 0.0051;
      if (eu.atCost) { const raw = oracleCost(l.merchandise.product.metafield) * oracleRate(input.presentmentCurrencyRate); if (Math.abs(raw * 100 - Math.round(raw * 100 - 0.5) - 0.5) < 1e-6) tol = 0.0101; }
      ok(label, Math.abs(au.price - eu.price) <= tol, `line ${i} unit ${k}: price ${au.price} vs expected ${eu.price}`);
      ok(label, au.price <= e.retail + 1e-9, `line ${i} unit ${k}: above retail`);
      if (au.atCost) {
        const base = oracleCost(l.merchandise.product.metafield) * oracleRate(input.presentmentCurrencyRate);
        ok(label, au.price >= base - 0.005, `line ${i} unit ${k}: below converted cost`);
      }
    }
  });
  const tExp = exp.reduce((s, e) => s + (e.units.length ? sumUnits(e.units) : e.qty * e.retail), 0);
  const tAct = act.reduce((s, a, i) => s + (a.units.length ? sumUnits(a.units) : exp[i].qty * exp[i].retail), 0);
  const atCostUnits = exp.reduce((s, e) => s + e.units.filter((u) => u.atCost).length, 0);
  ok(label, Math.abs(tExp - tAct) <= 0.0051 + (hasTieUnits(input, exp) ? 0.0101 * atCostUnits : 0), `total ${tAct.toFixed(2)} vs oracle ${tExp.toFixed(2)}`);
  return { total: Math.round(tAct * 100) / 100, exp, act };
}
function hasTieUnits(input, exp) {
  return input.cart.lines.some((l, i) => exp[i].units.some((u) => u.atCost) && (() => { const raw = oracleCost(l.merchandise.product.metafield) * oracleRate(input.presentmentCurrencyRate); return Math.abs(raw * 100 - Math.round(raw * 100 - 0.5) - 0.5) < 1e-6; })());
}
const run = (label, input, eligible = [CLUB], fn = repoRun) => verify(label, input, fn(input), eligible);

// all compositions of n into k positive parts
function comps(n, k) {
  if (k === 1) return [[n]];
  const r = [];
  for (let first = 1; first <= n - (k - 1); first++) for (const rest of comps(n - first, k - 1)) r.push([first, ...rest]);
  return r;
}

describe("hand checks (worked by hand, not by the oracle)", () => {
  it("quad, one product, two lines 3+3, retail 20, cost 8 = 60.00", () => {
    const i = cart([mk(3, { product: 1, variant: 11 }), mk(3, { product: 1, variant: 12 })], { held: ["quad"] });
    expect(run("hand-quad-3+3", i).total).toBe(60);
  });
  it("twin, 1+1 same product two sizes = 28.00", () => {
    const i = cart([mk(1, { product: 1, variant: 11 }), mk(1, { product: 1, variant: 12 })], { held: ["twin"] });
    expect(run("hand-twin-1+1", i).total).toBe(28);
  });
  it("triplet, two colours (cost 8 and 9.50), 2+2: 1 full, 2 at cost, 1 full = 20+8+9.5+25, by hand", () => {
    // Round 3 (triplet allowance 2). line1 (A, qty2): unit0 full 20, unit1 at cost 8 (allowance 1 of 2).
    // line2 (B retail 25 cost 9.50, qty2): unit2 at cost 9.50 (allowance 2 of 2), unit3 full 25.
    const i = cart([mk(2, { product: 1 }), mk(2, { product: 2, retail: 25, cost: 9.5 })], { held: ["triplet"] });
    expect(run("hand-triplet-2colours", i).total).toBe(20 + 8 + 9.5 + 25);
  });
  it("single unit, single line: untouched", () => {
    const i = cart([mk(1)], { held: ["quad"] });
    const out = repoRun(i);
    expect(out.operations).toEqual([]);
    run("hand-single", i);
  });
  it("rate 0.65 converts cost: twin 3 units retail 20 cost 8 -> 20 + 2 x 5.20", () => {
    const i = cart([mk(3)], { held: ["twin"], rate: 0.65 });
    expect(run("hand-rate", i).total).toBe(45.2); // round 3, twin allowance 1: 20 full + 5.20 at cost + 20 full
  });
});

describe("one product, every split of 1..8 units over 1, 2 and 3 lines, each tier", () => {
  for (const [tier, held] of Object.entries(TIER_NAMES)) {
    it(`${tier}`, () => {
      let n = 0;
      for (let units = 1; units <= 8; units++) {
        for (let k = 1; k <= 3; k++) {
          if (k > units) continue;
          for (const split of comps(units, k)) {
            const lines = split.map((q, idx) => mk(q, { product: 1, variant: 100 + idx }));
            const input = cart(lines, { held });
            const { total } = run(`${tier} ${split.join("+")}`, input);
            // Single-pool shape: total depends only on total units for ONE product at one cost.
            const allow = TIER_OF[held[0]];
            const atCost = units >= 2 ? Math.min(units - 1, allow) : 0;
            expect(total).toBeCloseTo(units * 20 - atCost * 12, 2);
            n++;
          }
        }
      }
      expect(n).toBeGreaterThan(50);
    });
  }
});

describe("two colours (two products) mixed with sizes", () => {
  for (const [tier, held] of Object.entries(TIER_NAMES)) {
    it(`${tier}: A,B,A,B and A,A,B,B and B,A,B,A over quantities 1..3`, () => {
      const pattern = [
        [1, 2, 1, 2],
        [1, 1, 2, 2],
        [2, 1, 2, 1],
      ];
      let n = 0;
      for (const pat of pattern) {
        for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) for (let c = 1; c <= 3; c++) for (let d = 1; d <= 3; d++) {
          const q = [a, b, c, d];
          const lines = q.map((qty, idx) => {
            const prod = pat[idx];
            return prod === 1 ? mk(qty, { product: 1, variant: 10 + idx, retail: 20, cost: 8 }) : mk(qty, { product: 2, variant: 20 + idx, retail: 25, cost: 9.5 });
          });
          run(`${tier} pat${pat.join("")} q${q.join("")}`, cart(lines, { held }));
          n++;
        }
      }
      expect(n).toBe(243);
    });
  }
  it("two products with different cost: each at-cost unit uses its own line's cost", () => {
    // Round 3 twin allowance 1: A x1 (full 20), B x2 -> first B at cost 9.50 (B's cost, not A's 8), second B full 25
    const i = cart([mk(1, { product: 1 }), mk(2, { product: 2, retail: 25, cost: 9.5 })], { held: ["twin"] });
    const r = run("own-cost", i);
    expect(r.total).toBe(20 + 9.5 + 25);
  });
});

describe("non-member products mixed in", () => {
  it("Grown-Ups (non-member) between members takes no pool units and is never touched", () => {
    for (const held of [["twin"], ["triplet"], ["quad"]]) {
      for (let q1 = 1; q1 <= 4; q1++) for (let qg = 1; qg <= 4; qg++) for (let q2 = 1; q2 <= 4; q2++) {
        const g = mk(qg, { product: 50, retail: 40, cost: 10, members: [GROWN], universe: [CLUB] });
        const i = cart([mk(q1, { product: 1 }), g, mk(q2, { product: 2, retail: 25, cost: 9.5 })], { held });
        const { act } = run(`nonmember ${held} ${q1}/${qg}/${q2}`, i);
        expect(act[1].op).toBeNull();
      }
    }
  });
  it("non-member as the FIRST line does not become the pool's first unit", () => {
    const i = cart([mk(3, { product: 50, retail: 40, cost: 10, members: [] }), mk(2, { product: 1 })], { held: ["quad"] });
    const r = run("nonmember-first", i);
    expect(r.act[1].units.map((u) => u.atCost)).toEqual([false, true]);
  });
  it("membership shapes that must all mean non-member: isMember false, empty list, null, absent, other collections only", () => {
    const shapes = [
      { inColl: [{ collectionId: CLUB, isMember: false }] },
      { inColl: [] },
      { inColl: null },
      { inColl: undefined, members: [COLOUR], universe: [COLOUR] },
      { inColl: [{ collectionId: COLOUR, isMember: true }] },
      { inColl: [{ collectionId: CLUB, isMember: "true" }] }, // truthy string is not boolean true
      { inColl: [null] },
    ];
    for (const [si, s] of shapes.entries()) {
      const lines = [mk(3, { product: 1 }), mk(3, { product: 60, ...s })];
      if (s.inColl === undefined && !s.members) delete lines[1].merchandise.product.inCollections;
      const input = cart(lines, { held: ["quad"] });
      const r = run(`shape ${si}`, input);
      expect(r.act[1].op).toBeNull();
    }
    // key entirely absent
    const l = mk(3, { product: 61 }); delete l.merchandise.product.inCollections;
    const input = cart([mk(3, { product: 1 }), l], { held: ["quad"] });
    expect(run("inCollections absent", input).act[1].op).toBeNull();
  });
});

describe("guard-failing line in the middle", () => {
  const guardCases = {
    "cost metafield missing": { metafield: null },
    "cost metafield undefined value": { metafield: {} },
    "cost not JSON": { metafield: { value: "not json" } },
    "cost amount is a number not string": { metafield: { value: JSON.stringify({ amount: 8, currency_code: "AUD" }) } },
    "cost no currency_code": { metafield: { value: JSON.stringify({ amount: "8.00" }) } },
    "cost zero": { metafield: meta("0.00") },
    "cost negative": { metafield: meta("-3.00") },
    "cost equals retail": { cost: 20 },
    "cost above retail": { cost: 25 },
    "not a ProductVariant": { typename: "CustomProduct" },
    "no product id": { noProductId: true },
    "quantity zero": { qty: 0 },
    "quantity fractional": { qty: 2.5 },
  };
  for (const [name, opts] of Object.entries(guardCases)) {
    it(name, () => {
      for (const held of [["twin"], ["quad"]]) for (const q of [1, 2, 3, 4]) {
        const { qty = 3, ...rest } = opts;
        const bad = mk(qty, { product: 70, variant: 70, ...rest });
        const input = cart([mk(q, { product: 1 }), bad, mk(q, { product: 2, retail: 25, cost: 9.5 })], { held });
        const r = run(`guard ${name} ${held} q${q}`, input);
        expect(r.act[1].op).toBeNull();
      }
    });
  }
  it("a guard-failing FIRST line is not the pool's first unit", () => {
    const bad = mk(4, { product: 70, cost: 25 });
    const input = cart([bad, mk(2, { product: 1 })], { held: ["quad"] });
    const r = run("guard-first", input);
    expect(r.act[1].units.map((u) => u.atCost)).toEqual([false, true]); // first real unit still full
  });
  it("guard-failing line consumes no allowance: twin allowance still 1 after it", () => {
    const bad = mk(5, { product: 70, cost: 20 });
    const input = cart([mk(1, { product: 1 }), bad, mk(5, { product: 2, retail: 25, cost: 9.5 })], { held: ["twin"] });
    const r = run("guard-allowance", input);
    expect(r.act[2].units.map((u) => u.atCost)).toEqual([true, false, false, false, false]); // round 3: allowance 1
  });
  it("cost passes at rate 1 but fails at rate 1.5 for one product only", () => {
    const input = cart([mk(2, { product: 1, cost: 8 }), mk(2, { product: 2, retail: 25, cost: 18 })], { held: ["quad"], rate: 1.5 });
    // A: 12 < 20 ok. B: 27 >= 25 fails.
    const r = run("rate-guard-partial", input);
    expect(r.act[1].op).toBeNull();
  });
  it("converted cost strictly below retail: cost 19.996 -> priced 20.00, never above retail", () => {
    const input = cart([mk(2, { product: 1, cost: "19.996" })], { held: ["twin"] });
    const r = run("rounding-edge", input);
    expect(r.act[0].units.every((u) => u.price <= 20)).toBe(true);
  });
});

describe("two eligible collections: independent pools", () => {
  const two = loadCopy([CLUB, OTHER]);
  const U = [CLUB, OTHER];
  const E = [CLUB, OTHER];
  it("each collection has its own first-unit-full and its own allowance", () => {
    // twin: club A x3 -> F,C,C ; other B x3 -> F,C,C
    const i = cart([
      mk(3, { product: 1, members: [CLUB], universe: U }),
      mk(3, { product: 2, retail: 25, cost: 9.5, members: [OTHER], universe: U }),
    ], { held: ["twin"] });
    const r = run("two-pools", i, E, two);
    expect(r.act[0].units.map((u) => u.atCost)).toEqual([false, true, false]); // round 3: twin allowance 1
    expect(r.act[1].units.map((u) => u.atCost)).toEqual([false, true, false]);
    expect(r.total).toBe(20 + 8 + 20 + 25 + 9.5 + 25); // round 3 twin: each pool F, C, F
  });
  it("interleaved lines across the two pools", () => {
    for (const held of [["twin"], ["triplet"], ["quad"]]) for (let a = 1; a <= 4; a++) for (let b = 1; b <= 4; b++) for (let c = 1; c <= 4; c++) {
      const i = cart([
        mk(a, { product: 1, members: [CLUB], universe: U }),
        mk(b, { product: 2, retail: 25, cost: 9.5, members: [OTHER], universe: U }),
        mk(c, { product: 3, members: [CLUB], universe: U }),
        mk(2, { product: 9, retail: 40, cost: 10, members: [], universe: U }),
      ], { held });
      run(`interleave ${held} ${a}${b}${c}`, i, E, two);
    }
  });
  it("product in BOTH collections uses the first in list order, and only that pool", () => {
    const i = cart([
      mk(2, { product: 1, members: [CLUB, OTHER], universe: U }),
      mk(2, { product: 2, retail: 25, cost: 9.5, members: [OTHER], universe: U }),
    ], { held: ["quad"] });
    const r = run("both-collections", i, E, two);
    expect(r.act[0].units.map((u) => u.atCost)).toEqual([false, true]);
    expect(r.act[1].units.map((u) => u.atCost)).toEqual([false, true]); // OTHER pool starts fresh here
  });
  it("list order matters: reversed list gives the other key (proves key is first-in-list)", () => {
    const rev = loadCopy([OTHER, CLUB]);
    const i = cart([
      mk(2, { product: 1, members: [CLUB, OTHER], universe: U }),
      mk(2, { product: 2, retail: 25, cost: 9.5, members: [CLUB], universe: U }),
    ], { held: ["quad"] });
    // reversed: product 1 -> OTHER pool, product 2 -> CLUB pool => two pools, each starts full
    const r = run("reversed", i, [OTHER, CLUB], rev);
    expect(r.act[0].units.map((u) => u.atCost)).toEqual([false, true]);
    expect(r.act[1].units.map((u) => u.atCost)).toEqual([false, true]);
  });
});

describe("tiers and tags", () => {
  const lines = () => [mk(5, { product: 1, variant: 1 }), mk(5, { product: 2, variant: 2, retail: 25, cost: 9.5 })];
  const atCostCount = (r) => r.act.reduce((s, a) => s + a.units.filter((u) => u.atCost).length, 0);
  it("mixed tags take the highest tier", () => {
    expect(atCostCount(run("twin+triplet", cart(lines(), { held: ["twin", "triplet"] })))).toBe(2); // round 3: twin 1, triplet 2 -> highest is 2
    expect(atCostCount(run("twin+hero", cart(lines(), { held: ["twin", "hero"] })))).toBe(6);
    expect(atCostCount(run("triplet+amba-quad+twin", cart(lines(), { held: ["triplet", "amba-quad", "twin"] })))).toBe(6);
    expect(atCostCount(run("amba-twin+twin-fam", cart(lines(), { held: ["amba-twin", "twin-fam"] })))).toBe(1);
  });
  it("every tag in the query maps to the right allowance", () => {
    for (const t of TAG_QUERY) expect(atCostCount(run("tag " + t, cart(lines(), { held: [t] })))).toBe(TIER_OF[t]);
  });
  it("no held tags, no customer: nothing happens", () => {
    expect(repoRun(cart(lines(), { held: [] })).operations).toEqual([]);
    expect(repoRun(cart(lines(), { customer: false })).operations).toEqual([]);
    run("no tags", cart(lines(), { held: [] }));
    run("no customer", cart(lines(), { customer: false }));
  });
  it("hasTag false entries are not held", () => {
    const i = cart(lines(), { held: ["twin"] });
    const r = run("twin only", i);
    expect(atCostCount(r)).toBe(1);
  });
});

describe("presentmentCurrencyRate", () => {
  const base = () => [mk(3, { product: 1 }), mk(2, { product: 2, retail: 25, cost: 9.5 })];
  it("1, 0.65, string 0.65, absent and null behave as a valid rate (null and absent as 1)", () => {
    for (const rate of [1, 0.65, "0.65", "ABSENT", null, 1.2]) {
      const r = run(`rate ${rate}`, cart(base(), { held: ["triplet"], rate }));
      expect(r.act.some((a) => a.op)).toBe(true);
    }
  });
  it("absent rate prices at unconverted cost", () => {
    const r = run("absent", cart([mk(2)], { held: ["twin"], rate: "ABSENT" }));
    expect(r.total).toBe(28);
  });
  it("0, negative, 'abc', NaN, Infinity, empty string: no operations at all", () => {
    for (const rate of [0, -1, "abc", NaN, Infinity, "", "0"]) {
      const i = cart(base(), { held: ["quad"], rate });
      const out = repoRun(i);
      expect(out.operations, `rate ${String(rate)}`).toEqual([]);
      run(`badrate ${String(rate)}`, i);
    }
  });
});

describe("random carts (fixed seed)", () => {
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const two = loadCopy([CLUB, OTHER]);
  it("700 random carts, seed 20261025", () => {
    const rnd = mulberry32(20261025);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const PRODUCTS = [
      { retail: 20, cost: 8 }, { retail: 29.95, cost: 18.63 }, { retail: 25, cost: 9.5 }, { retail: 40, cost: 10 }, { retail: 12.5, cost: 7.25 }, { retail: 29.95, cost: 18.63 },
    ];
    const RATES = [1, 1, 1, 0.65, 0.9, 1.5, "0.65", "ABSENT", null, 0, "abc", -2];
    const HELD = [[], ["twin"], ["triplet"], ["quad"], ["hero"], ["twin", "triplet"], ["twin", "amba-member"], ["triplet", "twins"], ["quads"]];
    const stats = { carts: 0, withOps: 0, withNonMember: 0, withGuardFail: 0, otherPoolOps: 0, multiProductPool: 0 };
    for (let n = 0; n < 700; n++) {
      const useTwo = rnd() < 0.4;
      const U = useTwo ? [CLUB, OTHER] : [CLUB];
      const elig = useTwo ? [CLUB, OTHER] : [CLUB];
      const fn = useTwo ? two : repoRun;
      const nLines = Math.floor(rnd() * 7);
      const lines = [];
      let hasNon = false, hasBad = false;
      for (let li = 0; li < nLines; li++) {
        const pi = Math.floor(rnd() * PRODUCTS.length);
        const P = PRODUCTS[pi];
        const qty = rnd() < 0.03 ? pick([0, 2.5, -1]) : 1 + Math.floor(rnd() * 6);
        const roll = rnd();
        const opts = { product: pi + 1, variant: 1000 + li, retail: P.retail * (rnd() < 0.2 ? 1.1 : 1), cost: P.cost, universe: U };
        const mroll = rnd();
        opts.members = mroll < 0.12 ? [] : mroll < 0.2 ? [GROWN] : useTwo ? pick([[CLUB], [CLUB], [OTHER], [CLUB, OTHER], [OTHER, CLUB]]) : [CLUB];
        if (opts.members.length === 0 || (opts.members.length === 1 && opts.members[0] === GROWN)) hasNon = true;
        if (roll < 0.05) { opts.metafield = null; hasBad = true; }
        else if (roll < 0.09) { opts.metafield = { value: "{{" }; hasBad = true; }
        else if (roll < 0.13) { opts.cost = opts.retail + 1; hasBad = true; }
        else if (roll < 0.16) { opts.typename = "CustomProduct"; hasBad = true; }
        const line = mk(qty, opts);
        lines.push(line);
      }
      const input = cart(lines, { held: pick(HELD), rate: pick(RATES), customer: rnd() > 0.05 });
      const out = fn(input);
      const r = verify(`random#${n}`, input, out, elig);
      stats.carts++;
      if (out.operations.length) stats.withOps++;
      if (hasNon) stats.withNonMember++;
      if (hasBad) stats.withGuardFail++;
      if (useTwo && r.act.some((a, i) => a.op && r.exp[i].touched && input.cart.lines[i].merchandise.product && input.cart.lines[i].merchandise.product.inCollections.some((c) => c.collectionId === OTHER && c.isMember && !input.cart.lines[i].merchandise.product.inCollections.some((d) => d.collectionId === CLUB && d.isMember)))) stats.otherPoolOps++;
      const opLines = r.act.filter((a) => a.op).length;
      if (opLines >= 2) stats.multiProductPool++;
    }
    console.log("round2 random stats", JSON.stringify(stats), "checks so far", CHECKS);
    expect(stats.carts).toBe(700);
    expect(stats.withOps).toBeGreaterThan(150);
    expect(stats.withNonMember).toBeGreaterThan(50);
    expect(stats.withGuardFail).toBeGreaterThan(50);
    expect(stats.otherPoolOps).toBeGreaterThan(5);
    expect(stats.multiProductPool).toBeGreaterThan(30);
  });
});

describe("the oracle has teeth: deliberately broken copies of the module must be caught", () => {
  const scenario = () => [
    cart([mk(3, { product: 1 }), mk(3, { product: 2, retail: 25, cost: 9.5 })], { held: ["quad"] }),
    cart([mk(1, { product: 1 }), mk(1, { product: 2 }), mk(2, { product: 3, cost: 25 })], { held: ["twin"] }),
    cart([mk(2, { product: 1 }), mk(2, { product: 9, members: [GROWN] })], { held: ["triplet"] }),
    cart([mk(4, { product: 1 })], { held: ["twin"], rate: 0.65 }),
    // Round 3: with twin allowance 1 the pool is spent after one unit, so a guard-failing line must sit right after the first unit to show up.
    cart([mk(1, { product: 1 }), mk(2, { product: 3, cost: 25 })], { held: ["twin"] }),
  ];
  const mutants = {
    "allowance off by one (<=)": ["pool.used < maxAdditional", "pool.used <= maxAdditional"],
    "first unit also at cost": ["if (!pool.started) {\n        pool.started = true;\n        atCost = false;", "if (!pool.started) {\n        pool.started = true;\n        atCost = true; anyAtCost = true;"],
    "no membership check": ["if (poolKey === null) continue;", ""],
    "rate ignored": ["parseFloat(costPrice.amount) * rate", "parseFloat(costPrice.amount)"],
    "per-line pool instead of shared": ["const pool = pools.get(poolKey) ?? { started: false, used: 0 };", "const pool = { started: false, used: 0 };"],
    "cost guard dropped": ["|| costAmount >= retailAmount", ""],
  };
  for (const [name, mut] of Object.entries(mutants)) {
    it(`caught: ${name}`, () => {
      const bad = loadCopy([CLUB], mut);
      let caught = false;
      for (const input of scenario()) {
        try { verify("mutant", input, bad(input), [CLUB]); } catch { caught = true; break; }
      }
      expect(caught).toBe(true);
    });
  }
  it("sanity: the unmutated copy passes the same scenarios", () => {
    const same = loadCopy([CLUB]);
    for (const input of scenario()) verify("unmutated copy", input, same(input), [CLUB]);
  });
});

describe("graphql: every field the code reads is requested; ids agree", () => {
  const doc = parse(SRC_GQL);
  const op = doc.definitions.find((d) => d.kind === Kind.OPERATION_DEFINITION);
  // collect dotted selection paths (inline fragment type conditions are transparent)
  const paths = new Set();
  const args = {};
  (function walk(sel, prefix) {
    for (const s of sel.selections) {
      if (s.kind === Kind.FIELD) {
        const p = prefix ? `${prefix}.${s.name.value}` : s.name.value;
        paths.add(p);
        args[p] = s.arguments;
        if (s.selectionSet) walk(s.selectionSet, p);
      } else if (s.kind === Kind.INLINE_FRAGMENT) walk(s.selectionSet, prefix);
    }
  })(op.selectionSet, "");
  it("parses as GraphQL syntax and is a query", () => {
    expect(op.operation).toBe("query");
  });
  it("requests every field the function reads", () => {
    const needed = [
      "presentmentCurrencyRate",
      "cart.buyerIdentity.customer.hasTags.tag", "cart.buyerIdentity.customer.hasTags.hasTag",
      "cart.lines.id", "cart.lines.quantity",
      "cart.lines.merchandise.__typename", "cart.lines.merchandise.id",
      "cart.lines.merchandise.product.id",
      "cart.lines.merchandise.product.inCollections.collectionId", "cart.lines.merchandise.product.inCollections.isMember",
      "cart.lines.merchandise.product.metafield.value",
      "cart.lines.cost.amountPerQuantity.amount",
    ];
    for (const p of needed) expect(paths.has(p), "missing: " + p).toBe(true);
  });
  it("inCollections ids equal the exported constant and my own Club Pricing literal", () => {
    const a = args["cart.lines.merchandise.product.inCollections"];
    expect(a.length).toBe(1);
    expect(a[0].name.value).toBe("ids");
    const ids = a[0].value.values.map((v) => v.value);
    expect(ids).toEqual(ELIGIBLE_COLLECTION_IDS);
    expect(ids).toEqual([CLUB]);
  });
  it("metafield asked as custom.cost_price, product metafield not variant", () => {
    const a = args["cart.lines.merchandise.product.metafield"].map((x) => `${x.name.value}=${x.value.value}`).sort();
    expect(a).toEqual(["key=cost_price", "namespace=custom"]);
  });
  it("the tag list in the query contains every tag the code's tiers use, and nothing the oracle does not know", () => {
    const qTags = args["cart.buyerIdentity.customer.hasTags"][0].value.values.map((v) => v.value);
    expect(qTags.sort()).toEqual([...TAG_QUERY].sort());
    const codeTags = [...SRC_JS.matchAll(/new Set\(\[([^\]]*)\]\)/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
    expect(codeTags.sort()).toEqual([...TAG_QUERY].sort());
  });
  it("no leftover reads of fields that are not requested (scan the source for property reads on input objects)", () => {
    for (const bad of ["compareAtPrice", "variant.price", "totalAmount", "subtotalAmount", "sellingPlan", "attribute"]) expect(SRC_JS.includes(bad), bad).toBe(false);
  });
});

describe("round 3 pins: allowances twin 1, triplet 2, quad-and-above 6 (every total worked by hand, retail 20, cost 8 unless stated)", () => {
  it("twin, one product, 3 units on one line: [1 full, 1 cost, 1 full] = 20 + 8 + 20 = 48", () => {
    const i = cart([mk(3, { product: 1, variant: 11 })], { held: ["twin"] });
    const out = repoRun(i);
    const items = out.operations[0].lineExpand.expandedCartItems;
    expect(items.map((x) => [x.quantity, x.price ? x.price.adjustment.fixedPricePerUnit.amount : null])).toEqual([[1, null], [1, "8.00"], [1, null]]);
    expect(run("pin-twin-3", i).total).toBe(48);
  });
  it("twin, same product on two sizes 1+1: first full (no operation), second at cost = 20 + 8 = 28", () => {
    const i = cart([mk(1, { product: 1, variant: 11 }), mk(1, { product: 1, variant: 12 })], { held: ["twin"] });
    const out = repoRun(i);
    expect(out.operations.length).toBe(1);
    expect(out.operations[0].lineExpand.cartLineId).toBe(i.cart.lines[1].id);
    expect(out.operations[0].lineExpand.expandedCartItems.length).toBe(1);
    expect(run("pin-twin-1+1", i).total).toBe(28);
  });
  it("twin, 5 units over two sizes 2+3: F C | F F F = 20+8+60 = 88 (only ONE at cost)", () => {
    const i = cart([mk(2, { product: 1, variant: 11 }), mk(3, { product: 1, variant: 12 })], { held: ["twin"] });
    expect(run("pin-twin-2+3", i).total).toBe(88);
  });
  it("triplet, 4 units across two colours, 2+2 (A cost 8 retail 20, B cost 9.50 retail 25): F20, C8 | C9.50, F25 = 62.50", () => {
    const i = cart([mk(2, { product: 1 }), mk(2, { product: 2, retail: 25, cost: 9.5 })], { held: ["triplet"] });
    expect(run("pin-triplet-2+2", i).total).toBe(62.5);
  });
  it("triplet, 4 units across two colours, 1+3: F20 | C9.50, C9.50, F25 = 64.00", () => {
    const i = cart([mk(1, { product: 1 }), mk(3, { product: 2, retail: 25, cost: 9.5 })], { held: ["triplet"] });
    expect(run("pin-triplet-1+3", i).total).toBe(64);
  });
  it("triplet, 4 units across two colours, 3+1: F20, C8, C8 | F25 = 61.00 (second colour gets nothing)", () => {
    const i = cart([mk(3, { product: 1 }), mk(1, { product: 2, retail: 25, cost: 9.5 })], { held: ["triplet"] });
    const r = run("pin-triplet-3+1", i);
    expect(r.total).toBe(61);
    expect(r.act[1].op).toBeNull();
  });
  it("twin + triplet tags together: highest tier is triplet = 2 at cost; 5 units = F C C F F = 20+8+8+20+20 = 76", () => {
    const i = cart([mk(5, { product: 1 })], { held: ["twin", "triplet"] });
    expect(run("pin-twin+triplet", i).total).toBe(76);
  });
  it("twin tag + quad tag together: 6 at cost; 8 units = F + 6C + F = 20 + 48 + 20 = 88", () => {
    const i = cart([mk(8, { product: 1 })], { held: ["twin", "quad"] });
    expect(run("pin-twin+quad", i).total).toBe(88);
  });
  it("quad unchanged at 6: 3+3 = 60.00 and 9 units = F + 6C + 2F = 20+48+40 = 108", () => {
    expect(run("pin-quad-3+3", cart([mk(3, { product: 1, variant: 11 }), mk(3, { product: 1, variant: 12 })], { held: ["quad"] })).total).toBe(60);
    expect(run("pin-quad-9", cart([mk(9, { product: 1 })], { held: ["quad"] })).total).toBe(108);
  });
  it("the module under test really carries 1/2/6 (probe: unit counts at cost for 10 units per tier)", () => {
    const count = (held) => repoRun(cart([mk(10, { product: 1 })], { held })).operations[0].lineExpand.expandedCartItems.filter((x) => x.price).reduce((s, x) => s + x.quantity, 0);
    expect([count(["twin"]), count(["triplet"]), count(["quad"])]).toEqual([1, 2, 6]);
  });
});
