import 'dotenv/config';
import FormData from 'form-data';
import fetch from 'node-fetch';
import Bottleneck from 'bottleneck';
import QRCode from 'qrcode';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;


// Maintains a rate limit of 3 requests per second with a maximum of 3 concurrent requests
const limiter = new Bottleneck({
    reservoir: 3,
    reservoirRefreshAmount: 3,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 3,
});

// Function to fetch pages in database with empty QR Code property
const getNotionData = async () => {
    const response = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28', 
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            "filter": {
                "property": "QR Code",
                "files": {
                    "is_empty": true
                }
            }
        })});
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const responseData = await response.json();
    const data = responseData.results.map(item => {
        const uuid = item.properties['UUID'].formula.string;
        const id = item.properties['ID'].unique_id;
        const concatId = `${id.prefix}-${id.number}`;
        return {
            id: concatId,
            uuid: uuid,
            qrCodeData: {
                id: concatId,
                uuid: uuid,
            }
        };
    });

    return data;
};

const notionData = await getNotionData();
console.log(`Found ${notionData.length} items to process.`);

// Function to create an upload request to Notion and return the upload ID
const notionUploadRequest = async (item) => { 
    const response = await fetch(`https://api.notion.com/v1/file_uploads`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            "mode": "single_part",
            "filename": `${item.id}.png`,
            "content_type": "image/png",
        })
    })
    const { id: uploadId } = await response.json();
    item.uploadId = uploadId;
    return item;
} 

// Function to generate a QR code as a data URL
const generateQR = async (text) => {
    const code = await QRCode.toDataURL(text, {
        type: 'image/png'
    });
    return code;
}

// Function to convert a data URL to a binary buffer
const toBinary = (dataUrl) => {
    const base64Data = dataUrl.split(',')[1];
    const buffer = Buffer.from(base64Data, 'base64');
    return buffer;
}

// Function to send file to Notion
const sendFileToNotion = async (item) => {
    const qrText = JSON.stringify(item.qrCodeData);
    const qr = await generateQR(qrText);
    const binaryQr = toBinary(qr);

    const form = new FormData();
    form.append("file", binaryQr, {
        filename: `${item.id}.png`,
        content_type: "image/png"
    });

    const headers = {
        'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        ...form.getHeaders()
    };

    const url = `https://api.notion.com/v1/file_uploads/${item.uploadId}/send`;
    const response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: form
    });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const { id: fileId } = await response.json();
    item.fileId = fileId;
    return item;
}

// Function to update the Notion page with the uploaded file ID
const updateNotionPage = async (item) => {
    const response = await fetch(`https://api.notion.com/v1/pages/${item.uuid}`, {
        method: 'PATCH',
        headers: {
            'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            properties: {
                "QR Code": {
                    files: [{
                        type: "file_upload",
                        file_upload: {
                            id: item.fileId,
                        }
                    }]
                }
            }
        })
    })
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
}

const processItem = async(item) => {
    await limiter.schedule(() => notionUploadRequest(item));
    await limiter.schedule(() => sendFileToNotion(item));
    await limiter.schedule(() => updateNotionPage(item));
};

await Promise.all(notionData.map(item => processItem(item)));

