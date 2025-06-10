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

  if (payload.type !== 'page.created' || payload.data.parent.id !== process.env.NOTION_DATABASE_ID) {
    return res.status(200).end();
  }
  const pageId = payload.entity.id;

  const page = await limiter.schedule(() =>
    notion.pages.retrieve({ page_id: pageId })
  );
  const uuid = page.properties['UUID'].formula.string;
  const id = page.properties['ID'].unique_id;
  const concatId = `${id.prefix}-${id.number}`;
  const qrPayload = JSON.stringify({ id: concatId, uuid: uuid });

  const dataUrl = await QRCode.toDataURL(qrPayload, { type: 'image/png' });
  const bufferData = Buffer.from(dataUrl.split(',')[1], 'base64');

  const { id: uploadId } = await limiter.schedule(() =>
    notion.files.create({
        mode: 'single_part',
        filename: `${concatId}.png`,
        content_type: 'image/png',
    })
  );

  const form = new FormData();
  form.append('file', bufferData, {
    filename: `${concatId}.png`,
    contentType: 'image/png',
  });
  await limiter.schedule(() =>
    fetch(`https://api.notion.com/v1/file_uploads/${uploadId}/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          ...form.getHeaders(),
        },
        body: form,
    }.then(r => r.ok || Promise.reject(`send failed ${r.status}`)))
  );

  await limiter.schedule(() =>
    notion.pages.update({
      page_id: pageId,
      properties: {
        'QR Code': {
          files: [
            {
              type: 'file_upload',
              file_upload: {
                id: uploadId,
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
