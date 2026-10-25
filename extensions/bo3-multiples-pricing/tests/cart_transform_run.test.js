import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { cartTransformRun as cartTransformRunRaw, ELIGIBLE_COLLECTION_IDS } from "../src/cart_transform_run.js";

const CLUB = "gid://shopify/Collection/330356261047";

// Every call in this file goes through this wrapper: for every operation produced,
// the expanded quantities must sum to the quantity of the cart line being expanded.
function cartTransformRun(input) {
  const result = cartTransformRunRaw(input);
  for (const op of result.operations) {
    const src = input.cart.lines.find((l) => l.id === op.lineExpand.cartLineId);
    const total = op.lineExpand.expandedCartItems.reduce((sum, i) => sum + i.quantity, 0);
    expect(total).toBe(src.quantity);
  }
  return result;
}

const ALL_TAGS = [
  "twin", "twins", "twin-fam", "amba-twin",
  "triplet", "triplets", "triplet-fam", "amba-triplet",
  "amba-quad", "hero", "quad", "quads", "amba", "amba-member",
];

// What Shopify returns for hasTags: one entry per requested tag, hasTag true or false.
function hasTags(...held) {
  return ALL_TAGS.map((tag) => ({ tag, hasTag: held.includes(tag) }));
}

function costMeta(amount = "8.00", currency_code = "AUD") {
  return { value: JSON.stringify({ amount, currency_code }) };
}

function line({ id = "gid://shopify/CartLine/1", quantity = 2, variant = 1, product = 100, retail = "20.00", metafield = costMeta(), typename = "ProductVariant", member = [CLUB] } = {}) {
  return {
    id,
    quantity,
    merchandise: {
      __typename: typename,
      id: `gid://shopify/ProductVariant/${variant}`,
      product: {
        id: `gid://shopify/Product/${product}`,
        inCollections: ELIGIBLE_COLLECTION_IDS.concat(member).filter((v, i, a) => a.indexOf(v) === i).map((collectionId) => ({ collectionId, isMember: member.includes(collectionId) })),
        metafield,
      },
    },
    cost: { amountPerQuantity: { amount: retail, currencyCode: "AUD" } },
  };
}

function cart({ tags = ["twin"], lines = [line()], rate = 1.0, customer = true } = {}) {
  return {
    presentmentCurrencyRate: rate,
    cart: {
      buyerIdentity: { customer: customer ? { hasTags: hasTags(...tags) } : null },
      lines,
    },
  };
}

const V1 = "gid://shopify/ProductVariant/1";
const full = (q, v = V1) => ({ merchandiseId: v, quantity: q });
const atCost = (q, amount = "8.00", v = V1) => ({
  merchandiseId: v,
  quantity: q,
  price: { adjustment: { fixedPricePerUnit: { amount } } },
});
const items = (result, i = 0) => result.operations[i].lineExpand.expandedCartItems;

describe("guards", () => {
  it("1. no customer: no operations", () => {
    expect(cartTransformRun(cart({ customer: false }))).toEqual({ operations: [] });
  });

  it("2. customer with no matching tag (all hasTag false): none", () => {
    expect(cartTransformRun(cart({ tags: [] }))).toEqual({ operations: [] });
  });

  it("3. twin tag, line quantity 1: none", () => {
    expect(cartTransformRun(cart({ lines: [line({ quantity: 1 })] }))).toEqual({ operations: [] });
  });

  it("non-variant merchandise (e.g. custom product) is skipped", () => {
    const l = line({ typename: "CustomProduct" });
    expect(cartTransformRun(cart({ lines: [l] }))).toEqual({ operations: [] });
  });
});

