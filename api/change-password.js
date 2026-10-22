import { pool, getAuthUser, checkPass, hashPass } from './_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    try {
        const u = await getAuthUser(req);
        const { old_password, new_password } = req.body || {};
        const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id]);
        if (!checkPass(String(old_password || ''), r.rows[0].password_hash) || typeof new_password !== 'string' || new_password.length < 12) {
            return res.status(400).json({ error: 'Invalid current password or new password too short' });
        }
        await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPass(new_password), u.id]);
        await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [u.id]);
        return res.status(200).json({ ok: true, signInAgain: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}