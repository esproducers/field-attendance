import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getAuthUser } from './_utils.js';

// 请在 Vercel 环境变量中配置这些
const s3 = new S3Client({
    region: process.env.B2_REGION || 'us-west-004',
    endpoint: process.env.B2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.B2_KEY_ID,
        secretAccessKey: process.env.B2_APPLICATION_KEY,
    }
});

export default async function handler(req, res) {
    try {
        await getAuthUser(req);
        const filename = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;

        const command = new PutObjectCommand({
            Bucket: process.env.B2_BUCKET_NAME,
            Key: filename,
            ContentType: 'image/jpeg'
        });

        // 生成 15 分钟有效期的上传链接
        const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
        // B2 的公开访问 URL (需在 B2 后台开启公开访问)
        const downloadUrl = `${process.env.B2_PUBLIC_URL}/${filename}`;

        res.status(200).json({ uploadUrl, downloadUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
}