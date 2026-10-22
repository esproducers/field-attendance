import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import pg from 'pg';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const app = Fastify({ logger: true, bodyLimit: 2_000_000 });
await app.register(cookie);
await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1 } });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'web');
const uploadDir = path.join(root, 'storage/uploads');
const backupDir = path.join(root, 'storage/backups');
await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(backupDir, { recursive: true });
const hashPass = (s) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(s,salt,64).toString('hex')}`; };
const checkPass = (s,h) => { try { const [salt,hex]=h.split(':'); return timingSafeEqual(scryptSync(s,salt,64), Buffer.from(hex,'hex')); } catch { return false; } };
const tokenHash = (t) => createHash('sha256').update(t).digest('hex');
const bad = (code,message) => Object.assign(new Error(message), { statusCode: code });
const validEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
const dateOrNull = d => d && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : null;
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
const num = x => x === undefined || x === null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const clean = (x,max=500) => typeof x === 'string' ? x.trim().slice(0,max) : '';
async function initialize() {
  const sql = await fs.readFile(path.join(root,'sql/001_schema.sql'),'utf8');
  await pool.query(sql);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'checked_in'`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_accuracy DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_accuracy DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_location_name TEXT`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_notes TEXT`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_notes TEXT`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS location_name TEXT`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_location_name TEXT`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_device_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_device_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_received_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_received_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS notes TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS attendance_created_idx ON attendance_records(created_at DESC)`);
  const adminEmail = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  if (!validEmail(adminEmail) || adminPassword.length < 12 || adminPassword.startsWith('CHANGE_ME')) throw new Error('Configure ADMIN_EMAIL and a strong ADMIN_PASSWORD (12+ chars) in .env');
  await pool.query(`INSERT INTO users (email,password_hash,full_name,role) VALUES ($1,$2,'System Administrator','admin') ON CONFLICT(email) DO NOTHING`, [adminEmail,hashPass(adminPassword)]);
  await pool.query(`UPDATE users SET role='admin',active=true WHERE email=$1`,[adminEmail]);
}
await initialize();
async function auth(req) {
  const token = req.cookies.fa_session;
  if (!token) throw bad(401,'Please sign in');
  const { rows } = await pool.query(`SELECT u.id,u.email,u.full_name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`,[tokenHash(token)]);
  if (!rows[0]?.active) throw bad(401,'Session expired');
  return rows[0];
}
async function admin(req) { const u=await auth(req); if(u.role!=='admin') throw bad(403,'Administrator access required'); return u; }
const safeUser = u => ({id:u.id,email:u.email,full_name:u.full_name,role:u.role,active:u.active});
async function login(reply,u) {
  const token = randomBytes(32).toString('hex');
  await pool.query(`INSERT INTO sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '14 days')`,[u.id,tokenHash(token)]);
  reply.setCookie('fa_session',token,{httpOnly:true,sameSite:'strict',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:14*24*3600});
  return {user:safeUser(u)};
}
app.addHook('onRequest', async(req,reply)=>{
  reply.header('X-Content-Type-Options','nosniff'); reply.header('Referrer-Policy','no-referrer');
  reply.header('X-Frame-Options','DENY');
  if(req.url.startsWith('/api/') && !['GET','HEAD','OPTIONS'].includes(req.method)) {
    const origin=req.headers.origin;
    if(origin) { try { if(new URL(origin).host !== req.headers.host) throw bad(403,'Cross-origin request rejected'); } catch(e){ throw bad(403,'Cross-origin request rejected'); } }
  }
});
app.setErrorHandler((err,req,reply)=>{ req.log.error(err); reply.code(err.statusCode || 500).send({error:err.statusCode ? err.message : 'Server error'}); });
app.get('/health', async()=>{ const r=await pool.query('SELECT now() AS server_time'); return {status:'ok',database:'connected',serverTime:r.rows[0].server_time}; });
app.post('/api/signup', {config:{rateLimit:false}}, async(req,reply)=>{
  const {email,password,full_name}=req.body||{};
  if(!validEmail(email) || typeof password!=='string' || password.length<12 || password.length>128 || clean(full_name,100).length<2) throw bad(400,'Provide a name, valid email, and password of at least 12 characters');
  try { const r=await pool.query(`INSERT INTO users(email,password_hash,full_name) VALUES ($1,$2,$3) RETURNING *`,[email.toLowerCase().trim(),hashPass(password),clean(full_name,100)]); return login(reply,r.rows[0]); }
  catch(e){ if(e.code==='23505') throw bad(409,'Email already registered'); throw e; }
});
app.post('/api/login',async(req,reply)=>{
  const {email,password}=req.body||{};
  const r=await pool.query('SELECT * FROM users WHERE email=$1',[String(email||'').toLowerCase().trim()]);
  if(!r.rows[0] || !r.rows[0].active || !checkPass(String(password||''),r.rows[0].password_hash)) throw bad(401,'Invalid credentials');
  return login(reply,r.rows[0]);
});
app.post('/api/logout',async(req,reply)=>{ if(req.cookies.fa_session) await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[tokenHash(req.cookies.fa_session)]); reply.clearCookie('fa_session',{path:'/'}); return {ok:true}; });
app.get('/api/me',async(req)=>({user:safeUser(await auth(req))}));
app.post('/api/change-password',async(req)=>{const u=await auth(req); const {old_password,new_password}=req.body||{}; const r=await pool.query('SELECT password_hash FROM users WHERE id=$1',[u.id]); if(!checkPass(String(old_password||''),r.rows[0].password_hash) || typeof new_password!=='string' || new_password.length<12) throw bad(400,'Invalid current password or new password too short'); await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hashPass(new_password),u.id]); await pool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1',[u.id]); return {ok:true,signInAgain:true};});
app.get('/api/sites',async(req)=>{await auth(req); return {sites:(await pool.query('SELECT * FROM sites ORDER BY name')).rows};});
app.post('/api/sites',async(req)=>{await admin(req); const name=clean(req.body?.name,120); if(!name) throw bad(400,'Site name required'); const r=await pool.query('INSERT INTO sites(name,address,latitude,longitude) VALUES($1,$2,$3,$4) RETURNING *',[name,clean(req.body?.address,300),num(req.body?.latitude),num(req.body?.longitude)]); return {site:r.rows[0]};});
app.get('/api/records',async(req)=>{const u=await auth(req); const isAdmin=u.role==='admin'; const {rows}=await pool.query(`SELECT a.*,u.full_name,u.email,s.name AS site_name,(SELECT count(*)::int FROM photos p WHERE p.attendance_id=a.id) AS photo_count FROM attendance_records a JOIN users u ON a.user_id=u.id LEFT JOIN sites s ON a.site_id=s.id ${isAdmin?'':'WHERE a.user_id=$1'} ORDER BY a.created_at DESC LIMIT 1000`,isAdmin?[]:[u.id]);return {records:rows};});
app.post('/api/records/sync',async(req)=>{
  const u=await auth(req); const b=req.body||{};
  if(!uuid(b.id)) throw bad(400,'Valid UUID required');
  if(!['check_in','check_out'].includes(b.action)) throw bad(400,'Invalid action');
  const time=dateOrNull(b.device_at); if(!time) throw bad(400,'Valid device timestamp required');
  const siteId=uuid(b.site_id)?b.site_id:null;
  const location=clean(b.location_name,200); if(!location) throw bad(400,'Location / Site Name is required');
  const lat=num(b.latitude),lng=num(b.longitude),accuracy=num(b.accuracy);
  if(lat===null || lng===null) throw bad(400,'GPS location is required before submitting');
  if(lat!==null && (lat < -90 || lat > 90)) throw bad(400,'Invalid latitude');
  if(lng!==null && (lng < -180 || lng > 180)) throw bad(400,'Invalid longitude');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    let record;
    if(b.action==='check_in') {
      const open=await client.query(`SELECT id FROM attendance_records WHERE user_id=$1 AND status='checked_in' AND id<>$2 LIMIT 1 FOR UPDATE`,[u.id,b.id]);
      if(open.rows.length) throw bad(409,'Please check out the current point before checking in at the next point');
      const r=await client.query(`INSERT INTO attendance_records(id,user_id,site_id,location_name,check_in_device_at,check_in_received_at,check_in_lat,check_in_lng,check_in_accuracy,notes,check_in_notes,status) VALUES($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$9,'checked_in') ON CONFLICT(id) DO NOTHING RETURNING *`,[b.id,u.id,siteId,location,time,lat,lng,accuracy,clean(b.notes,3000)]);
      record=r.rows[0];
      if(!record){const ex=await client.query('SELECT * FROM attendance_records WHERE id=$1',[b.id]); record=ex.rows[0]; if(!record || record.user_id!==u.id) throw bad(409,'Record ID conflict');}
    } else {
      const checkoutLocation=clean(b.location_name,200); if(!checkoutLocation) throw bad(400,'Check Out Location is required');
      const r=await client.query(`UPDATE attendance_records SET check_out_device_at=$3,check_out_received_at=now(),check_out_lat=$4,check_out_lng=$5,check_out_accuracy=$6,check_out_location_name=$7,check_out_notes=$8,status='completed',updated_at=now() WHERE id=$1 AND user_id=$2 AND check_out_device_at IS NULL RETURNING *`,[b.id,u.id,time,lat,lng,accuracy,checkoutLocation,clean(b.notes,3000)]);
      record=r.rows[0];
      if(!record){const ex=await client.query('SELECT * FROM attendance_records WHERE id=$1 AND user_id=$2',[b.id,u.id]); record=ex.rows[0]; if(!record) throw bad(409,'Check in must be synced before check out');}
    }
    await client.query(`INSERT INTO sync_events(attendance_id,event_type,details) VALUES($1,$2,$3)`,[b.id,b.action,JSON.stringify({device_at:time})]);
    await client.query('COMMIT'); return {ok:true,record};
  } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
});
app.post('/api/photos/:id/:phase/:photoId',async(req)=>{
  const u=await auth(req),{id,phase,photoId}=req.params;
  if(!uuid(id)||!uuid(photoId)||!['before','after'].includes(phase)) throw bad(400,'Invalid photo identifier');
  const r=await pool.query('SELECT id,user_id FROM attendance_records WHERE id=$1',[id]);
  if(!r.rows[0]||r.rows[0].user_id!==u.id) throw bad(404,'Attendance record not found');
  const old=await pool.query('SELECT id FROM photos WHERE id=$1 AND attendance_id=$2',[photoId,id]);
  if(old.rows.length) return {ok:true,duplicate:true};
  const file=await req.file(); if(!file) throw bad(400,'Photo required');
  const allowed={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
  if(!allowed[file.mimetype]) throw bad(415,'Only JPEG, PNG and WebP images allowed');
  const folder=path.join(uploadDir,id); await fs.mkdir(folder,{recursive:true});
  const dest=path.join(folder,`${photoId}.${allowed[file.mimetype]}`);
  await pipeline(file.file,createWriteStream(dest,{flags:'wx'}));
  const data=await fs.readFile(dest);
  const sig=data.subarray(0,12); const isJpg=sig[0]===0xff&&sig[1]===0xd8; const isPng=sig.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')); const isWebp=sig.toString('ascii',0,4)==='RIFF'&&sig.toString('ascii',8,12)==='WEBP';
  if(!((file.mimetype==='image/jpeg'&&isJpg)||(file.mimetype==='image/png'&&isPng)||(file.mimetype==='image/webp'&&isWebp))){await fs.unlink(dest);throw bad(415,'Invalid image contents');}
  try {await pool.query('INSERT INTO photos(id,attendance_id,phase,file_path,mime_type,byte_size,checksum_sha256) VALUES($1,$2,$3,$4,$5,$6,$7)',[photoId,id,phase,dest,file.mimetype,data.length,createHash('sha256').update(data).digest('hex')]);} catch(e){await fs.unlink(dest).catch(()=>{});throw e;}
  return {ok:true,id:photoId,bytes:data.length};
});
app.get('/api/records/:id/photos',async(req)=>{const u=await auth(req);const r=await pool.query(`SELECT p.id,p.phase,p.byte_size,p.uploaded_at FROM photos p JOIN attendance_records a ON a.id=p.attendance_id WHERE a.id=$1 AND (a.user_id=$2 OR $3='admin') ORDER BY p.uploaded_at`,[req.params.id,u.id,u.role]);return {photos:r.rows};});
app.get('/api/photo/:photoId',async(req,reply)=>{const u=await auth(req);const r=await pool.query(`SELECT p.file_path,p.mime_type FROM photos p JOIN attendance_records a ON a.id=p.attendance_id WHERE p.id=$1 AND (a.user_id=$2 OR $3='admin')`,[req.params.photoId,u.id,u.role]);if(!r.rows[0]) throw bad(404,'Photo not found');reply.type(r.rows[0].mime_type).header('Cache-Control','private,no-store');return reply.send(await fs.readFile(r.rows[0].file_path));});
app.get('/api/settings',async()=>{const r=await pool.query("SELECT key,value FROM system_settings WHERE key IN ('app_name','app_logo')");const values=Object.fromEntries(r.rows.map(x=>[x.key,x.value]));return {appName:typeof values.app_name==='string'?values.app_name:'Field Attendance',logo:typeof values.app_logo==='string'?values.app_logo:''};});
app.patch('/api/admin/settings',async(req)=>{const actor=await admin(req);const b=req.body||{};const appName=clean(b.appName,80)||'Field Attendance';const logo=typeof b.logo==='string'&&b.logo.length<=700000&&(/^data:image\/(png|jpeg|webp);base64,/.test(b.logo))?b.logo:'';await pool.query("INSERT INTO system_settings(key,value) VALUES('app_name',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(appName)]);await pool.query("INSERT INTO system_settings(key,value) VALUES('app_logo',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(logo)]);await pool.query("INSERT INTO audit_logs(actor_id,action,resource_type) VALUES($1,'update_branding','settings')",[actor.id]);return {ok:true,appName,logo};});
app.get('/api/admin/summary',async(req)=>{await admin(req);const [users,records,open,photos]=await Promise.all([pool.query('SELECT count(*)::int n FROM users'),pool.query('SELECT count(*)::int n FROM attendance_records'),pool.query("SELECT count(*)::int n FROM attendance_records WHERE status='checked_in'"),pool.query('SELECT count(*)::int n FROM photos')]);return {users:users.rows[0].n,records:records.rows[0].n,checkedIn:open.rows[0].n,photos:photos.rows[0].n};});
app.get('/api/admin/users',async(req)=>{await admin(req);return {users:(await pool.query('SELECT id,email,full_name,role,active,created_at FROM users ORDER BY created_at DESC')).rows};});
app.patch('/api/admin/users/:id',async(req)=>{const actor=await admin(req);const {id}=req.params;if(!uuid(id)) throw bad(400,'Invalid user');const b=req.body||{};if(id===actor.id && (b.active===false||b.role==='user')) throw bad(400,'Cannot disable or demote your own admin account');const r=await pool.query('UPDATE users SET active=COALESCE($2,active),role=COALESCE($3,role),full_name=COALESCE($4,full_name) WHERE id=$1 RETURNING id,email,full_name,role,active',[id,typeof b.active==='boolean'?b.active:null,['admin','user'].includes(b.role)?b.role:null,clean(b.full_name,100)||null]);if(!r.rows[0]) throw bad(404,'User not found');await pool.query('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4)',[actor.id,'update_user','user',id]);return {user:r.rows[0]};});
app.get('/api/admin/export.csv',async(req,reply)=>{await admin(req);const rows=(await pool.query('SELECT a.id,u.full_name,u.email,a.location_name,a.check_in_device_at,a.check_out_device_at,a.status,a.notes FROM attendance_records a JOIN users u ON a.user_id=u.id ORDER BY a.created_at DESC LIMIT 20000')).rows;const escape=v=>'"'+String(v??'').replaceAll('"','""')+'"';const cols=['id','full_name','email','location_name','check_in_device_at','check_out_device_at','status','notes'];reply.type('text/csv; charset=utf-8').header('Content-Disposition','attachment; filename="attendance.csv"');return '\uFEFF'+cols.join(',')+'\r\n'+rows.map(r=>cols.map(k=>escape(r[k])).join(',')).join('\r\n');});
app.get('/api/admin/backup/settings',async(req)=>{await admin(req);const r=await pool.query("SELECT value FROM system_settings WHERE key='backup_schedule'");return {schedule:r.rows[0]?.value||{enabled:false,time:'02:00',keep:14},files:(await fs.readdir(backupDir)).filter(x=>x.endsWith('.tar.gz')).sort().reverse().map(async name=>{const st=await fs.stat(path.join(backupDir,name));return {name,size:st.size,created:st.mtime.toISOString()}}).length?await Promise.all((await fs.readdir(backupDir)).filter(x=>x.endsWith('.tar.gz')).sort().reverse().map(async name=>{const st=await fs.stat(path.join(backupDir,name));return {name,size:st.size,created:st.mtime.toISOString()}})):[]};});
async function createBackup(){
 const stamp=new Date().toISOString().replace(/[:.]/g,'-');const name=`field-attendance-backup-${stamp}.tar.gz`;const work=path.join(backupDir,`.work-${randomUUID()}`);await fs.mkdir(path.join(work,'photos'),{recursive:true});
 try {const tables=['users','sites','attendance_records','photos','sync_events','audit_logs','system_settings','password_reset_tokens','sessions','condition_reports'];const data={format:'field-attendance-backup-v1',createdAt:new Date().toISOString(),tables:{}};for(const table of tables){const r=await pool.query(`SELECT * FROM ${table}`);data.tables[table]=r.rows;}for(const photo of data.tables.photos){try{await fs.copyFile(photo.file_path,path.join(work,'photos',`${photo.id}${path.extname(photo.file_path)||'.img'}`));}catch{}}
 await fs.writeFile(path.join(work,'database.json'),JSON.stringify(data,null,2));await fs.writeFile(path.join(work,'README.txt'),'Field Attendance backup. database.json contains exported PostgreSQL table data. photos/ contains the photo files. Store this archive securely; it contains personal attendance data.');await execFileAsync('tar',['-czf',path.join(backupDir,name),'-C',work,'.']);return {name,path:path.join(backupDir,name)};
 } finally {await fs.rm(work,{recursive:true,force:true});}
}
app.post('/api/admin/backup/manual',async(req,reply)=>{const actor=await admin(req);const b=await createBackup();await pool.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id) VALUES($1,'manual_backup','backup',$2)",[actor.id,b.name]);reply.type('application/gzip').header('Content-Disposition',`attachment; filename="${b.name}"`);return reply.send(await fs.readFile(b.path));});
app.patch('/api/admin/backup/schedule',async(req)=>{const actor=await admin(req);const b=req.body||{};const time=String(b.time||'02:00');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time))throw bad(400,'Enter backup time in HH:MM format');const schedule={enabled:!!b.enabled,time,keep:Math.min(365,Math.max(1,Number(b.keep)||14)),lastRunDate:b.lastRunDate||null};await pool.query("INSERT INTO system_settings(key,value) VALUES('backup_schedule',$1::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[JSON.stringify(schedule)]);await pool.query("INSERT INTO audit_logs(actor_id,action,resource_type) VALUES($1,'update_backup_schedule','backup')",[actor.id]);return {ok:true,schedule};});
app.get('/api/admin/backup/download/:name',async(req,reply)=>{await admin(req);const name=path.basename(req.params.name);if(name!==req.params.name||!name.endsWith('.tar.gz'))throw bad(400,'Invalid backup name');const file=path.join(backupDir,name);try{await fs.access(file)}catch{throw bad(404,'Backup not found')}reply.type('application/gzip').header('Content-Disposition',`attachment; filename="${name}"`);return reply.send(await fs.readFile(file));});
app.post('/api/admin/backup/clear',async(req)=>{const actor=await admin(req);const b=req.body||{};const values=[];const clauses=[];if(b.from){if(Number.isNaN(Date.parse(b.from)))throw bad(400,'Invalid start date');values.push(new Date(b.from+'T00:00:00.000Z'));clauses.push(`a.created_at >= $${values.length}`)}if(b.to){if(Number.isNaN(Date.parse(b.to)))throw bad(400,'Invalid end date');values.push(new Date(b.to+'T23:59:59.999Z'));clauses.push(`a.created_at <= $${values.length}`)}if(b.userId){values.push(b.userId);clauses.push(`a.user_id = $${values.length}::uuid`)}if(b.location){values.push('%'+String(b.location).trim().slice(0,120)+'%');clauses.push(`(a.location_name ILIKE $${values.length} OR a.check_out_location_name ILIKE $${values.length})`)}if(!clauses.length)throw bad(400,'Select at least one filter (date, user, or location) before clearing data');const client=await pool.connect();let files=[];let count=0;try{await client.query('BEGIN');const selected=await client.query(`SELECT a.id FROM attendance_records a WHERE ${clauses.join(' AND ')} FOR UPDATE`,values);const ids=selected.rows.map(x=>x.id);if(!ids.length){await client.query('ROLLBACK');return {ok:true,deletedRecords:0,deletedPhotos:0,message:'No matching records found'};}const photoRows=await client.query('SELECT p.file_path FROM photos p WHERE p.attendance_id=ANY($1::uuid[])', [ids]);files=photoRows.rows.map(x=>x.file_path);const deletedPhotos=await client.query('DELETE FROM photos WHERE attendance_id=ANY($1::uuid[])',[ids]);await client.query('DELETE FROM condition_reports WHERE attendance_id=ANY($1::uuid[])',[ids]);await client.query('DELETE FROM sync_events WHERE attendance_id=ANY($1::uuid[])',[ids]);await client.query('DELETE FROM attendance_records WHERE id=ANY($1::uuid[])',[ids]);count=ids.length;await client.query("INSERT INTO audit_logs(actor_id,action,resource_type,resource_id) VALUES($1,'clear_attendance_data','attendance_records',$2)",[actor.id,JSON.stringify({records:count,photos:deletedPhotos.rowCount,filters:{from:b.from||null,to:b.to||null,userId:b.userId||null,location:b.location||null}})]);await client.query('COMMIT');for(const file of files)await fs.unlink(file).catch(()=>{});return {ok:true,deletedRecords:count,deletedPhotos:deletedPhotos.rowCount};}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}});

const publicFiles = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css','/manifest.webmanifest':'manifest.webmanifest','/sw.js':'sw.js','/icon.svg':'icon.svg'};
app.get('/*',async(req,reply)=>{const filename=publicFiles[req.url.split('?')[0]];if(!filename) throw bad(404,'Not found');const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};reply.type(mime[path.extname(filename)]).header('Cache-Control',filename==='sw.js'?'no-store':'no-cache');return reply.send(await fs.readFile(path.join(webDir,filename)));});
setInterval(async()=>{try{const r=await pool.query("SELECT value FROM system_settings WHERE key='backup_schedule'");const schedule=r.rows[0]?.value;if(!schedule?.enabled)return;const now=new Date();const hhmm=now.toISOString().slice(11,16);const day=now.toISOString().slice(0,10);if(hhmm===schedule.time&&schedule.lastRunDate!==day){const backup=await createBackup();schedule.lastRunDate=day;await pool.query("UPDATE system_settings SET value=$1::jsonb WHERE key='backup_schedule'",[JSON.stringify(schedule)]);const old=(await fs.readdir(backupDir)).filter(x=>x.endsWith('.tar.gz')).sort().reverse();for(const name of old.slice(schedule.keep||14))await fs.unlink(path.join(backupDir,name)).catch(()=>{});app.log.info({backup:backup.name},'Scheduled backup complete');}}catch(e){app.log.error(e,'Scheduled backup failed')}},60000).unref();
await app.listen({host:'0.0.0.0',port:Number(process.env.PORT||8080)});
