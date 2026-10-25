// @ts-check

/**
 * Ported from src/run.js (pre-port main at 405b190). Pricing behaviour is
 * unchanged; only the input/output shapes differ, as the current Shopify
 * Functions API requires:
 *   - customer tags come from hasTags entries where hasTag is true
 *   - the output operation is lineExpand (not expand)
 *   - fixedPricePerUnit takes amount only (no currencyCode)
 *   - the at-cost amount is multiplied by presentmentCurrencyRate
 *
 * Round 2 (Cheyne, 2026-10-25): allowance is no longer per product. At-cost units
 * are pooled per eligible collection across all eligible lines (see cartTransformRun).
 */

const DISCOUNT_TITLE = "Multiples Pricing";
// Collections whose products pool at-cost units (decided by Cheyne 2026-10-25).
// "The Club Pricing". These IDs must also appear literally in
// src/cart_transform_run.graphql (inCollections ids); a test fails if they differ.
export const ELIGIBLE_COLLECTION_IDS = ["gid://shopify/Collection/330356261047"];

const TIERS = [
  { tags: new Set(["twin", "twins", "twin-fam", "amba-twin"]), maxAdditional: 2 },
  { tags: new Set(["triplet", "triplets", "triplet-fam", "amba-triplet"]), maxAdditional: 3 },
  { tags: new Set(["amba-quad", "hero", "quad", "quads", "amba", "amba-member"]), maxAdditional: 6 },
];

function resolveMaxAdditional(customerTags) {
  if (!customerTags || customerTags.length === 0) return 0;
  const tagSet = new Set(customerTags.map((t) => t.toLowerCase().trim()));
  let resolved = 0;
  for (const tier of TIERS) {
    for (const tag of tagSet) {
      if (tier.tags.has(tag)) { resolved = Math.max(resolved, tier.maxAdditional); break; }
    }
  }
  return resolved;
}

function parseCostPrice(metafieldValue) {
  if (!metafieldValue) return null;
  try {
    const parsed = JSON.parse(metafieldValue);
    const amount = parsed?.amount;
    const currencyCode = parsed?.currency_code;
    if (typeof amount !== "string" || typeof currencyCode !== "string") return null;
    const numericAmount = parseFloat(amount);
    if (isNaN(numericAmount) || numericAmount <= 0) return null;
    return { amount: amount.trim(), currencyCode: currencyCode.trim() };
  } catch { return null; }
}

/**
 * Tags the customer actually holds, from the hasTags query result.
 * @param {{ tag: string, hasTag: boolean }[] | null | undefined} hasTags
 * @returns {string[]}
 */
function heldTags(hasTags) {
  return (hasTags ?? []).filter((entry) => entry && entry.hasTag === true).map((entry) => entry.tag);
}

/**
 * presentmentCurrencyRate may arrive as a number or a decimal string.
 * Missing (undefined or null) is treated as 1.0. Present but not a positive
 * finite number is invalid and yields null.
 */
function parseRate(rate) {
  if (rate === undefined || rate === null) return 1;
  const n = typeof rate === "number" ? rate : parseFloat(String(rate));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pool key for a product: the first collection in ELIGIBLE_COLLECTION_IDS (constant
 * order) of which the product is a member, or null if it is in none of them.
 */
function poolKeyFor(product) {
  const memberships = product?.inCollections;
  if (!Array.isArray(memberships)) return null;
  for (const id of ELIGIBLE_COLLECTION_IDS) {
    if (memberships.some((m) => m && m.collectionId === id && m.isMember === true)) return id;
  }
  return null;
}

/**
 * Pooled collection pricing.
 * Eligible lines (product in an eligible collection, plus the guards below) share one
 * pool per eligible collection. Walking lines in order, unit by unit: the first unit in
 * a pool is full price; after that each unit is at cost until the tier allowance of
 * at-cost units for that pool is used; units beyond that are full price.
 * Each at-cost unit is priced at its own line's product cost (times presentmentCurrencyRate).
 * Guards run BEFORE any pool state is touched: a line failing a guard neither gets a
 * discount nor uses allowance nor counts as the pool's first unit.
 *
 * @param {any} input
 * @returns {{ operations: any[] }}
 */
export function cartTransformRun(input) {
  const operations = [];
  const customer = input.cart?.buyerIdentity?.customer;
  if (!customer) return { operations };
  const maxAdditional = resolveMaxAdditional(heldTags(customer.hasTags));
  if (maxAdditional === 0) return { operations };
  const rate = parseRate(input.presentmentCurrencyRate);
  if (rate === null) return { operations };
  const lines = input.cart?.lines ?? [];
  /** @type {Map<string, { started: boolean, used: number }>} */
  const pools = new Map();
  for (const line of lines) {
    const merchandise = line.merchandise;
    if (!merchandise || merchandise.__typename !== "ProductVariant") continue;
    if (!merchandise.product?.id) continue;
    const poolKey = poolKeyFor(merchandise.product);
    if (poolKey === null) continue;
    const lineQty = line.quantity ?? 0;
    if (!Number.isInteger(lineQty) || lineQty < 1) continue;
    const costPrice = parseCostPrice(merchandise.product?.metafield?.value);
    if (!costPrice) continue;
    const retailAmount = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    // Cost is converted to the presentment currency before comparing with retail.
    const costAmount = parseFloat(costPrice.amount) * rate;
    if (isNaN(retailAmount) || isNaN(costAmount) || costAmount >= retailAmount) continue;

    // Candidate line: walk its units against the pool.
    const pool = pools.get(poolKey) ?? { started: false, used: 0 };
    pools.set(poolKey, pool);
    const groups = []; // run-length groups: { atCost, quantity }
    let anyAtCost = false;
    for (let unit = 0; unit < lineQty; unit++) {
      let atCost;
      if (!pool.started) {
        pool.started = true;
        atCost = false;
      } else if (pool.used < maxAdditional) {
        pool.used += 1;
        atCost = true;
        anyAtCost = true;
      } else {
        atCost = false;
      }
      const last = groups[groups.length - 1];
      if (last && last.atCost === atCost) last.quantity += 1;
      else groups.push({ atCost, quantity: 1 });
    }
    if (!anyAtCost) continue;
    const amount = costAmount.toFixed(2);
    const expandedItems = groups.map((g) =>
      g.atCost
        ? { merchandiseId: merchandise.id, quantity: g.quantity, price: { adjustment: { fixedPricePerUnit: { amount } } } }
        : { merchandiseId: merchandise.id, quantity: g.quantity },
    );
    operations.push({
      lineExpand: { cartLineId: line.id, title: DISCOUNT_TITLE, expandedCartItems: expandedItems },
    });
  }
  return { operations };
}
