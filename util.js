export async function getFedExToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.FEDEX_API_KEY,
    client_secret: process.env.FEDEX_SECRET_KEY,
  });

  const res = await fetch('https://apis-sandbox.fedex.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`FedEx OAuth failed: ${res.status} ${res.statusText} ${text}`);
  }

  const json = await res.json();
  // { access_token, token_type, expires_in, scope }
  return json.access_token;
}

export function isFedExDelivered(trackResult) {
  // trackResult is `completeTrackResults[0].trackResults[0]`
  if (!trackResult) return false;
  const latest = trackResult.latestStatusDetail || {};
  const code = latest.code || latest.statusCode || '';
  const desc = (latest.description || '').toLowerCase();
  // FedEx often uses 'DL' for delivered; fallback to description text
  return code === 'DL' || desc.includes('delivered');
}

export async function markFulfillmentDelivered(fulfillmentId, actualDeliveryDate) {
  if (!fulfillmentId) {
    return { ok: false, error: 'Missing fulfillmentId' };
  }

  // Coerce to ISO 8601 if you pass a Date
  const happenedAt =
    actualDeliveryDate instanceof Date
      ? actualDeliveryDate.toISOString()
      : actualDeliveryDate || undefined;

  const query = `
    mutation fulfillmentEventCreate($fulfillmentEvent: FulfillmentEventInput!) {
      fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
        fulfillmentEvent {
          id
          status
          message
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    fulfillmentEvent: {
      fulfillmentId,
      ...(happenedAt ? { happenedAt } : {}),
      message: 'Delivered — your package has arrived at its final destination.',
      status: 'DELIVERED',
    },
  };

  try {
    const res = await fetch(`https://${process.env.SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text(); // read once
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, status: res.status, error: 'Non-JSON response', body: text };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, error: 'HTTP error', body: json };
    }

    if (json.errors?.length) {
      return { ok: false, status: res.status, error: 'GraphQL errors', errors: json.errors };
    }

    const payload = json.data?.fulfillmentEventCreate;
    const userErrors = payload?.userErrors || [];

    if (userErrors.length) {
      return { ok: false, status: res.status, error: 'User errors', userErrors, data: payload };
    }

    return { ok: true, status: res.status, data: payload };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
