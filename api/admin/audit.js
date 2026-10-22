import { pool, requireAdmin } from '../_utils.js';

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        const r = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
        res.status(200).json({ logs: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
}