describe("expansion", () => {
  it("4. twin tag, one line quantity 2: [1 full, 1 at cost]", () => {
    const r = cartTransformRun(cart({ lines: [line({ quantity: 2 })] }));
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0].lineExpand.cartLineId).toBe("gid://shopify/CartLine/1");
    expect(r.operations[0].lineExpand.title).toBe("Multiples Pricing");
    expect(items(r)).toEqual([full(1), atCost(1)]);
  });

  // What the code does: twin allowance is 2 additional units. Quantity 4 has 3 additional.
  // First unit full price (1), 2 at cost, the 1 beyond the allowance back at full price.
  // Expanded quantities sum to 4 (also enforced for every scenario by the wrapper above).
  it("5. twin tag, one line quantity 4: [1 full, 2 at cost, 1 full]", () => {
    const r = cartTransformRun(cart({ lines: [line({ quantity: 4 })] }));
    expect(items(r)).toEqual([full(1), atCost(2), full(1)]);
  });

  it("5b. beyond-allowance quantities conserve units (twin 5, triplet 5, quad-group 9)", () => {
    expect(items(cartTransformRun(cart({ lines: [line({ quantity: 5 })] })))).toEqual([full(1), atCost(2), full(2)]);
    expect(items(cartTransformRun(cart({ tags: ["triplet"], lines: [line({ quantity: 5 })] })))).toEqual([full(1), atCost(3), full(1)]);
    expect(items(cartTransformRun(cart({ tags: ["amba-quad"], lines: [line({ quantity: 9 })] })))).toEqual([full(1), atCost(6), full(2)]);
  });

  it("6a. triplet tag, one line quantity 4: [1 full, 3 at cost]", () => {
    const r = cartTransformRun(cart({ tags: ["triplet"], lines: [line({ quantity: 4 })] }));
    expect(items(r)).toEqual([full(1), atCost(3)]);
  });

  it("6b. quad-group tag (amba-quad), one line quantity 7: [1 full, 6 at cost]", () => {
    const r = cartTransformRun(cart({ tags: ["amba-quad"], lines: [line({ quantity: 7 })] }));
    expect(items(r)).toEqual([full(1), atCost(6)]);
  });

  it("tags are matched case-insensitively and trimmed on our side", () => {
    const input = cart({ lines: [line({ quantity: 2 })] });
    input.cart.buyerIdentity.customer.hasTags = [{ tag: " Twin ", hasTag: true }];
    expect(items(cartTransformRun(input))).toEqual([full(1), atCost(1)]);
  });
});

describe("allowance shared per product", () => {
  // Round 2: one pool across all eligible lines. Line 1 = full, cost; line 2 continues the pool (1 cost left of 2), then full.
  it("7a. same product on two lines: pooled allowance (twin, 2 + 2): line 1 [full, cost], line 2 [cost, full]", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 2, variant: 1 });
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 2, variant: 2 });
    const r = cartTransformRun(cart({ lines: [l1, l2] }));
    expect(r.operations).toHaveLength(2);
    const v2 = "gid://shopify/ProductVariant/2";
    expect(items(r, 0)).toEqual([full(1), atCost(1)]);
    expect(items(r, 1)).toEqual([atCost(1, "8.00", v2), full(1, v2)]);
  });

  it("7b. allowance exhausted by the first line: second line of the same product is skipped", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 3, variant: 1 }); // uses 2 of 2
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 2, variant: 2 });
    const r = cartTransformRun(cart({ lines: [l1, l2] }));
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0].lineExpand.cartLineId).toBe("gid://shopify/CartLine/1");
    expect(items(r)).toEqual([full(1), atCost(2)]);
  });

  // Round 2: allowance is pooled per collection, not per product, so line 2 (different product) gets nothing once line 1 used it.
  it("7c. different products in the same collection share ONE allowance (twin, 3 + 3)", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 3, product: 100 });
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 3, product: 200, variant: 2 });
    const r = cartTransformRun(cart({ lines: [l1, l2] }));
    expect(r.operations).toHaveLength(1);
    expect(items(r)).toEqual([full(1), atCost(2)]);
  });
})

describe("cost price validation", () => {
  const skipped = (metafield, retail = "20.00") =>
    expect(cartTransformRun(cart({ lines: [line({ metafield, retail })] }))).toEqual({ operations: [] });

  it("8a. cost price missing (no metafield)", () => skipped(null));
  it("8b. cost price malformed (not JSON)", () => skipped({ value: "8.00" }));
  it("8c. cost price malformed (amount not a string)", () => skipped({ value: JSON.stringify({ amount: 8, currency_code: "AUD" }) }));
  it("8d. cost price zero", () => skipped(costMeta("0.00")));
  it("8e. cost price equal to retail", () => skipped(costMeta("20.00")));
  it("8f. cost price above retail", () => skipped(costMeta("25.00")));

  it("8g. a bad line is skipped while a good line still expands", () => {
    const bad = line({ id: "gid://shopify/CartLine/1", product: 100, metafield: null });
    const good = line({ id: "gid://shopify/CartLine/2", product: 200, variant: 2 });
    const r = cartTransformRun(cart({ lines: [bad, good] }));
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0].lineExpand.cartLineId).toBe("gid://shopify/CartLine/2");
  });
});

