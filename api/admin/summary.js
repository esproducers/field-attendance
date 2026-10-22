import { pool, requireAdmin } from '../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    try {
        await requireAdmin(req);
        const [users, records, open, photos] = await Promise.all([
            pool.query('SELECT count(*)::int n FROM users'),
            pool.query('SELECT count(*)::int n FROM attendance_records'),
            pool.query("SELECT count(*)::int n FROM attendance_records WHERE status='checked_in'"),
            pool.query('SELECT count(*)::int n FROM photos')
        ]);
        res.status(200).json({ users: users.rows[0].n, records: records.rows[0].n, checkedIn: open.rows[0].n, photos: photos.rows[0].n });
    } catch (e) { res.status(500).json({ error: e.message }); }
}