import express from 'express';
import dotenv from 'dotenv';
import { getFedExToken } from './util.js';

dotenv.config();

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/proxy/fedex-status', (req, res) => {
  res.json({ ok: true, msg: 'proxy alive' });
});

app.post('/proxy/fedex-status/tracking', async (req, res) => {
  const { orderId, shipDateBegin } = req.body || {};
  if (!orderId) return res.status(400).json({ ok: false, message: 'Missing orderId' });

  try {
    // 1) Fetch fulfillments + tracking from Shopify Admin
    const q = `
      query GetOrderFulfillments($id: ID!) {
        order(id: $id) {
          id
          name
          fulfillments {
            id
            status
            trackingInfo { number company url }
          }
        }
      }
    `;
    const gqlRes = await fetch(`https://${process.env.SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query: q, variables: { id: orderId } }),
    });
    const gqlJson = await gqlRes.json();
    const order = gqlJson?.data?.order;
    const fulfillments = order?.fulfillments ?? [];

    // Edge case: no fulfillments or no tracking numbers yet
    const allTracks = [];
    fulfillments.forEach(f => {
      (f.trackingInfo || []).forEach(ti => {
        if (ti?.number) allTracks.push({ fulfillmentId: f.id, number: ti.number, company: ti.company });
      });
    });
    if (allTracks.length === 0) {
      return res.json({ ok: true, message: 'No tracking numbers yet.', orderId, fulfillments, results: [] });
    }

    // 2) FedEx OAuth
    const token = await getFedExToken();

    // 3) Call FedEx for each tracking number (parallel)
    //    (Deduplicate tracking numbers to avoid double calls)
    const dedup = [...new Set(allTracks.map(t => t.number))];

    const fedexByNumber = Object.create(null);
    await Promise.all(
      dedup.map(async (trackingNumber) => {
        const payload = {
          includeDetailedScans: false,
          trackingInfo: [{
            ...(shipDateBegin ? { shipDateBegin } : {}),
            trackingNumberInfo: { trackingNumber } // omit carrierCode to let FedEx infer
          }]
        };
        const fx = await fetch('https://apis-sandbox.fedex.com/track/v1/trackingnumbers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'X-locale': 'en_US',
          },
          body: JSON.stringify(payload),
        });
        const json = await fx.json().catch(() => ({}));
        fedexByNumber[trackingNumber] = json;
      })
    );

    // 4) Build per-tracking summaries
    const trackSummaries = {};
    for (const number of Object.keys(fedexByNumber)) {
      const fx = fedexByNumber[number];
      const result = fx?.output?.completeTrackResults?.[0]?.trackResults?.[0];
      const latest = result?.latestStatusDetail;
      trackSummaries[number] = {
        delivered: isFedExDelivered(result),
        statusCode: latest?.code || latest?.statusCode || null,
        statusDesc: latest?.description || null,
        estimatedDelivery: result?.estimatedDeliveryTimestamp || null,
        raw: fx, // keep raw for debugging; remove later if too large
      };
    }

    // 5) Decide delivered per fulfillment (ALL tracking numbers must be delivered)
    const fulfillmentUpdates = [];
    const fulfillmentSummaries = fulfillments.map(f => {
      const numbers = (f.trackingInfo || []).map(ti => ti.number).filter(Boolean);
      const perTrack = numbers.map(n => ({ number: n, ...trackSummaries[n] }));
      const allDelivered = numbers.length > 0 && perTrack.every(pt => pt.delivered === true);

      // Queue Shopify update if all delivered and not already delivered
      if (allDelivered && f.status !== 'DELIVERED') {
        fulfillmentUpdates.push(markFulfillmentDelivered(f.id));
      }

      return {
        fulfillmentId: f.id,
        status: f.status,
        allDelivered,
        tracks: perTrack,
      };
    });

    // 6) Perform Shopify updates in parallel (best-effort)
    const updateResults = await Promise.allSettled(fulfillmentUpdates);

    // 7) Response payload
    return res.json({
      ok: true,
      message: 'Tracking checked.',
      order: { id: order.id, name: order.name },
      fulfillmentSummaries,
      updateResults, // statuses from fulfillmentMarkAsDelivered (settled)
    });

  } catch (err) {
    console.error('tracking proxy error', err);
    return res.status(500).json({ ok: false, message: 'Server error', error: String(err) });
  }

  // --- helpers ---

  function isFedExDelivered(trackResult) {
    // trackResult is `completeTrackResults[0].trackResults[0]`
    if (!trackResult) return false;
    const latest = trackResult.latestStatusDetail || {};
    const code = latest.code || latest.statusCode || '';
    const desc = (latest.description || '').toLowerCase();
    // FedEx often uses 'DL' for delivered; fallback to description text
    return code === 'DL' || desc.includes('delivered');
  }

  async function markFulfillmentDelivered(fulfillmentId) {
    const m = `
      mutation MarkDelivered($id: ID!) {
        fulfillmentMarkAsDelivered(id: $id) {
          fulfillment { id status }
          userErrors { field message }
        }
      }
    `;
    const r = await fetch(`https://${process.env.SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query: m, variables: { id: fulfillmentId } }),
    });
    return r.json();
  }
});

app.listen(process.env.PORT || 8080, () =>
  console.log('fedex-proxy listening on :' + (process.env.PORT || 8080))
);