describe("presentmentCurrencyRate", () => {
  it("9a. rate 1.0: at-cost amount is 8.00", () => {
    const r = cartTransformRun(cart({ rate: 1.0, lines: [line({ quantity: 2, retail: "20.00" })] }));
    expect(items(r)[1].price.adjustment.fixedPricePerUnit.amount).toBe("8.00");
  });

  it("9b. rate 0.65 (as a number): 8.00 becomes 5.20", () => {
    const r = cartTransformRun(cart({ rate: 0.65, lines: [line({ quantity: 2, retail: "13.00" })] }));
    expect(items(r)[1].price.adjustment.fixedPricePerUnit.amount).toBe("5.20");
  });

  it("9c. rate 0.65 (as a decimal string) behaves the same", () => {
    const r = cartTransformRun(cart({ rate: "0.65", lines: [line({ quantity: 2, retail: "13.00" })] }));
    expect(items(r)[1].price.adjustment.fixedPricePerUnit.amount).toBe("5.20");
  });

  it("9d. amount always has exactly two decimals (7.77 x 0.65 = 5.0505 -> 5.05; 8 x 1 -> 8.00)", () => {
    const a = cartTransformRun(cart({ rate: 0.65, lines: [line({ quantity: 2, retail: "13.00", metafield: costMeta("7.77") })] }));
    expect(items(a)[1].price.adjustment.fixedPricePerUnit.amount).toBe("5.05");
    const b = cartTransformRun(cart({ rate: 1, lines: [line({ quantity: 2, metafield: costMeta("8") })] }));
    expect(items(b)[1].price.adjustment.fixedPricePerUnit.amount).toBe("8.00");
    expect(items(b)[1].price.adjustment.fixedPricePerUnit.amount).toMatch(/^\d+\.\d{2}$/);
  });

  it("9e. cost-below-retail guard compares in presentment currency (8.00 x 2 = 16.00 is not below 13.00)", () => {
    const r = cartTransformRun(cart({ rate: 2, lines: [line({ quantity: 2, retail: "13.00" })] }));
    expect(r).toEqual({ operations: [] });
  });

  it("9f. missing rate is treated as 1.0; invalid rate (0, negative, text) yields no operations", () => {
    const missing = cart({ lines: [line({ quantity: 2 })] });
    delete missing.presentmentCurrencyRate;
    expect(items(cartTransformRun(missing))[1].price.adjustment.fixedPricePerUnit.amount).toBe("8.00");
    for (const bad of [0, -1, "abc"]) {
      expect(cartTransformRun(cart({ rate: bad }))).toEqual({ operations: [] });
    }
  });
});

describe("tier resolution and output shape", () => {
  it("10. customer holds twin and amba-quad: the larger allowance (6) wins", () => {
    const r = cartTransformRun(cart({ tags: ["twin", "amba-quad"], lines: [line({ quantity: 7 })] }));
    expect(items(r)).toEqual([full(1), atCost(6)]);
  });

  it("10b. customer holds twin and triplet: allowance 3 wins", () => {
    const r = cartTransformRun(cart({ tags: ["twin", "triplet"], lines: [line({ quantity: 4 })] }));
    expect(items(r)).toEqual([full(1), atCost(3)]);
  });

  it("11. output has only the key lineExpand per operation and no currencyCode anywhere", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 3, product: 100 });
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 2, product: 200, variant: 2 });
    const r = cartTransformRun(cart({ tags: ["triplet"], lines: [l1, l2], rate: 0.65 }));
    expect(Object.keys(r)).toEqual(["operations"]);
    for (const op of r.operations) expect(Object.keys(op)).toEqual(["lineExpand"]);
    expect(JSON.stringify(r)).not.toContain("currencyCode");
    for (const op of r.operations) {
      expect(Object.keys(op.lineExpand).sort()).toEqual(["cartLineId", "expandedCartItems", "title"]);
    }
  });

  it("returns { operations: [] } for an empty cart", () => {
    expect(cartTransformRun(cart({ lines: [] }))).toEqual({ operations: [] });
  });
});

