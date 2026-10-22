import { pool, getAuthUser, requireAdmin, clean } from '../_utils.js';

export default async function handler(req, res) {
    try {
        if (req.method === 'GET') {
            await getAuthUser(req);
            const r = await pool.query('SELECT * FROM sites ORDER BY name');
            return res.status(200).json({ sites: r.rows });
        }
        if (req.method === 'POST') {
            await requireAdmin(req);
            const name = clean(req.body?.name, 120);
            if (!name) return res.status(400).json({ error: 'Site name required' });
            const r = await pool.query('INSERT INTO sites(name,address,latitude,longitude) VALUES($1,$2,$3,$4) RETURNING *',
                [name, clean(req.body?.address, 300), req.body?.latitude || null, req.body?.longitude || null]);
            return res.status(200).json({ site: r.rows[0] });
        }
        res.status(405).end();
    } catch (e) { res.status(500).json({ error: e.message }); }
}