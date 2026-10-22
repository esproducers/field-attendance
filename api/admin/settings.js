import { pool, requireAdmin } from '../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'PATCH') return res.status(405).end();
    try {
        await requireAdmin(req);
        const appName = req.body.appName || 'Field Attendance';
        const logo = req.body.logo || '';
        await pool.query("INSERT INTO system_settings(key,value) VALUES('app_name',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(appName)]);
        await pool.query("INSERT INTO system_settings(key,value) VALUES('app_logo',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(logo)]);
        res.status(200).json({ appName, logo });
    } catch (e) { res.status(500).json({ error: e.message }); }
}