import { pool, requireAdmin } from '../../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    try {
        await requireAdmin(req);
        const r = await pool.query('SELECT id,email,full_name,role,active,created_at FROM users ORDER BY created_at DESC');
        res.status(200).json({ users: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
}