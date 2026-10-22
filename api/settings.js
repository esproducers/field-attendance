import { pool } from './_utils.js';

export default async function handler(req, res) {
    const r = await pool.query("SELECT key,value FROM system_settings WHERE key IN ('app_name','app_logo')");
    const v = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    res.status(200).json({ appName: typeof v.app_name === 'string' ? v.app_name : 'Field Attendance', logo: typeof v.app_logo === 'string' ? v.app_logo : '' });
}