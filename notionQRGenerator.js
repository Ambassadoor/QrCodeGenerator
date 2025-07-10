import 'dotenv/config';
import FormData from 'form-data';
import fetch from 'node-fetch';
import Bottleneck from 'bottleneck';
import QRCode from 'qrcode';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

// Limit to 3 requests per second, 1 at a time, with spacing
const limiter = new Bottleneck({
  reservoir: 3,
  reservoirRefreshAmount: 3,
  reservoirRefreshInterval: 1000,
  maxConcurrent: 1,
  minTime: 400
});

// Generic fetch with retry/backoff
const fetchWithRetry = async (url, options, retries = 3, delay = 1000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    const errorText = await res.text();
    console.error(`Fetch error (${res.status}) on ${url}: ${errorText}`);
    if (attempt < retries) await new Promise(r => setTimeout(r, delay * attempt));
    else throw new Error(`Failed after ${retries} attempts: ${url}`);
  }
};

// Get Notion pages missing QR code
const getNotionData = async () => {
  const res = await fetchWithRetry(
    `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filter: {
          property: 'QR Code',
          files: { is_empty: true }
        }
      })
    }
  );

  const json = await res.json();
  return json.results.map(item => {
    const uuid = item.properties['UUID'].formula.string;
    const id = item.properties['ID'].unique_id;
    return {
      id: `${id.prefix}-${id.number}`,
      uuid,
      qrCodeData: { id: `${id.prefix}-${id.number}`, uuid }
    };
  });
};

// Request Notion upload slot
const notionUploadRequest = async (item) => {
  const res = await fetchWithRetry(
    `https://api.notion.com/v1/file_uploads`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'single_part',
        filename: `${item.id}.png`,
        content_type: 'image/png'
      })
    }
  );
  const { id: uploadId } = await res.json();
  item.uploadId = uploadId;
  return item;
};

// Generate QR code and convert to binary
const generateQR = async (text) => QRCode.toDataURL(text, { type: 'image/png' });
const toBinary = (dataUrl) => Buffer.from(dataUrl.split(',')[1], 'base64');

// Upload file to Notion
const sendFileToNotion = async (item) => {
  const qrText = JSON.stringify(item.qrCodeData);
  const binaryQr = toBinary(await generateQR(qrText));

  const form = new FormData();
  form.append('file', binaryQr, {
    filename: `${item.id}.png`,
    contentType: 'image/png'
  });

  const res = await fetchWithRetry(
    `https://api.notion.com/v1/file_uploads/${item.uploadId}/send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        ...form.getHeaders()
      },
      body: form
    }
  );

  const { id: fileId } = await res.json();
  item.fileId = fileId;
  return item;
};

// Update Notion page with file
const updateNotionPage = async (item) => {
  const res = await fetchWithRetry(
    `https://api.notion.com/v1/pages/${item.uuid}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        properties: {
          "QR Code": {
            files: [
              {
                type: "file_upload",
                file_upload: { id: item.fileId }
              }
            ]
          }
        }
      })
    }
  );
  return await res.json();
};

// Full processing per item
const processItem = async (item) => {
  try {
    await limiter.schedule(() => notionUploadRequest(item));
    await limiter.schedule(() => sendFileToNotion(item));
    await limiter.schedule(() => updateNotionPage(item));
    console.log(`✅ Processed: ${item.id}`);
  } catch (err) {
    console.error(`❌ Failed to process ${item.id}: ${err.message}`);
  }
};

// Main execution
const notionData = await getNotionData();
console.log(`Found ${notionData.length} items to process.`);

for (const item of notionData) {
  await processItem(item);
}