// ---------------------------------------------------------------------------
// Round 2: pooled at-cost units per eligible collection.
// Rule: first unit in a pool is full; then at cost until the tier allowance of
// at-cost units is used; units beyond are full. Guards run before the pool is touched.
// ---------------------------------------------------------------------------
describe("round 2: collection pooling", () => {
  const L = (n) => `gid://shopify/CartLine/${n}`;
  const V = (n) => `gid://shopify/ProductVariant/${n}`;
  const ops = (r) => r.operations.map((o) => o.lineExpand.cartLineId);

  it("twin family, same colour two sizes (1 + 1): line 1 [1 full] (no operation), line 2 [1 cost] (single item)", () => {
    const r = cartTransformRun(cart({ lines: [
      line({ id: L(1), quantity: 1, product: 100, variant: 1 }),
      line({ id: L(2), quantity: 1, product: 100, variant: 2 }),
    ] }));
    expect(ops(r)).toEqual([L(2)]);
    expect(items(r)).toEqual([atCost(1, "8.00", V(2))]);
  });

  it("twin family, two colours one size each: second colour at ITS OWN cost price", () => {
    const r = cartTransformRun(cart({ lines: [
      line({ id: L(1), quantity: 1, product: 100, variant: 1, metafield: costMeta("8.00") }),
      line({ id: L(2), quantity: 1, product: 200, variant: 2, metafield: costMeta("9.50") }),
    ] }));
    expect(ops(r)).toEqual([L(2)]);
    expect(items(r)).toEqual([atCost(1, "9.50", V(2))]);
  });

  it("three lines across two products (twin): [full] / [cost] / [cost, full]", () => {
    const r = cartTransformRun(cart({ lines: [
      line({ id: L(1), quantity: 1, product: 100, variant: 1 }),
      line({ id: L(2), quantity: 1, product: 200, variant: 2 }),
      line({ id: L(3), quantity: 2, product: 100, variant: 3 }),
    ] }));
    expect(ops(r)).toEqual([L(2), L(3)]);
    expect(items(r, 0)).toEqual([atCost(1, "8.00", V(2))]);
    expect(items(r, 1)).toEqual([atCost(1, "8.00", V(3)), full(1, V(3))]);
  });

  // Brief said "total 72.00"; the rule gives 20.00 + 5 x 8.00 = 60.00 at retail 20.00 / cost 8.00. Asserting the rule.
  it("quad family 3 + 3 across two sizes: 6 units, 1 full, 5 at cost, total 60.00", () => {
    const r = cartTransformRun(cart({ tags: ["quad"], lines: [
      line({ id: L(1), quantity: 3, product: 100, variant: 1 }),
      line({ id: L(2), quantity: 3, product: 100, variant: 2 }),
    ] }));
    expect(items(r, 0)).toEqual([full(1), atCost(2)]);
    expect(items(r, 1)).toEqual([atCost(3, "8.00", V(2))]);
    let total = 0;
    for (const op of r.operations) for (const i of op.lineExpand.expandedCartItems) {
      total += i.quantity * (i.price ? parseFloat(i.price.adjustment.fixedPricePerUnit.amount) : 20);
    }
    expect(total.toFixed(2)).toBe("60.00");
  });

  it("allowance exhausted mid-line (twin): 1 + 4 gives line 2 [2 cost, 2 full]", () => {
    const r = cartTransformRun(cart({ lines: [
      line({ id: L(1), quantity: 1, product: 100, variant: 1 }),
      line({ id: L(2), quantity: 4, product: 200, variant: 2 }),
    ] }));
    expect(ops(r)).toEqual([L(2)]);
    expect(items(r)).toEqual([atCost(2, "8.00", V(2)), full(2, V(2))]);
  });

  it("non-member product (Grown-Ups-like) or uncollected product is untouched and takes no pool units", () => {
    const grownUps = line({ id: L(1), quantity: 3, product: 900, variant: 9, member: [], retail: "50.00", metafield: costMeta("30.00") });
    const uncollected = line({ id: L(2), quantity: 2, product: 901, variant: 10 });
    uncollected.merchandise.product.inCollections = []; // empty result
    const noField = line({ id: L(3), quantity: 2, product: 902, variant: 11 });
    delete noField.merchandise.product.inCollections;   // field absent
    const a = line({ id: L(4), quantity: 1, product: 100, variant: 1 });
    const b = line({ id: L(5), quantity: 2, product: 200, variant: 2 });
    const r = cartTransformRun(cart({ lines: [grownUps, uncollected, noField, a, b] }));
    expect(ops(r)).toEqual([L(5)]);
    // a is the pool's first unit (the non-members did not take it); b: both units at cost (twin allowance 2).
    expect(items(r)).toEqual([atCost(2, "8.00", V(2))]);
  });

  it("a line failing a guard in the middle does not consume allowance", () => {
    const r = cartTransformRun(cart({ lines: [
      line({ id: L(1), quantity: 1, product: 100, variant: 1 }),
      line({ id: L(2), quantity: 3, product: 200, variant: 2, metafield: null }),            // no cost
      line({ id: L(3), quantity: 3, product: 300, variant: 3, metafield: costMeta("25.00") }), // cost not below retail
      line({ id: L(4), quantity: 3, product: 400, variant: 4, typename: "CustomProduct" }),
      line({ id: L(5), quantity: 3, product: 500, variant: 5 }),
    ] }));
    expect(ops(r)).toEqual([L(5)]);
    expect(items(r)).toEqual([atCost(2, "8.00", V(5)), full(1, V(5))]);
  });

  it("a guard-failing line is not the pool's first unit", () => {
    const r = cartTransformRun(cart({ lines: [
      line({ id: L(1), quantity: 1, product: 100, variant: 1, metafield: null }),
      line({ id: L(2), quantity: 2, product: 200, variant: 2 }),
    ] }));
    expect(items(r)).toEqual([full(1, V(2)), atCost(1, "8.00", V(2))]);
  });

  it("two eligible collections give two independent pools", () => {
    const OTHER = "gid://shopify/Collection/999000111";
    ELIGIBLE_COLLECTION_IDS.push(OTHER);
    try {
      const r = cartTransformRun(cart({ lines: [
        line({ id: L(1), quantity: 2, product: 100, variant: 1, member: [CLUB] }),
        line({ id: L(2), quantity: 2, product: 200, variant: 2, member: [OTHER] }),
      ] }));
      // Pool CLUB: [full, cost]. Pool OTHER: its own first unit is full, then cost.
      expect(items(r, 0)).toEqual([full(1), atCost(1)]);
      expect(items(r, 1)).toEqual([full(1, V(2)), atCost(1, "8.00", V(2))]);
    } finally {
      ELIGIBLE_COLLECTION_IDS.pop();
    }
  });

  it("a product in several eligible collections pools under the first one in the constant list", () => {
    const OTHER = "gid://shopify/Collection/999000111";
    ELIGIBLE_COLLECTION_IDS.push(OTHER);
    try {
      const both = line({ id: L(1), quantity: 2, product: 100, variant: 1, member: [OTHER, CLUB] });
      const onlyClub = line({ id: L(2), quantity: 2, product: 200, variant: 2, member: [CLUB] });
      const r = cartTransformRun(cart({ lines: [both, onlyClub] }));
      // both -> CLUB pool (first in list); so onlyClub continues that pool: both [full, cost], onlyClub [cost, full].
      expect(items(r, 0)).toEqual([full(1), atCost(1)]);
      expect(items(r, 1)).toEqual([atCost(1, "8.00", V(2)), full(1, V(2))]);
    } finally {
      ELIGIBLE_COLLECTION_IDS.pop();
    }
  });

  it("units always sum to line quantities across mixed carts (wrapper enforces per operation)", () => {
    for (const tags of [["twin"], ["triplet"], ["quad"]]) {
      for (let q1 = 1; q1 <= 7; q1++) for (let q2 = 1; q2 <= 7; q2++) {
        cartTransformRun(cart({ tags, lines: [
          line({ id: L(1), quantity: q1, product: 100, variant: 1 }),
          line({ id: L(2), quantity: q2, product: 200, variant: 2 }),
        ] }));
      }
    }
  });

  it("ELIGIBLE_COLLECTION_IDS and the graphql inCollections ids are identical", () => {
    const gql = readFileSync(new URL("../src/cart_transform_run.graphql", import.meta.url), "utf8");
    const m = gql.match(/inCollections\(\s*ids:\s*\[([^\]]*)\]\s*\)/);
    expect(m).not.toBeNull();
    const queryIds = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(queryIds).toEqual(ELIGIBLE_COLLECTION_IDS);
    expect(ELIGIBLE_COLLECTION_IDS).toEqual([CLUB]);
  });
});
