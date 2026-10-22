import { pool, hashPass, validEmail, clean, tokenHash } from './_utils.js';
import { randomBytes } from 'node:crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { email, password, full_name } = req.body || {};
    if (!validEmail(email) || typeof password !== 'string' || password.length < 12 || clean(full_name, 100).length < 2) {
        return res.status(400).json({ error: 'Provide a name, valid email, and password of at least 12 characters' });
    }
    try {
        const r = await pool.query(`INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING *`, [email.toLowerCase().trim(), hashPass(password), clean(full_name, 100)]);
        const u = r.rows[0];
        const token = randomBytes(32).toString('hex');
        await pool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '14 days')`, [u.id, tokenHash(token)]);

        res.setHeader('Set-Cookie', `fa_session=${token}; HttpOnly; Path=/; Max-Age=${14 * 24 * 3600}; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return res.status(200).json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
        res.status(500).json({ error: e.message });
    }
}