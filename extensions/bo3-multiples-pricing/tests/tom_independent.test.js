// Tom's independent verification of cartTransformRun. Written without reference to Lex's tests.
// Oracle: customer total = sum of unit prices, computed from the RULE, not from the code.
import { describe, it, expect } from "vitest";
import { cartTransformRun } from "../src/cart_transform_run.js";

const TAGS = ["twin","twins","twin-fam","amba-twin","triplet","triplets","triplet-fam","amba-triplet","amba-quad","hero","quad","quads","amba","amba-member"];
// Round 3 (Cheyne 2026-10-25): twin 1, triplet 2, quad-and-above 6. Single tier table; every expected value below derives from it.
const ALLOW = { twin: 1, triplet: 2, quad: 6 };
const REP = { twin: "twin", triplet: "triplet", quad: "quad" };

const hasTags = (held, mapCase = (s) => s) => TAGS.map((t) => ({ tag: mapCase(t), hasTag: held.includes(t) }));
const meta = (amount, cc = "AUD") => ({ value: JSON.stringify({ amount, currency_code: cc }) });
function mkLine(id, qty, { product = 1, variant = product, retail = "20.00", metafield = meta("8.00") } = {}) {
  return {
    id: `gid://shopify/CartLine/${id}`, quantity: qty,
    merchandise: { __typename: "ProductVariant", id: `gid://shopify/ProductVariant/${variant}`,
      // Round 2 (Lex): lines must be members of The Club Pricing to be eligible; added so these cases keep exercising the rule.
      product: { id: `gid://shopify/Product/${product}`, inCollections: [{ collectionId: "gid://shopify/Collection/330356261047", isMember: true }], metafield } },
    cost: { amountPerQuantity: { amount: retail, currencyCode: "AUD" } },
  };
}
function mkInput(lines, { held = ["twin"], rate = 1, customer = true, tagList } = {}) {
  const input = { cart: { buyerIdentity: { customer: customer ? { hasTags: tagList !== undefined ? tagList : hasTags(held) } : null }, lines } };
  if (rate !== "ABSENT") input.presentmentCurrencyRate = rate;
  return input;
}
// Total implied by the output: per cart line, sum qty * (fixed amount else retail unit price).
function impliedTotal(input, out) {
  let total = 0;
  for (const l of input.cart.lines) {
    const retail = parseFloat(l.cost.amountPerQuantity.amount);
    const op = out.operations.find((o) => o.lineExpand.cartLineId === l.id);
    if (!op) { total += l.quantity * retail; continue; }
    for (const it of op.lineExpand.expandedCartItems) {
      const fixed = it.price?.adjustment?.fixedPricePerUnit?.amount;
      total += it.quantity * (fixed !== undefined ? parseFloat(fixed) : retail);
    }
  }
  return Math.round(total * 100) / 100;
}
function safeCost(v) { try { const c = JSON.parse(v ?? "null"); return c && typeof c.amount === "string" && typeof c.currency_code === "string" ? c : null; } catch { return null; } }
// RULE oracle, per design (product), single price per product.
function ruleTotal(lines, allowance, rate = 1) {
  const byProd = new Map();
  for (const l of lines) {
    const p = l.merchandise.product.id;
    const e = byProd.get(p) ?? { n: 0, retail: parseFloat(l.cost.amountPerQuantity.amount), cost: safeCost(l.merchandise.product.metafield?.value) };
    e.n += l.quantity; byProd.set(p, e);
  }
  let t = 0;
  for (const e of byProd.values()) {
    const c = e.cost ? parseFloat(e.cost.amount) * rate : NaN;
    const ok = allowance > 0 && Number.isFinite(c) && c > 0 && c < e.retail && e.n >= 2;
    const atCost = ok ? Math.min(e.n - 1, allowance) : 0;
    t += e.n * e.retail - atCost * (ok ? e.retail - parseFloat(c.toFixed(2)) : 0);
  }
  return Math.round(t * 100) / 100;
}
const conserved = (input, out) => {
  for (const op of out.operations) {
    const src = input.cart.lines.find((l) => l.id === op.lineExpand.cartLineId);
    expect(op.lineExpand.expandedCartItems.reduce((s, i) => s + i.quantity, 0)).toBe(src.quantity);
  }
};
function checkShape(out) {
  expect(Object.keys(out)).toEqual(["operations"]);
  for (const op of out.operations) {
    expect(Object.keys(op)).toEqual(["lineExpand"]);
    expect(JSON.stringify(op)).not.toContain("currencyCode");
    for (const it of op.lineExpand.expandedCartItems) {
      expect(typeof it.merchandiseId).toBe("string");
      expect(Number.isInteger(it.quantity) && it.quantity > 0).toBe(true);
      if (it.price !== undefined) {
        expect(Object.keys(it.price)).toEqual(["adjustment"]);
        expect(Object.keys(it.price.adjustment)).toEqual(["fixedPricePerUnit"]);
        expect(Object.keys(it.price.adjustment.fixedPricePerUnit)).toEqual(["amount"]);
        expect(it.price.adjustment.fixedPricePerUnit.amount).toMatch(/^\d+\.\d{2}$/);
      }
    }
  }
}

