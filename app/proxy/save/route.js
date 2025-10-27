export const runtime = 'nodejs';
import crypto from "crypto";

const SHOP = process.env.SHOPIFY_SHOP;                 // e.g. famelia-wine.myshopify.com
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // shpat_...
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

// 🔒 Allow ONLY your storefront origins to call this endpoint.
// Add your branded domain if different.
const ALLOWED_ORIGINS = new Set([
  `https://${SHOP}`,                           // https://famelia-wine.myshopify.com
  "https://famelia.com",                       // ← change/remove if not used
  "https://www.famelia.com"                    // ← change/remove if not used
]);

function bad(resMsg, code = 400) {
  return new Response(JSON.stringify({ ok: false, error: resMsg }), {
    status: code, headers: { "Content-Type": "application/json" }
  });
}

async function shopifyGraphQL(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ADMIN_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await r.json();
  if (!r.ok || json.errors) throw new Error(JSON.stringify(json.errors || json));
  return json.data;
}

export async function POST(request) {
  // 1) Basic origin check
  const origin = request.headers.get("origin");
  if (!ALLOWED_ORIGINS.has(origin)) {
    return bad("Origin not allowed", 401);
  }

  // 2) Read JSON
  let body;
  try { body = await request.json(); } catch { return bad("Invalid JSON"); }

  const { shop, customer_id, customer_email, event_handle, event_name, product } = body || {};
  if (!shop || !customer_id || !customer_email || !event_handle || !product?.product_id) {
    return bad("Missing required fields");
  }

  // 3) Verify the customer really matches your store record
  const customerGID = `gid://shopify/Customer/${customer_id}`;
  const q1 = `
    query($id: ID!) {
      customer(id: $id) { id email }
    }
  `;
  const d1 = await shopifyGraphQL(q1, { id: customerGID });
  const realEmail = d1?.customer?.email;
  if (!realEmail || realEmail.toLowerCase() !== String(customer_email).toLowerCase()) {
    return bad("Customer verification failed", 401);
  }

  // 4) Get existing metafield JSON
  const q2 = `
    query($id: ID!) {
      customer(id: $id) {
        metafield(namespace:"tasting", key:"events") { id type value }
      }
    }
  `;
  const d2 = await shopifyGraphQL(q2, { id: customerGID });
  let store = { events: [] };
  const mf = d2?.customer?.metafield;
  if (mf?.value) { try { store = JSON.parse(mf.value); } catch {} }

  // 5) Merge the new note
  const now = new Date().toISOString();
  let evt = store.events.find(e => e.collection_handle === event_handle);
  if (!evt) {
    evt = { id: event_handle, name: event_name || event_handle, date: now.slice(0,10), collection_handle: event_handle, wines: [] };
    store.events.push(evt);
  }
  const idx = evt.wines.findIndex(w => w.product_id === Number(product.product_id));
  const entry = {
    product_id: Number(product.product_id),
    handle: product.handle || "",
    title: product.title || "",
    rating: typeof product.rating === "number" ? product.rating : null,
    note: (product.note || "").slice(0, 2000),
    updated_at: now
  };
  if (idx === -1) evt.wines.push(entry); else evt.wines[idx] = entry;

  // 6) Save it back
  const q3 = `
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
  const d3 = await shopifyGraphQL(q3, { ownerId: customerGID, value: JSON.stringify(store) });
  const errs = d3?.metafieldsSet?.userErrors || [];
  if (errs.length) return bad(errs.map(e => e.message).join("; "), 500);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { "Content-Type": "application/json" }
  });
}
