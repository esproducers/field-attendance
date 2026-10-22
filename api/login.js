import { pool, checkPass, tokenHash } from './_utils.js';
import { randomBytes } from 'node:crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { email, password } = req.body || {};
    try {
        const r = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()]);
        const u = r.rows[0];
        if (!u || !u.active || !checkPass(String(password || ''), u.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = randomBytes(32).toString('hex');
        await pool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '14 days')`, [u.id, tokenHash(token)]);

        res.setHeader('Set-Cookie', `fa_session=${token}; HttpOnly; Path=/; Max-Age=${14 * 24 * 3600}; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return res.status(200).json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}