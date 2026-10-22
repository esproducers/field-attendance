import { pool, getAuthUser } from '../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    try {
        const u = await getAuthUser(req);
        const isAdmin = u.role === 'admin';
        const query = `SELECT a.*,u.full_name,u.email,s.name AS site_name,(SELECT count(*)::int FROM photos p WHERE p.attendance_id=a.id) AS photo_count 
                       FROM attendance_records a JOIN users u ON a.user_id=u.id LEFT JOIN sites s ON a.site_id=s.id 
                       ${isAdmin ? '' : 'WHERE a.user_id=$1'} ORDER BY a.created_at DESC LIMIT 1000`;
        const r = await pool.query(query, isAdmin ? [] : [u.id]);
        return res.status(200).json({ records: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
}