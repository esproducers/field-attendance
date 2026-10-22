import pg from 'pg';
import { scryptSync, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ================= 1. 基础配置与数据库 =================
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || process.env.STORAGE_URL, max: 10 });

const hashPass = (s) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(s, salt, 64).toString('hex')}`; };
const checkPass = (s, h) => { try { const [salt, hex] = h.split(':'); return timingSafeEqual(scryptSync(s, salt, 64), Buffer.from(hex, 'hex')); } catch { return false; } };
const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
const clean = (x, max = 500) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);

// ================= 2. 鉴权工具 =================
async function getAuthUser(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/fa_session=([^;]+)/);
    if (!match) throw new Error('Please sign in');
    const { rows } = await pool.query(`SELECT u.id,u.email,u.full_name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [tokenHash(match[1])]);
    if (!rows[0]?.active) throw new Error('Session expired');
    return rows[0];
}
async function requireAdmin(req) {
    const u = await getAuthUser(req);
    if (u.role !== 'admin') throw new Error('Administrator access required');
    return u;
}

// ================= 3. 主入口逻辑 =================
export default async function handler(req, res) {
    // 获取请求路径，例如 /api/login
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname.replace(/\/$/, ''); // 去掉末尾斜杠
    const method = req.method;

    try {
        // ---------------- Auth & Users ----------------
        if (path === '/api/signup' && method === 'POST') return handleSignup(req, res);
        if (path === '/api/login' && method === 'POST') return handleLogin(req, res);
        if (path === '/api/logout' && method === 'POST') return handleLogout(req, res);
        if (path === '/api/me' && method === 'GET') return handleMe(req, res);
        if (path === '/api/change-password' && method === 'POST') return handleChangePassword(req, res);

        // ---------------- Core Data ----------------
        if (path === '/api/settings' && method === 'GET') return handleSettings(req, res);
        if (path === '/api/sites') return handleSites(req, res, method);
        if (path === '/api/records' && method === 'GET') return handleRecords(req, res);
        if (path === '/api/records/sync' && method === 'POST') return handleRecordSync(req, res);

        // 动态路由: /api/records/[id]/photos
        const photosMatch = path.match(/^\/api\/records\/([0-9a-f-]+)\/photos$/i);
        if (photosMatch && method === 'GET') return handleRecordPhotos(req, res, photosMatch[1]);

        if (path === '/api/photos/orphan-bind' && method === 'POST') return handleOrphanBind(req, res);
        if (path === '/api/get-upload-url' && method === 'GET') return handleGetUploadUrl(req, res);

        // ---------------- Admin ----------------
        if (path === '/api/admin/summary' && method === 'GET') return handleAdminSummary(req, res);
        if (path === '/api/admin/users' && method === 'GET') return handleAdminUsers(req, res);
        if (path === '/api/admin/audit' && method === 'GET') return handleAdminAudit(req, res);
        if (path === '/api/admin/settings' && method === 'PATCH') return handleAdminSettings(req, res);
        if (path === '/api/admin/export.csv' && method === 'GET') return handleExportCsv(req, res);

        // 动态路由: /api/admin/users/[id]
        const userMatch = path.match(/^\/api\/admin\/users\/([0-9a-f-]+)$/i);
        if (userMatch && method === 'PATCH') return handleAdminUpdateUser(req, res, userMatch[1]);

        // ---------------- Backup ----------------
        if (path === '/api/admin/backup/settings' && method === 'GET') return handleBackupSettings(req, res);
        if (path === '/api/admin/backup/schedule' && method === 'PATCH') return handleBackupSchedule(req, res);
        if (path === '/api/admin/backup/manual' && method === 'POST') return handleBackupManual(req, res);
        if (path === '/api/admin/backup/clear' && method === 'POST') return handleBackupClear(req, res);

        return res.status(404).json({ error: 'API Route Not Found' });
    } catch (e) {
        console.error('API Error:', e);
        res.status(e.message.includes('sign in') ? 401 : e.message.includes('access') ? 403 : 500).json({ error: e.message || 'Server error' });
    }
}

