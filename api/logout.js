import { pool, tokenHash } from './_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/fa_session=([^;]+)/);
    if (match) await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [tokenHash(match[1])]);
    res.setHeader('Set-Cookie', 'fa_session=; HttpOnly; Path=/; Max-Age=0');
    return res.status(200).json({ ok: true });
}