describe("single product, quantities 1..12, each tier", () => {
  for (const [tier, allow] of Object.entries(ALLOW)) {
    for (let q = 1; q <= 12; q++) {
      it(`${tier} qty ${q}`, () => {
        const input = mkInput([mkLine(1, q)], { held: [REP[tier]] });
        const out = cartTransformRun(input);
        conserved(input, out); checkShape(out);
        const atCost = q >= 2 ? Math.min(q - 1, allow) : 0;
        const expected = q * 20 - atCost * 12; // 20.00 retail, 8.00 cost
        expect(impliedTotal(input, out)).toBe(expected);
        expect(impliedTotal(input, out)).toBe(ruleTotal(input.cart.lines, allow));
      });
    }
  }
});

describe("multi-line", () => {
  // Round 2 (Lex): allowance is now pooled per collection, so products no longer get separate allowances. Round 3: twin allowance is 1, so pool: 1 full, 1 at cost, then full (line 1 = 68), line 2 all full (120).
  it("two different products in the same collection share one allowance (pooled)", () => {
    const lines = [mkLine(1, 4, { product: 1 }), mkLine(2, 4, { product: 2, retail: "30.00", metafield: meta("10.00") })];
    const input = mkInput(lines, { held: ["twin"] });
    const out = cartTransformRun(input); conserved(input, out); checkShape(out);
    expect(impliedTotal(input, out)).toBe(4 * 20 - ALLOW.twin * 12 + 4 * 30);
  });
  it("two lines of the same product, qty 2 + 2, twin: rule total", () => {
    const input = mkInput([mkLine(1, 2), mkLine(2, 2)], { held: ["twin"] });
    const out = cartTransformRun(input); conserved(input, out);
    expect(impliedTotal(input, out)).toBe(ruleTotal(input.cart.lines, ALLOW.twin));
  });
  // Round 2 (Lex): these two were it.fails (DEFECT?). Pooling by collection now produces the per-collection totals, so they are ordinary assertions.
  it("same product, two lines 3 + 3, quad: 5 at cost", () => {
    const input = mkInput([mkLine(1, 3), mkLine(2, 3)], { held: ["quad"] });
    const out = cartTransformRun(input);
    expect(impliedTotal(input, out)).toBe(ruleTotal(input.cart.lines, 6));
  });
  it("same product, two lines 1 + 1, twin: second unit at cost", () => {
    const input = mkInput([mkLine(1, 1), mkLine(2, 1, { variant: 11 })], { held: ["twin"] });
    const out = cartTransformRun(input);
    expect(impliedTotal(input, out)).toBe(ruleTotal(input.cart.lines, ALLOW.twin));
  });
  it("same product, two lines 1 + 3, twin: matches rule (1 at cost, allowance 1)", () => {
    const input = mkInput([mkLine(1, 1), mkLine(2, 3, { variant: 11 })], { held: ["twin"] });
    const out = cartTransformRun(input);
    expect(impliedTotal(input, out)).toBe(ruleTotal(input.cart.lines, ALLOW.twin));
  });
});

describe("cost price edge cases", () => {
  for (const [name, cost] of [["equal to retail", "20.00"], ["above retail", "25.00"]]) {
    it(`cost ${name}: no discount, full retail`, () => {
      const input = mkInput([mkLine(1, 5, { metafield: meta(cost) })], { held: ["quad"] });
      const out = cartTransformRun(input); expect(out.operations).toEqual([]);
      expect(impliedTotal(input, out)).toBe(100);
    });
  }
  for (const [name, mf] of [
    ["not JSON", { value: "nope{" }], ["missing amount", { value: '{"currency_code":"AUD"}' }],
    ["amount numeric not string", { value: '{"amount":8,"currency_code":"AUD"}' }],
    ["amount zero", meta("0.00")], ["amount negative", meta("-3.00")], ["amount abc", meta("abc")],
    ["null metafield", null], ["empty value", { value: "" }], ["JSON null", { value: "null" }],
  ]) {
    it(`malformed metafield (${name}): no operations, full retail`, () => {
      const input = mkInput([mkLine(1, 4, { metafield: mf })], { held: ["quad"] });
      const out = cartTransformRun(input);
      expect(out.operations).toEqual([]); expect(impliedTotal(input, out)).toBe(80);
    });
  }
});

