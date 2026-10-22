import { pool } from '../_utils.js';
import { randomUUID } from 'node:crypto';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    try {
        const { recordId, url } = req.body;
        // 简单粗暴地绑定到最新的一条打卡记录上
        await pool.query(`INSERT INTO photos(id,attendance_id,phase,file_path,mime_type,byte_size) VALUES($1,$2,'after',$3,'image/jpeg',0)`, [randomUUID(), recordId, url]);
        res.status(200).json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
}