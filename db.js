const { Pool } = require('pg');

// 💡 声明一个全局变量，利用 Vercel 容器的重用机制复用连接池
let pool;

if (!pool) {
    pool = new Pool({
        // Vercel 会自动读取你在控制台配置的环境变量 DATABASE_URL
        connectionString: process.env.DATABASE_URL,

        // 💡 针对 Vercel Serverless 环境做出的极致优化：
        max: 1,                 // 每个 Serverless 容器只需 1 个并发连接，省下大量内存
        idleTimeoutMillis: 5000, // 超过 5 秒没有数据库操作，立刻自动断开连接，防止塞爆 Neon 数据库
        ssl: {
            rejectUnauthorized: false // 云端安全连接必须开启 SSL
        }
    });
}

// 导出最省内存的查询方法
module.exports = {
    query: (text, params) => pool.query(text, params),
};
