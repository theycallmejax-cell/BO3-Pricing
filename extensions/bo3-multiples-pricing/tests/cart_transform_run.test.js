import { describe, it, expect } from "vitest";
import { cartTransformRun as cartTransformRunRaw } from "../src/cart_transform_run.js";

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

function line({ id = "gid://shopify/CartLine/1", quantity = 2, variant = 1, product = 100, retail = "20.00", metafield = costMeta(), typename = "ProductVariant" } = {}) {
  return {
    id,
    quantity,
    merchandise: {
      __typename: typename,
      id: `gid://shopify/ProductVariant/${variant}`,
      product: { id: `gid://shopify/Product/${product}`, metafield },
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
  it("7a. same product on two lines: both discounted while allowance lasts (2 + 2, twin)", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 2, variant: 1 });
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 2, variant: 2 });
    const r = cartTransformRun(cart({ lines: [l1, l2] }));
    expect(r.operations).toHaveLength(2);
    expect(items(r, 0)).toEqual([full(1), atCost(1)]);
    expect(items(r, 1)).toEqual([full(1, "gid://shopify/ProductVariant/2"), atCost(1, "8.00", "gid://shopify/ProductVariant/2")]);
  });

  it("7b. allowance exhausted by the first line: second line of the same product is skipped", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 3, variant: 1 }); // uses 2 of 2
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 2, variant: 2 });
    const r = cartTransformRun(cart({ lines: [l1, l2] }));
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0].lineExpand.cartLineId).toBe("gid://shopify/CartLine/1");
    expect(items(r)).toEqual([full(1), atCost(2)]);
  });

  it("7c. different products have separate allowances", () => {
    const l1 = line({ id: "gid://shopify/CartLine/1", quantity: 3, product: 100 });
    const l2 = line({ id: "gid://shopify/CartLine/2", quantity: 3, product: 200, variant: 2 });
    const r = cartTransformRun(cart({ lines: [l1, l2] }));
    expect(r.operations).toHaveLength(2);
  });
});

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
