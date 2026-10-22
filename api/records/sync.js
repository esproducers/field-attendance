import { pool, getAuthUser, uuid, clean } from '../_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    try {
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
                                    VALUES($1,$2,$3,$4,now(),$5,$6,$7,'checked_in') ON CONFLICT(id) DO NOTHING`,
                    [b.id, u.id, location, time, lat, lng, clean(b.notes, 3000)]);

                // 将照片 URL 存入数据库
                for (const url of photoUrls) {
                    await client.query(`INSERT INTO photos(id,attendance_id,phase,file_path,mime_type,byte_size) VALUES($1,$2,'before',$3,'image/jpeg',0)`, [crypto.randomUUID(), b.id, url]);
                }
            } else {
                await client.query(`UPDATE attendance_records SET check_out_device_at=$3,check_out_received_at=now(),check_out_lat=$4,check_out_lng=$5,check_out_location_name=$6,check_out_notes=$7,status='completed',updated_at=now() 
                                    WHERE id=$1 AND user_id=$2 AND check_out_device_at IS NULL`,
                    [b.id, u.id, time, lat, lng, location, clean(b.notes, 3000)]);
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
    } catch (e) { res.status(500).json({ error: e.message }); }
}