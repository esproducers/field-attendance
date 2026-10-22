import { pool, requireAdmin } from '../_utils.js';

export default async function handler(req, res) {
    try {
        await requireAdmin(req);
        const rows = (await pool.query('SELECT a.id,u.full_name,u.email,a.location_name,a.check_in_device_at,a.check_out_device_at,a.status,a.notes FROM attendance_records a JOIN users u ON a.user_id=u.id ORDER BY a.created_at DESC LIMIT 20000')).rows;
        const escape = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
        const cols = ['id', 'full_name', 'email', 'location_name', 'check_in_device_at', 'check_out_device_at', 'status', 'notes'];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
        return res.status(200).send('\uFEFF' + cols.join(',') + '\r\n' + rows.map(r => cols.map(k => escape(r[k])).join(',')).join('\r\n'));
    } catch (e) { res.status(500).json({ error: e.message }); }
}