describe("customer and tags", () => {
  const lines = () => [mkLine(1, 4)];
  it("missing customer", () => { const i = mkInput(lines(), { customer: false }); expect(cartTransformRun(i).operations).toEqual([]); });
  it("buyerIdentity null", () => { const i = { presentmentCurrencyRate: 1, cart: { buyerIdentity: null, lines: lines() } }; expect(cartTransformRun(i).operations).toEqual([]); });
  it("hasTag all false", () => { const i = mkInput(lines(), { held: [] }); expect(cartTransformRun(i).operations).toEqual([]); });
  it("hasTags null", () => { const i = mkInput(lines(), { tagList: null }); expect(cartTransformRun(i).operations).toEqual([]); });
  it("two tags from different tiers: higher wins", () => {
    const i = mkInput([mkLine(1, 12)], { held: ["twin", "triplet"] });
    const o = cartTransformRun(i); conserved(i, o); expect(impliedTotal(i, o)).toBe(12 * 20 - ALLOW.triplet * 12);
    const j = mkInput([mkLine(1, 12)], { held: ["twins", "hero", "triplets"] });
    expect(impliedTotal(j, cartTransformRun(j))).toBe(12 * 20 - 6 * 12);
  });
  it("every one of the 14 tags resolves to its tier", () => {
    const tier = (t) => (["twin","twins","twin-fam","amba-twin"].includes(t) ? ALLOW.twin : ["triplet","triplets","triplet-fam","amba-triplet"].includes(t) ? ALLOW.triplet : ALLOW.quad);
    for (const t of TAGS) { const i = mkInput([mkLine(1, 12)], { held: [t] }); expect(impliedTotal(i, cartTransformRun(i))).toBe(240 - tier(t) * 12); }
  });
  it("mixed-case tag strings in results are matched (lowercased in code)", () => {
    const i = mkInput([mkLine(1, 4)], { tagList: [{ tag: "TWIN", hasTag: true }, { tag: " Triplet ", hasTag: false }] });
    expect(impliedTotal(i, cartTransformRun(i))).toBe(80 - ALLOW.twin * 12);
  });
  it("mixed-case tag with hasTag false never grants", () => {
    const i = mkInput([mkLine(1, 4)], { tagList: [{ tag: "Quad", hasTag: false }] });
    expect(cartTransformRun(i).operations).toEqual([]);
  });
  it("hasTag truthy but not true (string) does not grant", () => {
    const i = mkInput([mkLine(1, 4)], { tagList: [{ tag: "twin", hasTag: "true" }] });
    expect(cartTransformRun(i).operations).toEqual([]);
  });
  it("unknown tag with hasTag true does not grant", () => {
    const i = mkInput([mkLine(1, 4)], { tagList: [{ tag: "vip", hasTag: true }] });
    expect(cartTransformRun(i).operations).toEqual([]);
  });
});

describe("presentmentCurrencyRate", () => {
  const run = (rate) => { const i = mkInput([mkLine(1, 4)], { held: ["twin"], rate }); const o = cartTransformRun(i); conserved(i, o); checkShape(o); return [i, o]; };
  it("absent treated as 1", () => { const [i, o] = run("ABSENT"); expect(impliedTotal(i, o)).toBe(80 - ALLOW.twin * 12); });
  it("null treated as 1", () => { const [i, o] = run(null); expect(impliedTotal(i, o)).toBe(80 - ALLOW.twin * 12); });
  it("1", () => { const [i, o] = run(1); expect(impliedTotal(i, o)).toBe(80 - ALLOW.twin * 12); });
  it("0.65: cost 8.00 becomes 5.20", () => { const [i, o] = run(0.65); expect(o.operations[0].lineExpand.expandedCartItems[1].price.adjustment.fixedPricePerUnit.amount).toBe("5.20"); expect(impliedTotal(i, o)).toBe(80 - ALLOW.twin * (20 - 5.2)); });
  it('"0.65" string', () => { const [i, o] = run("0.65"); expect(impliedTotal(i, o)).toBe(80 - ALLOW.twin * (20 - 5.2)); });
  it("0: no discount, full retail", () => { const [i, o] = run(0); expect(o.operations).toEqual([]); expect(impliedTotal(i, o)).toBe(80); });
  it('"abc": no discount, full retail', () => { const [i, o] = run("abc"); expect(o.operations).toEqual([]); expect(impliedTotal(i, o)).toBe(80); });
  it("negative and NaN: no discount", () => { for (const r of [-1, NaN, Infinity]) { const [i, o] = run(r); expect(impliedTotal(i, o)).toBe(80); } });
  it("rate lifts cost to/above retail: guard compares converted cost", () => { const [i, o] = run(2.5); expect(o.operations).toEqual([]); expect(impliedTotal(i, o)).toBe(80); });
});

