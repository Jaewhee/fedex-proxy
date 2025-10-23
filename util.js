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