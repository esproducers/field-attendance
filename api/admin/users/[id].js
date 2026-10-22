import { pool, requireAdmin, uuid } from '../../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'PATCH') return res.status(405).end();
    try {
        const actor = await requireAdmin(req);
        const { id } = req.query;
        if (!uuid(id)) return res.status(400).json({ error: 'Invalid user' });
        const b = req.body || {};

        if (id === actor.id && (b.active === false || b.role === 'user')) {
            return res.status(400).json({ error: 'Cannot disable or demote your own admin account' });
        }
        const r = await pool.query('UPDATE users SET active=COALESCE($2,active),role=COALESCE($3,role),full_name=COALESCE($4,full_name) WHERE id=$1 RETURNING id,email,full_name,role,active',
            [id, typeof b.active === 'boolean' ? b.active : null, ['admin', 'user'].includes(b.role) ? b.role : null, b.full_name || null]);
        res.status(200).json({ user: r.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
}