describe("other line shapes", () => {
  it("non-ProductVariant merchandise ignored", () => {
    const l = mkLine(1, 4); l.merchandise.__typename = "CustomProduct";
    expect(cartTransformRun(mkInput([l])).operations).toEqual([]);
  });
  it("empty cart, missing cart", () => {
    expect(cartTransformRun(mkInput([])).operations).toEqual([]);
    expect(cartTransformRun({ presentmentCurrencyRate: 1 }).operations).toEqual([]);
  });
});

// Seeded PRNG (mulberry32)
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe("random carts (seed 20261025, 400 carts)", () => {
  it("invariants hold", () => {
    const r = rng(20261025);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const money = (lo, hi) => (lo + r() * (hi - lo)).toFixed(2);
    const rates = [1, 0.65, 1.5, "0.72", undefined, 0, "abc"];
    let withOps = 0, ruleMismatch = 0;
    for (let n = 0; n < 400; n++) {
      const held = pick([[], ["twin"], ["triplet"], ["quad"], ["twin", "hero"], ["amba-member", "triplets"]]);
      const nLines = 1 + Math.floor(r() * 5);
      const lines = [];
      const prodRetail = {}, prodMeta = {};
      for (let k = 0; k < nLines; k++) {
        const product = 1 + Math.floor(r() * 3);
        prodRetail[product] ??= money(5, 60);
        if (!(product in prodMeta)) prodMeta[product] = pick([meta(money(1, 70)), meta(money(1, 10)), { value: "garbage" }, null, meta(money(1, 10))]);
        lines.push(mkLine(k + 1, 1 + Math.floor(r() * 14), { product, variant: product * 10 + (k % 2), retail: prodRetail[product], metafield: prodMeta[product] }));
      }
      const rate = pick(rates);
      const input = mkInput(lines, { held, rate: rate === undefined ? "ABSENT" : rate, customer: r() > 0.1 });
      const out = cartTransformRun(input);
      checkShape(out); conserved(input, out);
      if (out.operations.length) withOps++;
      const eff = rate === undefined ? 1 : (typeof rate === "number" ? rate : parseFloat(rate));
      for (const op of out.operations) {
        const src = lines.find((l) => l.id === op.lineExpand.cartLineId);
        const retail = parseFloat(src.cost.amountPerQuantity.amount);
        const cost = parseFloat(JSON.parse(src.merchandise.product.metafield.value).amount) * eff;
        for (const it of op.lineExpand.expandedCartItems) {
          const p = it.price ? parseFloat(it.price.adjustment.fixedPricePerUnit.amount) : retail;
          expect(p).toBeLessThanOrEqual(retail + 1e-9);
          if (it.price) expect(p).toBeGreaterThanOrEqual(cost - 0.005 - 1e-9); // 2dp rounding tolerance
        }
      }
      expect(impliedTotal(input, out)).toBeLessThanOrEqual(lines.reduce((s, l) => s + l.quantity * parseFloat(l.cost.amountPerQuantity.amount), 0) + 0.005);
      // Informational: how often does per-line behaviour differ from the per-design rule
      const tierAllow = Math.max(0, ...held.map((h) => ALLOW[h] ?? ALLOW[h === "hero" || h === "amba-member" ? "quad" : h.startsWith("triplet") ? "triplet" : "twin"]));
      // Round 2 (Lex): ruleTotal is a per-product oracle; pooling across products legitimately differs from it in either direction, so the hard bound (d >= -0.011) is dropped and the difference stays informational.
      if (input.cart.buyerIdentity.customer && Number.isFinite(eff) && eff > 0) { const d = impliedTotal(input, out) - ruleTotal(lines, tierAllow, eff); if (Math.abs(d) > 0.011) ruleMismatch++; }
    }
    expect(withOps).toBeGreaterThan(50);
    console.log(`random carts: 400, with operations: ${withOps}, differing from per-product oracle (expected under pooling): ${ruleMismatch}`);
  });
});
