import express from 'express';
import dotenv from 'dotenv';
import { getFedExToken, isFedExDelivered, markFulfillmentDelivered } from './util.js';

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
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok: false, message: 'Missing orderId' });

  try {
    // 1) Fetch fulfillments + tracking from Shopify Admin
    const q = `
      query GetOrderFulfillments($id: ID!) {
        order(id: $id) {
          id
          name
          displayFulfillmentStatus
          fulfillments {
            id
            status
            displayStatus
            trackingInfo {
              number
              company
              url
            }
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
    const fulfillmentStatus = order?.displayFulfillmentStatus;

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

    console.log('allTracks:', allTracks);

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
      console.log('latest', latest);
      trackSummaries[number] = {
        delivered: isFedExDelivered(result),
        statusCode: latest?.code || latest?.statusCode || null,
        statusDesc: latest?.description || null,
        estimatedDelivery: result?.estimatedDeliveryTimestamp || null,
        raw: fx,
      };
      console.log('trackSummaries[number]: ', trackSummaries[number]);
    }

    // 5) Decide delivered per fulfillment (ALL tracking numbers must be delivered)
    const fulfillmentUpdates = [];
    const fulfillmentSummaries = fulfillments.map(f => {
      const numbers = (f.trackingInfo || []).map(ti => ti.number).filter(Boolean);
      const perTrack = numbers.map(n => ({ number: n, ...trackSummaries[n] }));

      return {
        fulfillmentId: f.id,
        status: f.displayStatus,
        tracks: perTrack,
      };
    });

    const allDelivered =
      fulfillmentSummaries.length > 0 &&
      fulfillmentSummaries.every(f =>
        Array.isArray(f.tracks) &&
        f.tracks.length > 0 &&
        f.tracks.every(t => t.delivered === true || t.statusCode === 'DL')
      );
    console.log('allDelivered:', allDelivered);

    if (allDelivered) {
      // Queue fulfillmentMarkAsDelivered calls
      fulfillmentSummaries.forEach(f => {
        if (f.status !== 'DELIVERED') {
          console.log(`Queuing fulfillmentMarkAsDelivered for fulfillment ${f.fulfillmentId}`);
          const actualDeliveryDate = f.tracks[0].raw.output.completeTrackResults[0].trackResults[0].dateAndTimes.find(dt => dt.type === 'ACTUAL_DELIVERY')?.dateTime;
          console.log(`Actual delivery date for fulfillment ${f.fulfillmentId}: ${actualDeliveryDate}`);
          fulfillmentUpdates.push(markFulfillmentDelivered(f.fulfillmentId, actualDeliveryDate));
        }
      });
    }

    // 6) Perform Shopify updates in parallel (best-effort)
    const updateResults = await Promise.allSettled(fulfillmentUpdates);

    // 7) Response payload
    return res.json({
      ok: true,
      message: 'Tracking checked.',
      order: { id: order.id, name: order.name },
      allDelivered,
      fulfillmentStatus,
      fulfillmentSummaries,
      updateResults, // statuses from fulfillmentMarkAsDelivered (settled)
    });

  } catch (err) {
    console.error('tracking proxy error', err);
    return res.status(500).json({ ok: false, message: 'Server error', error: String(err) });
  }
});

app.listen(process.env.PORT || 8080, () =>
  console.log('fedex-proxy listening on :' + (process.env.PORT || 8080))
);