// ================= 4. 各个路由的具体实现 =================

async function handleSignup(req, res) {
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
        throw e;
    }
}

async function handleLogin(req, res) {
    const { email, password } = req.body || {};
    const r = await pool.query('SELECT * FROM users WHERE email=$1', [String(email || '').toLowerCase().trim()]);
    const u = r.rows[0];
    if (!u || !u.active || !checkPass(String(password || ''), u.password_hash)) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = randomBytes(32).toString('hex');
    await pool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '14 days')`, [u.id, tokenHash(token)]);
    res.setHeader('Set-Cookie', `fa_session=${token}; HttpOnly; Path=/; Max-Age=${14 * 24 * 3600}; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    return res.status(200).json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
}

async function handleLogout(req, res) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/fa_session=([^;]+)/);
    if (match) await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1', [tokenHash(match[1])]);
    res.setHeader('Set-Cookie', 'fa_session=; HttpOnly; Path=/; Max-Age=0');
    return res.status(200).json({ ok: true });
}

async function handleMe(req, res) {
    const u = await getAuthUser(req);
    return res.status(200).json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
}

async function handleChangePassword(req, res) {
    const u = await getAuthUser(req);
    const { old_password, new_password } = req.body || {};
    const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [u.id]);
    if (!checkPass(String(old_password || ''), r.rows[0].password_hash) || typeof new_password !== 'string' || new_password.length < 12) {
        return res.status(400).json({ error: 'Invalid current password or new password too short' });
    }
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPass(new_password), u.id]);
    await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [u.id]);
    return res.status(200).json({ ok: true, signInAgain: true });
}

async function handleSettings(req, res) {
    const r = await pool.query("SELECT key,value FROM system_settings WHERE key IN ('app_name','app_logo')");
    const v = Object.fromEntries(r.rows.map(x => [x.key, x.value]));
    return res.status(200).json({ appName: typeof v.app_name === 'string' ? v.app_name : 'Field Attendance', logo: typeof v.app_logo === 'string' ? v.app_logo : '' });
}

async function handleSites(req, res, method) {
    if (method === 'GET') {
        await getAuthUser(req);
        const r = await pool.query('SELECT * FROM sites ORDER BY name');
        return res.status(200).json({ sites: r.rows });
    }
    if (method === 'POST') {
        await requireAdmin(req);
        const name = clean(req.body?.name, 120);
        if (!name) return res.status(400).json({ error: 'Site name required' });
        const r = await pool.query('INSERT INTO sites(name,address,latitude,longitude) VALUES($1,$2,$3,$4) RETURNING *', [name, clean(req.body?.address, 300), req.body?.latitude || null, req.body?.longitude || null]);
        return res.status(200).json({ site: r.rows[0] });
    }
    return res.status(405).end();
}

async function handleRecords(req, res) {
    const u = await getAuthUser(req);
    const isAdmin = u.role === 'admin';
    const query = `SELECT a.*,u.full_name,u.email,s.name AS site_name,(SELECT count(*)::int FROM photos p WHERE p.attendance_id=a.id) AS photo_count 
                   FROM attendance_records a JOIN users u ON a.user_id=u.id LEFT JOIN sites s ON a.site_id=s.id 
                   ${isAdmin ? '' : 'WHERE a.user_id=$1'} ORDER BY a.created_at DESC LIMIT 1000`;
    const r = await pool.query(query, isAdmin ? [] : [u.id]);
    return res.status(200).json({ records: r.rows });
}

