import { buffer } from 'micro';
import crypto from 'crypto';
import { Client } from '@notionhq/client';
import Bottleneck from 'bottleneck';
import QRCode from 'qrcode';
import FormData from 'form-data';



// 1) Tell Vercel not to parse the body for you:
export const config = { api: { bodyParser: false } };

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const limiter = new Bottleneck({
  reservoir: 3,
  reservoirRefreshAmount: 3,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 3,
});

export default async function handler(req, res) {
    const fetch = (await import('node-fetch')).default;
  try {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const rawBody = (await buffer(req)).toString('utf-8');
    const payload = JSON.parse(rawBody);

    console.log('Received webhook payload:', payload);

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
        console.error('Invalid signature', {signature, expected});
        return res.status(401).end();
  }

  if (payload.type !== 'page.created') {
    console.log('Ignoring webhook event:', payload.type);
    return res.status(200).end();
  }
  const pageId = payload.entity.id;
  console.log('Processing page ID:', pageId);

  const page = await limiter.schedule(() =>
    notion.pages.retrieve({ page_id: pageId })
  );
  console.log('Retrieved page:', page);

  const uuid = page.properties['UUID'].formula.string;
  const id = page.properties['ID'].unique_id;
  const concatId = `${id.prefix}-${id.number}`;
  const qrPayload = JSON.stringify({ id: concatId, uuid: uuid });

  console.log('QR Payload:', qrPayload);

  const dataUrl = await QRCode.toDataURL(qrPayload, { type: 'image/png' });
  const bufferData = Buffer.from(dataUrl.split(',')[1], 'base64');

  console.log(bufferData.length, 'bytes of QR code data generated');

const uploadRes = await limiter.schedule(() =>
  fetch('https://api.notion.com/v1/file_uploads', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
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
const { id: uploadId } = await uploadRes.json();

  console.log('Upload ID:', uploadId);

  const form = new FormData();
  form.append('file', bufferData, {
    filename: `${concatId}.png`,
    content_type: 'image/png',
  });


  const sendRes = await limiter.schedule(() =>
    fetch(`https://api.notion.com/v1/file_uploads/${uploadId}/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          ...form.getHeaders(),
        },
        body: form,
    }));

    const sendJson = await sendRes.json();

    if (!sendRes.ok) {
        console.error('Failed to send file upload:', sendJson);
        return res.status(500).send('Failed to send file upload');
    }

    const fileId = sendJson.id;

  await limiter.schedule(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        'QR Code': {
          files: [
            {
              type: 'file_upload',
              file_upload: {
                id: fileId,
              },
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
