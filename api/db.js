import { neon } from '@neondatabase/serverless';
// 自动读取 Vercel 注入的 DATABASE_URL
export const sql = neon(process.env.DATABASE_URL);