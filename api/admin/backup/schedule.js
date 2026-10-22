import { pool, requireAdmin } from '../../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'PATCH') return res.status(405).end();
    try {
        await requireAdmin(req);
        const schedule = { enabled: !!req.body.enabled, time: req.body.time || '02:00', keep: Number(req.body.keep) || 14 };
        await pool.query("INSERT INTO system_settings(key,value) VALUES('backup_schedule',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(schedule)]);
        res.status(200).json({ ok: true, schedule });
    } catch (e) { res.status(500).json({ error: e.message }); }
}