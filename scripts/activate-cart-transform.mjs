// Activates the bo3-multiples-pricing cart transform on the store.
//
// STATUS: WRITTEN, NOT RUN. The mutation arguments below (functionHandle,
// blockOnFailure) were NOT verified against the current Admin GraphQL docs by
// the author (shopify.dev was unreachable). The script therefore introspects the
// live schema first and aborts, changing nothing, if the argument names differ.
//
// Secrets (SHOPIFY_API_KEY, SHOPIFY_API_SECRET) come from the environment only.
// The access token and the secret are never printed.
// Manual use only: see .github/workflows/activate-cart-transform.yml.

const SHOP = "td5h8u-tb.myshopify.com";
const API_VERSION = "2026-07";
const FUNCTION_HANDLE = "bo3-multiples-pricing";

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.CONFIRM !== "ACTIVATE") {
  fail('Refusing to run: CONFIRM must equal "ACTIVATE".');
}
const clientId = process.env.SHOPIFY_API_KEY;
const clientSecret = process.env.SHOPIFY_API_SECRET;
if (!clientSecret) {
  fail("Missing GitHub secret SHOPIFY_API_SECRET: add it under Settings > Secrets and variables > Actions, then run again.");
}
if (!clientId) {
  fail("Missing SHOPIFY_API_KEY in the environment.");
}

async function getAccessToken() {
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* keep text for the error path */ }
  if (!res.ok || !body.access_token) {
    if (text.includes("shop_not_permitted")) {
      fail(
        "Token request returned shop_not_permitted.\n" +
        "This means the app and the store are not in the same Shopify organisation, so the client credentials grant is not allowed.\n" +
        "Activation then needs an access token from the app install flow (authorization code grant) instead. Nothing was changed."
      );
    }
    // Do not echo the response body wholesale; it is expected to hold no secrets, but print only the error fields.
    fail(`Token request failed with HTTP ${res.status}. error=${body.error ?? "unknown"} description=${body.error_description ?? "none"}`);
  }
  return body.access_token;
}

async function adminGraphql(token, query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    fail(`Admin API request failed (HTTP ${res.status}): ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

const token = await getAccessToken();
console.log("Access token obtained.");

// Preflight: confirm the mutation takes the arguments this script sends.
const introspection = await adminGraphql(
  token,
  `query { __type(name: "Mutation") { fields { name args { name } } } }`,
);
const field = introspection.__type?.fields?.find((f) => f.name === "cartTransformCreate");
if (!field) {
  fail("Preflight: cartTransformCreate was not found on the Mutation type for this API version. Nothing was changed.");
}
const argNames = field.args.map((a) => a.name);
for (const needed of ["functionHandle", "blockOnFailure"]) {
  if (!argNames.includes(needed)) {
    fail(`Preflight: cartTransformCreate has no "${needed}" argument (found: ${argNames.join(", ")}). Nothing was changed. The script needs correcting against the current docs.`);
  }
}

const data = await adminGraphql(
  token,
  `mutation ActivateCartTransform($functionHandle: String!, $blockOnFailure: Boolean!) {
    cartTransformCreate(functionHandle: $functionHandle, blockOnFailure: $blockOnFailure) {
      cartTransform { id functionId blockOnFailure }
      userErrors { field message code }
    }
  }`,
  { functionHandle: FUNCTION_HANDLE, blockOnFailure: false },
);

const payload = data.cartTransformCreate;
const errors = payload.userErrors ?? [];
if (errors.length === 0 && payload.cartTransform) {
  console.log(`Activated cart transform ${payload.cartTransform.id} (functionId ${payload.cartTransform.functionId}, blockOnFailure=${payload.cartTransform.blockOnFailure}).`);
  process.exit(0);
}
const alreadyExists = errors.length > 0 && errors.every((e) => /already/i.test(`${e.code ?? ""} ${e.message ?? ""}`));
if (alreadyExists) {
  console.log("Cart transform already exists for this function. Treated as success.");
  console.log(JSON.stringify(errors));
  process.exit(0);
}
fail(`cartTransformCreate returned errors: ${JSON.stringify(errors)}`);
