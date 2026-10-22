import { pool, getAuthUser } from '../../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    try {
        const u = await getAuthUser(req);
        const r = await pool.query(`SELECT p.id,p.phase,p.file_path as url FROM photos p JOIN attendance_records a ON a.id=p.attendance_id WHERE a.id=$1 AND (a.user_id=$2 OR $3='admin')`, [req.query.id, u.id, u.role]);
        return res.status(200).json({ photos: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
}