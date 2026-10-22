import pg from 'pg';
import { scryptSync, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.STORAGE_URL, max: 10 });
export { pool };

export const hashPass = (s) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(s, salt, 64).toString('hex')}`; };
export const checkPass = (s, h) => { try { const [salt, hex] = h.split(':'); return timingSafeEqual(scryptSync(s, salt, 64), Buffer.from(hex, 'hex')); } catch { return false; } };
export const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
export const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
export const clean = (x, max = 500) => typeof x === 'string' ? x.trim().slice(0, max) : '';
export const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

// 获取当前登录用户
export async function getAuthUser(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/fa_session=([^;]+)/);
    if (!match) throw new Error('Please sign in');
    const token = match[1];

    const { rows } = await pool.query(`SELECT u.id,u.email,u.full_name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [tokenHash(token)]);
    if (!rows[0]?.active) throw new Error('Session expired');
    return rows[0];
}

// 必须为管理员
export async function requireAdmin(req) {
    const u = await getAuthUser(req);
    if (u.role !== 'admin') throw new Error('Administrator access required');
    return u;
}

// 统一响应格式
export function handleError(res, e) {
    console.error(e);
    res.status(e.message.includes('sign in') ? 401 : e.message.includes('access') ? 403 : 500).json({ error: e.message || 'Server error' });
}