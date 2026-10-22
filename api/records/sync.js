const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1, // Serverless 環境下，每個容器只需 1 個連接，極致省內存
    idleTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false }
});

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { id, action, location_name, notes, latitude, longitude, photo_urls } = req.body;

        // 🌟 做法 A：使用 PostgreSQL 的 TEXT[] 陣列，直接一次性插入所有網址！
        const sql = `
      INSERT INTO attendance_records 
      (id, action, location_name, notes, latitude, longitude, photo_urls, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (id) DO UPDATE SET photo_urls = $7;
    `;

        // photo_urls 在這裡傳入陣列，pg 驅動會自動將其完美轉換成 PostgreSQL 的 TEXT[] 格式
        await pool.query(sql, [id, action, location_name, notes, latitude, longitude, photo_urls || []]);

        return res.status(200).json({ success: true, message: '資料與照片陣列已成功同步存入 Neon 數據庫！' });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, error: err.message });
    }
};
