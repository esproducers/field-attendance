import { pool, requireAdmin } from '../../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    try {
        await requireAdmin(req);
        const { from, to, userId, location } = req.body;
        const values = [];
        const clauses = [];
        if (from) { values.push(new Date(from + 'T00:00:00.000Z')); clauses.push(`a.created_at >= $${values.length}`); }
        if (to) { values.push(new Date(to + 'T23:59:59.999Z')); clauses.push(`a.created_at <= $${values.length}`); }
        if (userId) { values.push(userId); clauses.push(`a.user_id = $${values.length}::uuid`); }
        if (location) { values.push('%' + location.trim().slice(0, 120) + '%'); clauses.push(`(a.location_name ILIKE $${values.length} OR a.check_out_location_name ILIKE $${values.length})`); }

        if (!clauses.length) return res.status(400).json({ error: 'Select at least one filter before clearing data' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const selected = await client.query(`SELECT a.id FROM attendance_records a WHERE ${clauses.join(' AND ')} FOR UPDATE`, values);
            const ids = selected.rows.map(x => x.id);
            if (ids.length) {
                await client.query('DELETE FROM photos WHERE attendance_id=ANY($1::uuid[])', [ids]);
                await client.query('DELETE FROM sync_events WHERE attendance_id=ANY($1::uuid[])', [ids]);
                await client.query('DELETE FROM attendance_records WHERE id=ANY($1::uuid[])', [ids]);
            }
            await client.query('COMMIT');
            res.status(200).json({ ok: true, deletedRecords: ids.length, deletedPhotos: ids.length });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally { client.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
}