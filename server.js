import express from 'express';
const app = express();
app.use(express.json());

// --- Fix A: global CORS + OPTIONS middleware ---
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
  // TODO: Admin GraphQL / FedEx work
  res.json({ ok: true, message: 'Tracking loaded', orderId, fulfillments: [] });
});

app.listen(process.env.PORT || 8080, () =>
  console.log('fedex-proxy listening on :' + (process.env.PORT || 8080))
);
