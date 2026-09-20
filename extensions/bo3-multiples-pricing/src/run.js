// @ts-check
const DISCOUNT_TITLE = "Multiples Pricing";
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
export function run(input) {
  const operations = [];
  const customer = input.cart?.buyerIdentity?.customer;
  if (!customer) return { operations };
  const maxAdditional = resolveMaxAdditional(customer.tags ?? []);
  if (maxAdditional === 0) return { operations };
  const lines = input.cart?.lines ?? [];
  const additionalUsed = new Map();
  for (const line of lines) {
    const merchandise = line.merchandise;
    if (!merchandise || merchandise.__typename !== "ProductVariant") continue;
    const productId = merchandise.product?.id;
    if (!productId) continue;
    const lineQty = line.quantity ?? 0;
    if (lineQty <= 1) continue;
    const metafieldValue = merchandise.product?.metafield?.value;
    const costPrice = parseCostPrice(metafieldValue);
    if (!costPrice) continue;
    const alreadyUsed = additionalUsed.get(productId) ?? 0;
    const remainingAllowance = maxAdditional - alreadyUsed;
    if (remainingAllowance <= 0) continue;
    const additionalInLine = lineQty - 1;
    const discountableQty = Math.min(additionalInLine, remainingAllowance);
    const fullPriceQty = lineQty - discountableQty;
    additionalUsed.set(productId, alreadyUsed + discountableQty);
    const retailAmount = parseFloat(line.cost?.amountPerQuantity?.amount ?? "0");
    const costAmount = parseFloat(costPrice.amount);
    if (isNaN(retailAmount) || isNaN(costAmount) || costAmount >= retailAmount) continue;
    const expandedItems = [];
    expandedItems.push({ merchandiseId: merchandise.id, quantity: fullPriceQty });
    expandedItems.push({
      merchandiseId: merchandise.id,
      quantity: discountableQty,
      price: { adjustment: { fixedPricePerUnit: { amount: costPrice.amount, currencyCode: costPrice.currencyCode } } },
    });
    const beyondAllowance = additionalInLine - discountableQty;
    if (beyondAllowance > 0) {
      expandedItems.push({ merchandiseId: merchandise.id, quantity: beyondAllowance });
    }
    operations.push({
      expand: { cartLineId: line.id, title: DISCOUNT_TITLE, expandedCartItems: expandedItems },
    });
  }
  return { operations };
}
