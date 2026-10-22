import { pool, requireAdmin } from '../../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    try {
        await requireAdmin(req);
        const tables = ['users', 'sites', 'attendance_records', 'photos', 'sync_events', 'audit_logs', 'system_settings'];
        const data = { format: 'field-attendance-backup-v1', createdAt: new Date().toISOString(), tables: {} };
        for (const table of tables) {
            const r = await pool.query(`SELECT * FROM ${table}`);
            data.tables[table] = r.rows;
        }
        // 注意：Vercel 临时文件夹重启即删，无法生成大文件下载，这里直接返回 JSON
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="backup-${Date.now()}.json"`);
        return res.status(200).json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
}