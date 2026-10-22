const db = require('../db'); // 引入上面的轻量数据库连接

module.exports = async (req, res) => {
    // 💡 Vercel 只支持异步处理，必须包裹在 try-catch 中防止服务崩溃
    try {
        // 1. 读取资料示例
        const dbResult = await db.query('SELECT * FROM users WHERE id = $1', [1]);
        const userData = dbResult.rows[0] || { message: "未找到用户" };

        // 2. 存入照片路径（URL字符串）和资料示例
        // ⚠️ 再次强调：照片本身存到 Backblaze B2 等免签云盘，数据库只存照片的 URL 文本！
        const photoUrl = "https://your-backblaze-b2-storage.com";
        await db.query(
            'INSERT INTO photos (title, url) VALUES ($1, $2)',
            ['我的生活照', photoUrl]
        );

        // 3. 返回给前端（Vercel 专用的 res.status 和 json）
        return res.status(200).json({
            success: true,
            message: '资料与照片路径存取成功！',
            user: userData
        });

    } catch (err) {
        console.error('数据库操作失败：', err);
        return res.status(500).json({
            success: false,
            error: '服务器内部错误，请检查 Neon 数据库连接'
        });
    }
};
