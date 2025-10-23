import express from 'express';
import dotenv from 'dotenv';

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

  const graphQLresponse = await fetch(`https://${process.env.SHOP_DOMAIN}/admin/api/2025-10/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN
    },
    body: JSON.stringify({
      query: `
        query getOrder($id: ID!) {
          order(id: $id) {
            id
            name
            fulfillments {
              trackingInfo {
                number
                company
              }
            }
          }
        }
      `,
      variables: { id: orderId }
    })
  });

  const graphQLdata = await graphQLresponse.json();
  console.log('Shopify GraphQL response data:', JSON.stringify(graphQLdata, null, 2));
  const trackingNumber = graphQLdata.data.order.fulfillments[0]?.trackingInfo[0]?.number;

  if (!trackingNumber) {
    return res.status(400).json({ ok: false, message: 'No tracking number found for this order.' });
  }

  const payload =
  {
    "includeDetailedScans": true,
    "trackingInfo": [
      {
        shipDateBegin,
        "trackingNumberInfo": {
          "trackingNumber": trackingNumber,
          "carrierCode": "FDXE"
        }
      }
    ]
  }

  console.log('FedEx tracking request payload:', JSON.stringify(payload, null, 2));

  // try {
  //   const response = await fetch('https://apis-sandbox.fedex.com/track/v1/trackingnumbers', {
  //     method: 'POST',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       'Authorization': `Bearer ${process.env.FED_EX_API_KEY}`
  //     },
  //     body: JSON.stringify(payload)
  //   });

  //   const data = await response.json();
  //   console.log('FedEx tracking response data:', JSON.stringify(data, null, 2));
  // } catch (error) {
  //   console.error('Error fetching FedEx tracking information:', error);
  // }

  res.json({ ok: true, message: 'Tracking loaded', orderId, fulfillments: [], trackingNumber });
});

app.listen(process.env.PORT || 8080, () =>
  console.log('fedex-proxy listening on :' + (process.env.PORT || 8080))
);
