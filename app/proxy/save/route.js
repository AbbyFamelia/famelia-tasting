import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP;                 // e.g. famelia-wine.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // from Partner app → API credentials
const APP_SECRET = process.env.SHOPIFY_APP_SECRET;     // from Partner app → API credentials
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

function verifyProxySignature(headers, rawBody) {
  const sig = headers.get("x-shopify-proxy-signature") || "";
  const digest = crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("base64");
  // timingSafeEqual needs equal length buffers; fall back to simple compare if lengths differ
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
  } catch {
    return digest === sig;
  }
}

async function shopifyGraphQL(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(JSON.stringify(json.errors || json));
  }
  return json.data;
}

export async function POST(request) {
  const url = new URL(request.url);
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id"); // injected by App Proxy
  const raw = await request.text();

  if (!verifyProxySignature(request.headers, raw)) {
    return new Response(JSON.stringify({ ok: false, error: "Bad signature" }), { status: 401 });
  }
  if (!loggedInCustomerId) {
    return new Response(JSON.stringify({ ok: false, error: "Not logged in" }), { status: 401 });
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { payload = {}; }
  const { event_handle, event_name, product } = payload || {};
  if (!event_handle || !product?.product_id) {
    return new Response(JSON.stringify({ ok: false, error: "Missing event or product" }), { status: 400 });
  }

  const customerGID = `gid://shopify/Customer/${loggedInCustomerId}`;

  // 1) read current metafield
  const q1 = `
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"tasting", key:"events") { id type value }
      }
    }
  `;
  const data1 = await shopifyGraphQL(q1, { id: customerGID });
  let store = { events: [] };
  const mf = data1?.customer?.metafield;
  if (mf?.value) {
    try { store = JSON.parse(mf.value); } catch {}
  }

  // 2) merge incoming note
  const now = new Date().toISOString();
  let evt = store.events.find(e => e.collection_handle === event_handle);
  if (!evt) {
    evt = { id: event_handle, name: event_name || event_handle, date: now.slice(0,10), collection_handle: event_handle, wines: [] };
    store.events.push(evt);
  }
  const idx = evt.wines.findIndex(w => w.product_id === product.product_id);
  const entry = {
    product_id: Number(product.product_id),
    handle: product.handle || "",
    title: product.title || "",
    rating: typeof product.rating === "number" ? product.rating : null,
    note: (product.note || "").slice(0, 2000),
    updated_at: now,
  };
  if (idx === -1) evt.wines.push(entry); else evt.wines[idx] = entry;

  // 3) upsert metafield
  const q2 = `
    mutation($ownerId: ID!, $value: String!) {
      metafieldsSet(metafields: [{
        ownerId: $ownerId,
        namespace: "tasting",
        key: "events",
        type: "json",
        value: $value
      }]) {
        userErrors { field message }
      }
    }
  `;
  const data2 = await shopifyGraphQL(q2, {
    ownerId: customerGID,
    value: JSON.stringify(store),
  });
  const errs = data2?.metafieldsSet?.userErrors || [];
  if (errs.length) {
    return new Response(JSON.stringify({ ok: false, error: errs.map(e=>e.message).join("; ") }), { status: 500 });
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