async function handleRecordSync(req, res) {
    const u = await getAuthUser(req);
    const b = req.body || {};
    if (!uuid(b.id)) return res.status(400).json({ error: 'Valid UUID required' });
    if (!['check_in', 'check_out'].includes(b.action)) return res.status(400).json({ error: 'Invalid action' });

    const time = new Date(b.device_at).toISOString();
    const location = clean(b.location_name, 200);
    const lat = b.latitude || null;
    const lng = b.longitude || null;
    const photoUrls = b.photo_urls || [];

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (b.action === 'check_in') {
            const open = await client.query(`SELECT id FROM attendance_records WHERE user_id=$1 AND status='checked_in' AND id<>$2 LIMIT 1 FOR UPDATE`, [u.id, b.id]);
            if (open.rows.length) throw new Error('Please check out the current point before checking in at the next point');

            await client.query(`INSERT INTO attendance_records(id,user_id,location_name,check_in_device_at,check_in_received_at,check_in_lat,check_in_lng,notes,status) 
                                VALUES($1,$2,$3,$4,now(),$5,$6,$7,'checked_in') ON CONFLICT(id) DO NOTHING`, [b.id, u.id, location, time, lat, lng, clean(b.notes, 3000)]);

            for (const url of photoUrls) {
                await client.query(`INSERT INTO photos(id,attendance_id,phase,file_path,mime_type,byte_size) VALUES($1,$2,'before',$3,'image/jpeg',0)`, [crypto.randomUUID(), b.id, url]);
            }
        } else {
            await client.query(`UPDATE attendance_records SET check_out_device_at=$3,check_out_received_at=now(),check_out_lat=$4,check_out_lng=$5,check_out_location_name=$6,check_out_notes=$7,status='completed',updated_at=now() 
                                WHERE id=$1 AND user_id=$2 AND check_out_device_at IS NULL`, [b.id, u.id, time, lat, lng, location, clean(b.notes, 3000)]);
            for (const url of photoUrls) {
                await client.query(`INSERT INTO photos(id,attendance_id,phase,file_path,mime_type,byte_size) VALUES($1,$2,'after',$3,'image/jpeg',0)`, [crypto.randomUUID(), b.id, url]);
            }
        }
        await client.query('COMMIT');
        return res.status(200).json({ ok: true });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

async function handleRecordPhotos(req, res, recordId) {
    const u = await getAuthUser(req);
    const r = await pool.query(`SELECT p.id,p.phase,p.file_path as url FROM photos p JOIN attendance_records a ON a.id=p.attendance_id WHERE a.id=$1 AND (a.user_id=$2 OR $3='admin')`, [recordId, u.id, u.role]);
    return res.status(200).json({ photos: r.rows });
}

async function handleOrphanBind(req, res) {
    const { recordId, url } = req.body || {};
    await pool.query(`INSERT INTO photos(id,attendance_id,phase,file_path,mime_type,byte_size) VALUES($1,$2,'after',$3,'image/jpeg',0)`, [crypto.randomUUID(), recordId, url]);
    return res.status(200).json({ ok: true });
}

async function handleGetUploadUrl(req, res) {
    await getAuthUser(req); // 确保已登录
    const s3 = new S3Client({
        region: process.env.B2_REGION || 'us-west-004',
        endpoint: process.env.B2_ENDPOINT,
        credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APPLICATION_KEY }
    });
    const filename = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
    const command = new PutObjectCommand({ Bucket: process.env.B2_BUCKET_NAME, Key: filename, ContentType: 'image/jpeg' });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });
    const downloadUrl = `${process.env.B2_PUBLIC_URL}/${filename}`;
    return res.status(200).json({ uploadUrl, downloadUrl });
}

async function handleAdminSummary(req, res) {
    await requireAdmin(req);
    const [users, records, open, photos] = await Promise.all([
        pool.query('SELECT count(*)::int n FROM users'), pool.query('SELECT count(*)::int n FROM attendance_records'),
        pool.query("SELECT count(*)::int n FROM attendance_records WHERE status='checked_in'"), pool.query('SELECT count(*)::int n FROM photos')
    ]);
    return res.status(200).json({ users: users.rows[0].n, records: records.rows[0].n, checkedIn: open.rows[0].n, photos: photos.rows[0].n });
}

