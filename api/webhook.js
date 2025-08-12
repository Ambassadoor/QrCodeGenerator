import { buffer } from 'micro';
import crypto from 'crypto';
import { Client } from '@notionhq/client';
import Bottleneck from 'bottleneck';
import QRCode from 'qrcode';
import FormData from 'form-data';

// Disable bodyParser
export const config = { api: { bodyParser: false } };

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const limiter = new Bottleneck({
  reservoir: 3,
  reservoirRefreshAmount: 3,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 1,
  minTime: 400,
});

const fetchWithRetry = async (url, options, retries = 3, delay = 1000) => {
  const fetch = (await import('node-fetch')).default;

  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    const errorText = await res.text();
    console.warn(`Fetch failed (${res.status}) on ${url}: ${errorText}`);
    if (i < retries - 1) await new Promise((r) => setTimeout(r, delay * (i + 1)));
  }

  throw new Error(`Request failed after ${retries} attempts: ${url}`);
};

export default async function handler(req, res) {
  const fetch = (await import('node-fetch')).default;

  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const rawBody = (await buffer(req)).toString('utf-8');
    const payload = JSON.parse(rawBody);

    console.log('Received webhook payload:', payload);

    // Notion webhook verification
    if (payload.verification_token) {
      return res.status(200).send(payload.verification_token);
    }

    const signature = req.headers['x-notion-signature'];
    const hmac = crypto
      .createHmac('sha256', process.env.NOTION_VERIFICATION_TOKEN)
      .update(rawBody)
      .digest('hex');

    const expected = `sha256=${hmac}`;
    if (signature !== expected) {
      console.error('Invalid signature', { signature, expected });
      return res.status(401).end();
    }

    // Only handle page creation events
    if (payload.type !== 'page.created') {
      console.log('Ignoring webhook event:', payload.type);
      return res.status(200).end();
    }

    const pageId = payload.entity.id;
    console.log('Processing page ID:', pageId);

    // Retrieve page details
    const page = await limiter.schedule(() =>
      notion.pages.retrieve({ page_id: pageId })
    );

    const id = page.properties['ID'].unique_id;
    const concatId = `${id.prefix}-${id.number}`;
    const uuid = page.properties['UUID'].formula.string;
    const qrPayload = JSON.stringify({ id: concatId, uuid });

    // Generate QR
    const dataUrl = await QRCode.toDataURL(qrPayload, { type: 'image/png' });
    const bufferData = Buffer.from(dataUrl.split(',')[1], 'base64');

    // Upload request
    const uploadRes = await limiter.schedule(() =>
      fetchWithRetry('https://api.notion.com/v1/file_uploads', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'single_part',
          filename: `${concatId}.png`,
          content_type: 'image/png',
        }),
      })
    );

    const uploadJson = await uploadRes.json();
    const uploadId = uploadJson.id;

    // Send file
    const form = new FormData();
    form.append('file', bufferData, {
      filename: `${concatId}.png`,
      contentType: 'image/png',
    });

    const sendRes = await limiter.schedule(() =>
      fetchWithRetry(`https://api.notion.com/v1/file_uploads/${uploadId}/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          ...form.getHeaders(),
        },
        body: form,
      })
    );

    const sendJson = await sendRes.json();
    const fileId = sendJson.id;

    // Update Notion page with file
    await limiter.schedule(() =>
      notion.pages.update({
        page_id: pageId,
        properties: {
          'QR Code': {
            files: [
              {
                type: 'file_upload',
                file_upload: { id: fileId },
              },
            ],
          },
        },
      })
    );

    return res.status(200).end();
  } catch (err) {
    console.error('Error processing webhook:', err);
    return res.status(500).send('Internal error');
  }
}
