import { buffer } from 'micro';

// 1) Tell Vercel not to parse the body for you:
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  // 2) Only care about POSTs:
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // 3) Read the raw bytes, then parse JSON:
  const raw = (await buffer(req)).toString('utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error('Invalid JSON:', raw);
    res.status(400).end();
    return;
  }

  // 4) Handle the verification handshake:
  if (payload.verification_token) {
    console.log('Received verification_token:', payload.verification_token);
    // Notion expects you to return that token verbatim:
    res.status(200).send(payload.verification_token);
    return;
  }

  // …otherwise, handle your normal page.created events…
  res.status(200).end();
}
