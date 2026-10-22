import { getAuthUser } from './_utils.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).end();
    try {
        const u = await getAuthUser(req);
        return res.status(200).json({ user: { id: u.id, email: u.email, full_name: u.full_name, role: u.role } });
    } catch (e) {
        res.status(401).json({ error: e.message });
    }
}