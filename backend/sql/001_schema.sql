-- ==========================================
-- 📦 全新部署必读：关于照片存储 (Neon Object Storage)
-- ==========================================
-- 数据库脚本只能创建表结构，无法直接创建云端存储桶 (Bucket)。
-- 如果你是全新部署，请务必在 Neon 控制台的 "Objects Storage" 页面：
-- 1. 手动创建一个名为 `attendance-photos` 的 Bucket。
-- 2. 将生成的相关密钥 (AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID 等) 填入 Vercel 环境变量。
-- 否则照片将无法上传到云端。

-- 1. 开启 UUID 扩展
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 2. 用户表
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), 
    email TEXT UNIQUE NOT NULL, 
    password_hash TEXT NOT NULL, 
    full_name TEXT NOT NULL, 
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')), 
    active BOOLEAN NOT NULL DEFAULT true, 
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. 站点表
CREATE TABLE IF NOT EXISTS sites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), 
    name TEXT NOT NULL, 
    address TEXT, 
    latitude DOUBLE PRECISION, 
    longitude DOUBLE PRECISION
);

-- 4. 打卡记录表
CREATE TABLE IF NOT EXISTS attendance_records (
    id UUID PRIMARY KEY, 
    user_id UUID NOT NULL REFERENCES users(id), 
    site_id UUID REFERENCES sites(id), 
    location_name TEXT, 
    check_out_location_name TEXT, 
    check_in_notes TEXT, 
    check_out_notes TEXT, 
    check_in_device_at TIMESTAMPTZ, 
    check_out_device_at TIMESTAMPTZ, 
    check_in_received_at TIMESTAMPTZ, 
    check_out_received_at TIMESTAMPTZ, 
    check_in_lat DOUBLE PRECISION, 
    check_in_lng DOUBLE PRECISION, 
    check_out_lat DOUBLE PRECISION, 
    check_out_lng DOUBLE PRECISION, 
    check_in_accuracy DOUBLE PRECISION,
    check_out_accuracy DOUBLE PRECISION,
    status TEXT NOT NULL DEFAULT 'checked_in',
    notes TEXT, 
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), 
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. 照片表 (🌟 已移除 CHECK 限制，现在支持 4 种 phase)
CREATE TABLE IF NOT EXISTS photos (
    id UUID PRIMARY KEY, 
    attendance_id UUID NOT NULL REFERENCES attendance_records(id), 
    phase TEXT NOT NULL, 
    file_path TEXT NOT NULL, 
    mime_type TEXT NOT NULL, 
    byte_size BIGINT NOT NULL, 
    checksum_sha256 TEXT, 
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. 同步事件表
CREATE TABLE IF NOT EXISTS sync_events (
    id BIGSERIAL PRIMARY KEY, 
    attendance_id UUID REFERENCES attendance_records(id), 
    event_type TEXT NOT NULL, 
    details JSONB, 
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 7. 审计日志表
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY, 
    actor_id UUID REFERENCES users(id), 
    action TEXT NOT NULL, 
    resource_type TEXT, 
    resource_id TEXT, 
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. 系统设置表
CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY, 
    value JSONB NOT NULL
);

-- 9. 密码重置令牌表
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), 
    user_id UUID NOT NULL REFERENCES users(id), 
    token_hash TEXT NOT NULL, 
    expires_at TIMESTAMPTZ NOT NULL, 
    used_at TIMESTAMPTZ
);

-- 10. 会话表
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), 
    user_id UUID NOT NULL REFERENCES users(id), 
    token_hash TEXT NOT NULL, 
    expires_at TIMESTAMPTZ NOT NULL, 
    revoked_at TIMESTAMPTZ
);

-- 11. 状况报告表
CREATE TABLE IF NOT EXISTS condition_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(), 
    attendance_id UUID NOT NULL REFERENCES attendance_records(id), 
    note TEXT, 
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12. 索引 (确保查询速度)
CREATE INDEX IF NOT EXISTS attendance_user_time_idx ON attendance_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attendance_created_idx ON attendance_records(created_at DESC);


-- ==========================================
-- 🚨 以下为安全升级指令（针对已有旧数据库）
-- 如果你之前跑过旧版脚本，这些指令会自动修复缺失的列和约束
-- ==========================================

-- 解除原本对 phase 只允许 'before' 和 'after' 的限制
ALTER TABLE photos DROP CONSTRAINT IF EXISTS photos_phase_check;

-- 补充 attendance_records 表可能缺失的列
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'checked_in';
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_accuracy DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_accuracy DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_location_name TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_notes TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_notes TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS location_name TEXT;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_device_at TIMESTAMPTZ;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_device_at TIMESTAMPTZ;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_received_at TIMESTAMPTZ;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_received_at TIMESTAMPTZ;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_lat DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_in_lng DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_lat DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS check_out_lng DOUBLE PRECISION;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS notes TEXT;

-- 补充 photos 表可能缺失的列
ALTER TABLE photos ADD COLUMN IF NOT EXISTS file_path TEXT;
ALTER TABLE photos ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;

-- 开启 UUID 扩展
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 🌟 升级 sites 表（重命名为 Clients 概念）
-- 增加 user_id 关联（用于区分是谁添加的 Client）
ALTER TABLE sites ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
-- 增加 BRN 和 Phone 字段
ALTER TABLE sites ADD COLUMN IF NOT EXISTS brn TEXT;
ALTER TABLE sites ADD COLUMN IF NOT EXISTS phone TEXT;

-- 原有 latitude 和 longitude 字段保留，但代码中将不再使用