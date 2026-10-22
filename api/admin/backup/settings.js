import { pool, requireAdmin } from '../../_utils.js';

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        const r = await pool.query("SELECT value FROM system_settings WHERE key='backup_schedule'");
        res.status(200).json({ schedule: r.rows[0]?.value || { enabled: false, time: '02:00', keep: 14 }, files: [] });
    } catch (e) { res.status(500).json({ error: e.message }); }
}