async function handleAdminUsers(req, res) {
    await requireAdmin(req);
    const r = await pool.query('SELECT id,email,full_name,role,active,created_at FROM users ORDER BY created_at DESC');
    return res.status(200).json({ users: r.rows });
}

async function handleAdminUpdateUser(req, res, userId) {
    const actor = await requireAdmin(req);
    const b = req.body || {};
    if (userId === actor.id && (b.active === false || b.role === 'user')) {
        return res.status(400).json({ error: 'Cannot disable or demote your own admin account' });
    }
    const r = await pool.query('UPDATE users SET active=COALESCE($2,active),role=COALESCE($3,role),full_name=COALESCE($4,full_name) WHERE id=$1 RETURNING id,email,full_name,role,active',
        [userId, typeof b.active === 'boolean' ? b.active : null, ['admin', 'user'].includes(b.role) ? b.role : null, b.full_name || null]);
    return res.status(200).json({ user: r.rows[0] });
}

async function handleAdminAudit(req, res) {
    await requireAdmin(req);
    const r = await pool.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
    return res.status(200).json({ logs: r.rows });
}

async function handleAdminSettings(req, res) {
    await requireAdmin(req);
    const appName = req.body.appName || 'Field Attendance';
    const logo = req.body.logo || '';
    await pool.query("INSERT INTO system_settings(key,value) VALUES('app_name',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(appName)]);
    await pool.query("INSERT INTO system_settings(key,value) VALUES('app_logo',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(logo)]);
    return res.status(200).json({ appName, logo });
}

async function handleExportCsv(req, res) {
    await requireAdmin(req);
    const rows = (await pool.query('SELECT a.id,u.full_name,u.email,a.location_name,a.check_in_device_at,a.check_out_device_at,a.status,a.notes FROM attendance_records a JOIN users u ON a.user_id=u.id ORDER BY a.created_at DESC LIMIT 20000')).rows;
    const escape = v => '"' + String(v ?? '').replaceAll('"', '""') + '"';
    const cols = ['id', 'full_name', 'email', 'location_name', 'check_in_device_at', 'check_out_device_at', 'status', 'notes'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
    return res.status(200).send('\uFEFF' + cols.join(',') + '\r\n' + rows.map(r => cols.map(k => escape(r[k])).join(',')).join('\r\n'));
}

async function handleBackupSettings(req, res) {
    await requireAdmin(req);
    const r = await pool.query("SELECT value FROM system_settings WHERE key='backup_schedule'");
    return res.status(200).json({ schedule: r.rows[0]?.value || { enabled: false, time: '02:00', keep: 14 }, files: [] });
}

async function handleBackupSchedule(req, res) {
    await requireAdmin(req);
    const schedule = { enabled: !!req.body.enabled, time: req.body.time || '02:00', keep: Number(req.body.keep) || 14 };
    await pool.query("INSERT INTO system_settings(key,value) VALUES('backup_schedule',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(schedule)]);
    return res.status(200).json({ ok: true, schedule });
}

async function handleBackupManual(req, res) {
    await requireAdmin(req);
    const tables = ['users', 'sites', 'attendance_records', 'photos', 'sync_events', 'audit_logs', 'system_settings'];
    const data = { format: 'field-attendance-backup-v1', createdAt: new Date().toISOString(), tables: {} };
    for (const table of tables) {
        data.tables[table] = (await pool.query(`SELECT * FROM ${table}`)).rows;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="backup-${Date.now()}.json"`);
    return res.status(200).json(data);
}

async function handleBackupClear(req, res) {
    await requireAdmin(req);
    const { from, to, userId, location } = req.body;
    const values = [], clauses = [];
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
        return res.status(200).json({ ok: true, deletedRecords: ids.length, deletedPhotos: ids.length });
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally { client.release(); }
}