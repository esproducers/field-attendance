const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// 💡 這裡完美對接你截圖中 Neon 最新推出的 Object storage (相容 S3 標準)
const s3Client = new S3Client({
    endpoint: process.env.NEON_STORAGE_ENDPOINT, // 例如 https://neon.tech
    credentials: {
        accessKeyId: process.env.NEON_STORAGE_KEY_ID,
        secretAccessKey: process.env.NEON_STORAGE_APPLICATION_KEY,
    },
    region: 'ap-southeast-1', // 對應你選的 Singapore 地區
});

module.exports = async (req, res) => {
    try {
        // 生成一個純隨機的唯一照片檔名
        const filename = `${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;

        const command = new PutObjectCommand({
            Bucket: 'photo', // 對應你截圖裡寫的 Bucket name: image
            Key: filename,
            ContentType: 'photo/jpeg',
        });

        // 拿到通行證
        const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 60 });
        // 未來這張照片的真實公開/私有訪問網址
        const downloadUrl = `${process.env.NEON_STORAGE_PUBLIC_BASE_URL}/${filename}`;

        return res.status(200).json({ success: true, uploadUrl, downloadUrl });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
};
