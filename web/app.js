const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? new Date(d).toLocaleString() : '—';
const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
let user = null, view = 'overview', records = [], users = [], clients = [], summary = {}, queue = [], syncing = false, selected = null, selectedCheckoutId = null, branding = { appName: 'Field Attendance', logo: '' };
const app = () => document.getElementById('app');
const API_BASE_URL = String(window.__API_BASE_URL__ || '').replace(/\/+$/, '');
const API_CREDENTIALS = API_BASE_URL ? 'include' : 'same-origin';
const apiUrl = u => /^https?:\/\//i.test(u) ? u : `${API_BASE_URL}${u}`;

// 只在原生 App 且域名缺失时大声报警——Web 端静默
if (window.Capacitor?.isNativePlatform?.() && !API_BASE_URL) {
    console.error('[config] 原生 App 必须提供 window.__API_BASE_URL__，检查 config.js 是否在 cap sync 前生成');
    if (document.getElementById('toast')) {
        document.getElementById('toast').textContent = 'App 配置缺失：API 地址未设置';
        document.getElementById('toast').style.display = 'block';
    }
}

function toast(m) { const t = $('#toast'); if (!t) return; t.textContent = m; t.style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.style.display = 'none', 4500) }

async function api(url, opts = {}) {
    let response;
    try {
        response = await fetch(apiUrl(url), {                 // ← fetch 的 url 换成 apiUrl(url)
            credentials: API_CREDENTIALS,                     // ← 'same-origin' 换成变量
            ...opts,                                          // ← 注意顺序：opts 在后，不能覆盖上面的 credentials（除非显式传）
            headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers }
        });
    } catch { throw new Error('Server unavailable. Your saved offline records remain on this device.'); }
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;

    if (response.status === 401) {
        user = null; localStorage.removeItem('fa_user');
        if (view !== 'login' && view !== 'signup' && view !== 'forgot' && view !== 'reset') renderAuth();
    }

    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body;
}
const post = (url, body, method = 'POST') => api(url, { method, body: JSON.stringify(body) });

const openDb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('field-attendance-local-v2', 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'key' }); if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
});
async function dbOp(store, mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode); const req = action(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); tx.oncomplete = () => db.close();
    });
}
const put = (store, item) => dbOp(store, 'readwrite', s => s.put(item));
const get = (store, id) => dbOp(store, 'readonly', s => s.get(id));
const all = store => dbOp(store, 'readonly', s => s.getAll());
const del = (store, id) => dbOp(store, 'readwrite', s => s.delete(id));

async function loadQueue() { queue = (await all('queue')).filter(x => x.owner === user?.id).sort((a, b) => a.created - b.created); return queue; }

function brandMarkup() { return `${branding.logo ? `<img class="brand-logo" src="${branding.logo}" alt="" />` : '<i>✓</i>'} <span>${esc(branding.appName || 'Field Attendance')}</span>`; }
function navItem(k, label) { return `<button class="nav ${view === k ? 'active' : ''}" data-view="${k}">${label}</button>` }

function layout(body) {
    app().innerHTML = `
    <div class="shell">
        <!-- 移动端汉堡菜单按钮 -->
        <button id="mobile-menu-btn" style="display: none; position: fixed; top: 12px; left: 12px; z-index: 1001; padding: 6px 10px; background: #fff; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.1); color: #14243b; font-weight: bold;">☰ Menu</button>
        
        <!-- 侧边栏（加上 id 以便 JS 控制） -->
        <aside class="sidebar" id="main-sidebar">
            <div class="brand">${brandMarkup()}</div>
            ${navItem('overview', '▦ Overview')}
            ${navItem('records', '◷ Attendance Records')}
            ${user.role === 'admin' ? navItem('users', '♙ User Management') + navItem('clients', '🏢 Clients') + navItem('audit', '☷ Audit Logs') + navItem('backup', '▣ Backup') : navItem('checkin', '⊕ Check In') + navItem('checkout', '⇥ Check Out') + navItem('clients', '🏢 Clients') + navItem('sync', '⇅ Offline Sync')}
            ${navItem('settings', '⚙ Settings')}
            <button class="nav" id="logout">↪ Sign Out</button>
        </aside>
        
        <!-- 主体内容 -->
        <main class="main">
            <div class="top">
                <div>
                    <h1>${({ overview: 'Dashboard', records: 'Attendance Records', users: 'User Management', clients: 'Client Management', audit: 'Audit Logs', backup: 'Backup', check: 'Check In / Out', checkin: 'Check In', checkout: 'Check Out', sync: 'Offline Sync', settings: 'Settings' })[view]}</h1>
                    <div class="muted tiny">${esc(user.full_name)} · ${esc(user.role)} · <span class="${navigator.onLine ? '' : 'offline'}">${navigator.onLine ? 'Online' : 'Offline'}</span></div>
                </div>
                <button class="btn alt" id="refresh">↻ Refresh</button>
            </div>
            ${body}
        </main>
    </div>`;

    const sidebar = $('#main-sidebar');
    const menuBtn = $('#mobile-menu-btn');

    // 🌟 1. 检测屏幕宽度，控制汉堡按钮和侧边栏的显示
    const checkMobile = () => {
        if (window.innerWidth <= 768) {
            menuBtn.style.display = 'block'; // 手机端显示菜单按钮
            if (!sidebar.classList.contains('open')) {
                sidebar.style.display = 'none'; // 默认隐藏侧边栏
            }
        } else {
            menuBtn.style.display = 'none'; // 电脑端隐藏菜单按钮
            sidebar.style.display = '';     // 电脑端恢复侧边栏（走原本的 CSS 样式）
            sidebar.classList.remove('open');
        }
    };
    checkMobile();
    window.onresize = checkMobile;

    // 🌟 2. 点击 Menu 按钮，打开/关闭侧边栏
    menuBtn.onclick = () => {
        if (sidebar.style.display === 'none') {
            sidebar.style.display = 'flex'; // 显示
            sidebar.style.flexDirection = 'column';
            sidebar.style.position = 'fixed';
            sidebar.style.top = '0'; left = '0';
            sidebar.style.left = '0';
            sidebar.style.height = '100vh';
            sidebar.style.width = '250px';
            sidebar.style.zIndex = '999';
            sidebar.style.backgroundColor = '#14243b';
            sidebar.style.overflowY = 'auto';
            sidebar.classList.add('open');
        } else {
            sidebar.style.display = 'none'; // 隐藏
            sidebar.classList.remove('open');
        }
    };

    // 🌟 3. 点击菜单里的任意功能后，自动关闭侧边栏
    document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
        view = b.dataset.view;
        if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
            menuBtn.click(); // 触发一次关闭
        }
        render()
    });

    $('#logout').onclick = async () => {
        try { await api('/api/logout', { method: 'POST' }) } catch { }
        user = null; localStorage.removeItem('fa_user'); renderAuth()
    };
    $('#refresh').onclick = refresh;
}

function pill(v) { return `<span class="pill ${v === 'Synced' || v === 'completed' ? 'ok' : v === 'Failed' ? 'bad' : 'wait'}">${esc(v)}</span>` }
function rowRecord(r) { return `<tr><td>${user.role === 'admin' ? `<button class="btn alt" data-record="${esc(r.id)}">View</button>` : `<div class="row-actions"><button class="btn alt" data-record="${esc(r.id)}">View</button>${r.status === 'checked_in' ? `<button class="btn" data-checkout="${esc(r.id)}">Check Out</button>` : ''}</div>`}</td><td>${esc(r.full_name || user.full_name)}</td><td>${esc(r.location_name || r.site_name)}</td><td>${fmt(r.check_in_device_at)}</td><td>${esc(r.check_out_location_name || '—')}</td><td>${fmt(r.check_out_device_at)}</td><td>${pill(r.status)}</td><td>${r.photo_count ?? 0}</td></tr>`; }
const recordTable = arr => `<div class="tablewrap"><table><thead><tr><th>Action</th><th>Worker</th><th>Site / Check-in Location</th><th>Check-in Time</th><th>Check-out Location</th><th>Check-out Time</th><th>Status</th><th>Photos</th></tr></thead><tbody>${arr.length ? arr.map(rowRecord).join('') : '<tr><td colspan="8" class="empty">No records yet</td></tr>'}</tbody></table></div>`;

function bindRecords() {
    document.querySelectorAll('[data-record]').forEach(b => b.onclick = () => showRecord(b.dataset.record));
    document.querySelectorAll('[data-checkout]').forEach(b => b.onclick = () => { selectedCheckoutId = b.dataset.checkout; view = 'checkout'; render() });
    document.querySelectorAll('[data-go="checkin"]').forEach(b => b.onclick = () => { view = 'checkin'; render() });
    document.querySelectorAll('[data-go="checkout"]').forEach(b => b.onclick = () => { selectedCheckoutId = null; view = 'checkout'; render() });
}

function render() {
    if (!user) return renderAuth();

    if (view === 'overview') {
        layout(`${user.role === 'admin' ? '' : `<div class="dashboard-actions"><button class="btn" data-go="checkin">Check In</button><button class="btn alt" data-go="checkout">Check Out</button></div>`}<div class="grid"><div class="card"><div class="muted">${user.role === 'admin' ? 'Total Users' : 'My Records'}</div><div class="num">${user.role === 'admin' ? summary.users ?? '—' : records.length}</div></div><div class="card"><div class="muted">Total Records</div><div class="num">${user.role === 'admin' ? summary.records ?? '—' : records.length}</div></div><div class="card"><div class="muted">Checked In</div><div class="num">${user.role === 'admin' ? summary.checkedIn ?? '—' : records.filter(r => r.status === 'checked_in').length}</div></div><div class="card"><div class="muted">${user.role === 'admin' ? 'Uploaded Photos' : 'Pending Sync'}</div><div class="num">${user.role === 'admin' ? summary.photos ?? '—' : queue.length}</div></div></div><section class="panel"><div class="flex between"><h2>Recent Attendance</h2>${user.role === 'admin' ? '<a href="/api/admin/export.csv">Export CSV</a>' : ''}</div>${recordTable(records.slice(0, 10))}</section>`);
        bindRecords();
    } else if (view === 'records') {
        layout(`<section class="panel"><div class="flex between"><h2>Attendance History</h2>${user.role === 'admin' ? '<a href="/api/admin/export.csv">Download CSV</a>' : ''}</div><input class="search" id="search" placeholder="Search by worker, site, status, email"><div id="table">${recordTable(records)}</div></section>`);
        bindRecords();
        $('#search').oninput = e => {
            const q = e.target.value.toLowerCase();
            $('#table').innerHTML = recordTable(records.filter(r => [r.full_name, r.email, r.location_name, r.check_out_location_name, r.site_name, r.status].some(x => String(x || '').toLowerCase().includes(q))));
            bindRecords();
        };
    } else if (view === 'users') {
        layout(`<section class="panel"><h2>Users (${users.length})</h2><div class="tablewrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Active</th><th>Action</th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${pill(u.active ? 'Active' : 'Disabled')}</td><td><button class="btn alt" data-user="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div></section>`);
        document.querySelectorAll('[data-user]').forEach(b => b.onclick = () => editUser(b.dataset.user));
    } else if (view === 'clients') {
        const isAdmin = user.role === 'admin';
        layout(`<section class="panel"><h2>Add Client</h2><form id="client-form"><div class="form-grid">
            <div class="field"><label>Client Name *</label><input name="name" required maxlength="120"></div>
            <div class="field"><label>Business Registration Number</label><input name="brn" maxlength="100"></div>
            <div class="field"><label>Phone Number</label><input name="phone" maxlength="50"></div>
            <div class="field"><label>Address</label><input name="address"></div>
        </div><button class="btn">Save Client</button></form></section>
        <section class="panel"><h2>Registered Clients (${clients.length})</h2>
            <div class="tablewrap"><table><thead><tr>
                <th>Client Name</th><th>BRN</th><th>Phone</th><th>Address</th>
                ${isAdmin ? '<th>Added By</th>' : ''}
                <th>Action</th>
            </tr></thead><tbody>
            ${clients.map(c => `<tr>
                <td>${esc(c.name)}</td>
                <td>${esc(c.brn || '—')}</td>
                <td>${esc(c.phone || '—')}</td>
                <td>${esc(c.address || '—')}</td>
                ${isAdmin ? `<td>${esc(c.created_by_name || 'Unknown')}</td>` : ''}
                <td><button class="btn alt" data-edit-client="${c.id}">Edit</button> <button class="btn danger" data-del-client="${c.id}">Delete</button></td>
            </tr>`).join('') || `<tr><td colspan="${isAdmin ? 6 : 5}" class="empty">No clients yet</td></tr>`}
            </tbody></table></div>
        </section>`);

        $('#client-form').onsubmit = async e => {
            e.preventDefault();
            try { await post('/api/clients', Object.fromEntries(new FormData(e.target))); toast('Client created'); await refresh(); } catch (err) { toast(err.message) }
        };

        document.querySelectorAll('[data-edit-client]').forEach(b => b.onclick = () => editClient(b.dataset.editClient));
        document.querySelectorAll('[data-del-client]').forEach(b => b.onclick = async () => {
            if (!window.confirm('Delete this client? Existing attendance records will remain but lose the client link.')) return;
            try { await api('/api/clients/' + b.dataset.delClient, { method: 'DELETE' }); toast('Client deleted'); await refresh(); } catch (err) { toast(err.message) }
        });

    } else if (view === 'audit') {
        layout('<section class="panel"><h2>Recent Administrative Activity</h2><div id="auditlog" class="muted">Loading...</div></section>');
        api('/api/admin/audit').then(d => {
            $('#auditlog').innerHTML = d.logs.map(x => `<div class="status">${fmt(x.created_at)} — ${esc(x.action)} — ${esc(x.resource_type || '')}</div>`).join('') || 'No audit events';
        }).catch(e => toast(e.message));
    } else if (view === 'backup' && user.role === 'admin') {
        renderBackup();
    } else if (view === 'check' || view === 'checkin') {
        renderCheck('checkin');
    } else if (view === 'checkout') {
        renderCheck('checkout');
    } else if (view === 'sync') {
        renderSync();
    } else if (view === 'settings') {
        renderSettings();
    }
}

async function showRecord(id) {
    const r = records.find(x => x.id === id);
    if (!r) return toast('Record not found');

    const gpsIn = r.check_in_lat ? `${r.check_in_lat.toFixed(5)}, ${r.check_in_lng.toFixed(5)}` : 'N/A';
    const gpsOut = r.check_out_lat ? `${r.check_out_lat.toFixed(5)}, ${r.check_out_lng.toFixed(5)}` : 'N/A';

    // 创建弹窗
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal" style="max-height: 90vh; overflow-y: auto; padding: 20px;">
        
        <!-- 头部 Letterhead (只显示 Attendance Record) -->
        <div style="text-align: center; border-bottom: 2px solid #14243b; padding-bottom: 15px; margin-bottom: 20px;">
            <h1 style="color: #14243b; margin: 0; font-size: 24px;">Attendance Record</h1>
        </div>

        <!-- 基本信息 -->
        <div style="font-size: 14px; line-height: 1.6; margin-bottom: 20px; background: #f8fafc; padding: 15px; border-radius: 8px;">
            <div><strong>Worker:</strong> ${esc(r.full_name || user.full_name)} (${esc(r.email || '')})</div>
            <div><strong>Site / Location:</strong> ${esc(r.location_name || r.site_name || 'N/A')}</div>
            <div><strong>Status:</strong> ${pill(r.status)}</div>
            ${r.notes ? `<div><strong>Notes:</strong> ${esc(r.notes)}</div>` : ''}
        </div>

        <!-- Check In Section -->
        <div style="margin-bottom: 25px;">
            <h3 style="color: #14243b; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-bottom: 10px;">Check In Information</h3>
            <div style="font-size: 13px; margin-bottom: 10px;">
                <strong>Time:</strong> ${fmt(r.check_in_device_at)} &nbsp;|&nbsp; <strong>GPS:</strong> ${gpsIn}
            </div>
            <div id="photos-in" style="display: flex; flex-wrap: wrap; gap: 10px;">
                <div class="muted tiny">Loading photos...</div>
            </div>
        </div>

        <!-- Check Out Section -->
        ${r.check_out_device_at ? `
        <div style="margin-bottom: 25px;">
            <h3 style="color: #14243b; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-bottom: 10px;">Check Out Information</h3>
            <div style="font-size: 13px; margin-bottom: 10px;">
                <strong>Time:</strong> ${fmt(r.check_out_device_at)} &nbsp;|&nbsp; <strong>GPS:</strong> ${gpsOut}
            </div>
            <div id="photos-out" style="display: flex; flex-wrap: wrap; gap: 10px;">
                <div class="muted tiny">Loading photos...</div>
            </div>
        </div>` : ''}

        <!-- 底部操作按钮 -->
        <div class="flex between" style="border-top: 1px solid #ddd; padding-top: 15px; margin-top: 10px;">
            <button class="btn alt" id="close-record">Close</button>
            <button class="btn" id="download-pdf" style="background: #2563eb;">⬇ Download PDF</button>
        </div>
    </div>`;

    document.body.append(bg);

    // 关闭事件
    bg.querySelector('#close-record').onclick = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) bg.remove() };

    // 下载 PDF 事件
    bg.querySelector('#download-pdf').onclick = async (e) => {
        const btn = e.target;
        btn.textContent = 'Generating...';
        btn.disabled = true;
        try {
            const response = await fetch(apiUrl('/api/records/download-pdf'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: API_CREDENTIALS,
                body: JSON.stringify({ recordId: r.id })
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to generate PDF');
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Attendance-${r.full_name || 'Record'}-${Date.now()}.pdf`;
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 30000);
            toast('PDF downloaded successfully');
        } catch (err) {
            toast(err.message);
        } finally {
            btn.textContent = '⬇ Download PDF';
            btn.disabled = false;
        }
    };

    // 拉取照片并渲染
    try {
        const { photos } = await api(`/api/records/${id}/photos`);
        const containerIn = bg.querySelector('#photos-in');
        const containerOut = bg.querySelector('#photos-out');

        if (!photos || !photos.length) {
            containerIn.innerHTML = '<div class="muted tiny">No photos uploaded.</div>';
            if (containerOut) containerOut.innerHTML = '<div class="muted tiny">No photos uploaded.</div>';
            return;
        }

        // 按 phase 分组
        const groups = { location: [], before: [], checkout_location: [], after: [] };
        photos.forEach(p => { if (groups[p.phase]) groups[p.phase].push(p); });

        // 并行获取所有图片的签名 URL
        const fetchUrls = photos.map(p => post('/api/get-download-url', { fileKey: p.url }).then(res => ({ ...p, downloadUrl: res.downloadUrl })));
        const photosWithUrls = await Promise.all(fetchUrls);

        const renderGroup = (container, phaseKey, label) => {
            if (!container) return;
            const list = photosWithUrls.filter(p => p.phase === phaseKey);
            if (!list.length) return;

            // 清空 loading
            if (container.innerHTML.includes('Loading') || container.innerHTML.includes('No photos')) container.innerHTML = '';

            // 添加小标题
            const title = document.createElement('div');
            title.style.width = '100%'; title.style.fontSize = '12px'; title.style.fontWeight = 'bold'; title.style.marginBottom = '5px';
            title.textContent = label;
            container.appendChild(title);

            list.forEach(p => {
                const img = document.createElement('img');
                img.src = p.downloadUrl;
                img.style.width = '90px';
                img.style.height = '90px';
                img.style.objectFit = 'cover';
                img.style.borderRadius = '4px';
                img.style.border = '1px solid #ccc';
                img.style.cursor = 'pointer';
                img.onclick = () => window.open(p.downloadUrl, '_blank');
                container.appendChild(img);
            });
        };

        // 分别渲染 Check-in 的图片
        renderGroup(containerIn, 'location', 'Location Photo');
        renderGroup(containerIn, 'before', 'Before Photos');

        // 分别渲染 Check-out 的图片
        if (containerOut) {
            renderGroup(containerOut, 'checkout_location', 'Checkout Location');
            renderGroup(containerOut, 'after', 'After Photos');
        }

    } catch (e) {
        bg.querySelector('#photos-in').innerHTML = '<div class="offline tiny">Failed to load photos.</div>';
        if (bg.querySelector('#photos-out')) bg.querySelector('#photos-out').innerHTML = '<div class="offline tiny">Failed to load photos.</div>';
    }
}

function editClient(id) {
    const c = clients.find(x => x.id === id); if (!c) return;
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal"><h2>Edit Client</h2><form id="edit-client-form">
        <div class="field"><label>Client Name *</label><input name="name" value="${esc(c.name)}" required maxlength="120"></div>
        <div class="field"><label>BRN</label><input name="brn" value="${esc(c.brn || '')}" maxlength="100"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${esc(c.phone || '')}" maxlength="50"></div>
        <div class="field"><label>Address</label><input name="address" value="${esc(c.address || '')}"></div>
        <div class="actions"><button class="btn">Save Changes</button><button type="button" class="btn alt" id="cancel">Cancel</button></div>
    </form></div>`;
    document.body.append(bg);
    bg.querySelector('#cancel').onclick = () => bg.remove();
    bg.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        try {
            await post('/api/clients/' + id, Object.fromEntries(new FormData(e.target)), 'PATCH');
            bg.remove(); toast('Client updated'); await refresh();
        } catch (err) { toast(err.message) }
    };
}

function renderCheck(mode = 'checkin') {
    const pending = queue.filter(x => x.type === 'record');
    const byId = new Map(records.map(r => [r.id, { ...r }]));
    for (const t of pending) {
        const p = t.payload;
        if (p.action === 'check_in') {
            const old = byId.get(p.id) || {};
            byId.set(p.id, { ...old, id: p.id, location_name: p.location_name, status: 'checked_in', check_in_device_at: p.device_at, localPending: true });
        } else if (p.action === 'check_out' && byId.has(p.id)) {
            const old = byId.get(p.id);
            byId.set(p.id, { ...old, status: 'completed', check_out_device_at: p.device_at, localPending: true });
        }
    }
    const list = [...byId.values()];
    const active = list.filter(x => x.status === 'checked_in');
    const clientOptions = clients.map(c => `<option value="${esc(c.name)}">`).join('');

    if (mode === 'checkin') {
        const canCheckIn = active.length === 0;
        layout(`<section class="panel"><div class="flex between"><h2>Check In Form</h2>${canCheckIn ? '<span class="pill ok">Ready to check in</span>' : '<span class="pill wait">Checkout required first</span>'}</div>${canCheckIn ? `
        <form id="checkin">
            <div class="field"><label>Check-in Time</label><input class="time-readonly" value="${esc(new Date().toLocaleString())}" readonly></div>
            <div class="field">
                <label>Client Name / Location *</label>
                <input name="location_name" id="input-loc-name" list="clients-list" required maxlength="200" placeholder="Select or type client name">
                <datalist id="clients-list">${clientOptions}</datalist>
            </div>
            <div class="field"><label>Get GPS Location *</label><div class="flex"><button class="btn alt" type="button" id="gps-in">Get GPS Location</button><span class="muted tiny" id="gps-in-status">Not captured</span></div></div>
            <div class="field"><label>Location Photo *</label><button class="btn alt" type="button" id="camera-in">Take Location Photo</button><span class="muted tiny" id="camera-in-status"></span><div id="loc-preview" style="display:flex; gap:10px; margin-top:10px;"></div></div>
            <div class="field"><label>Before Photo(s) *</label><button class="btn alt" type="button" id="camera-in-more">Add Before Photo(s)</button><span class="muted tiny" id="camera-in-more-status">Photos are saved together</span><div id="before-preview" style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;"></div></div>
            <div class="field"><label>Condition Notes (optional)</label><textarea name="notes" id="input-notes" rows="2" placeholder=""></textarea></div>
            <button class="btn good" type="submit">Submit Check In</button>
        </form>` : `<p class="notice">You are currently checked in. Please complete Check Out before checking in at another point.</p><button class="btn" id="go-checkout">Go to Check Out Form</button>`}</section>`);

        const draftKey = `draft_checkin_${user.id}`;
        let gpsIn = null, locationPhoto = null, beforePhotos = [];

        // 恢复草稿
        const savedDraft = JSON.parse(sessionStorage.getItem(draftKey) || '{}');
        if (savedDraft.location_name) $('#input-loc-name').value = savedDraft.location_name;
        if (savedDraft.notes) $('#input-notes').value = savedDraft.notes;
        if (savedDraft.gpsIn) { gpsIn = savedDraft.gpsIn; $('#gps-in-status').textContent = `${gpsIn.latitude.toFixed(5)}, ${gpsIn.longitude.toFixed(5)} ±${Math.round(gpsIn.accuracy)}m`; }

        $('#input-loc-name')?.addEventListener('input', (e) => { savedDraft.location_name = e.target.value; sessionStorage.setItem(draftKey, JSON.stringify(savedDraft)); });
        $('#input-notes')?.addEventListener('input', (e) => { savedDraft.notes = e.target.value; sessionStorage.setItem(draftKey, JSON.stringify(savedDraft)); });

        const gpsText = g => `${g.latitude.toFixed(5)}, ${g.longitude.toFixed(5)} ±${Math.round(g.accuracy)}m`;
        $('#gps-in')?.addEventListener('click', () => getGps(g => { gpsIn = g; $('#gps-in-status').textContent = gpsText(g); savedDraft.gpsIn = g; sessionStorage.setItem(draftKey, JSON.stringify(savedDraft)); }));

        $('#camera-in')?.addEventListener('click', () => openCamera(files => {
            locationPhoto = files[0];
            $('#camera-in-status').textContent = `1 location photo captured`;
            $('#loc-preview').innerHTML = `<img src="${URL.createObjectURL(locationPhoto)}" style="height:80px;border-radius:4px;object-fit:cover;">`;
        }));

        $('#camera-in-more')?.addEventListener('click', () => openCamera(files => {
            beforePhotos = beforePhotos.concat(files);
            $('#camera-in-more-status').textContent = `${beforePhotos.length} before photo(s) captured`;
            files.forEach(file => {
                const img = document.createElement('img');
                img.src = URL.createObjectURL(file); img.style.height = '80px'; img.style.borderRadius = '4px'; img.style.objectFit = 'cover';
                $('#before-preview').appendChild(img);
            });
        }));

        $('#go-checkout')?.addEventListener('click', () => { selectedCheckoutId = null; view = 'checkout'; render() });
        $('#checkin')?.addEventListener('submit', async e => {
            e.preventDefault();
            const f = e.target;
            if (!gpsIn) return toast('Please get GPS Location before submitting.');
            if (!locationPhoto) return toast('Please take a Location Photo.');
            if (!beforePhotos.length) return toast('Please take at least one Before Photo.');

            const allPhotos = [{ file: locationPhoto, phase: 'location' }, ...beforePhotos.map(file => ({ file, phase: 'before' }))];
            sessionStorage.removeItem(draftKey);
            await saveAction('check_in', uid(), { location_name: f.location_name.value.trim(), notes: f.notes.value }, gpsIn, allPhotos);
        });
    } else {
        let chosen = active.find(x => x.id === selectedCheckoutId) || null;
        layout(`<section class="panel"><div class="flex between"><h2>Check Out Form</h2><span class="pill ${active.length ? 'wait' : 'ok'}">${active.length ? 'Check-in active' : 'No active check-in'}</span></div>${active.length ? `<div class="field"><label>Check Out Location *</label><select id="checkout-record"><option value="">Select the location to check out</option>${active.map(x => `<option value="${esc(x.id)}" ${chosen?.id === x.id ? 'selected' : ''}>${esc(x.location_name || x.site_name || 'Unnamed location')} — ${fmt(x.check_in_device_at)}</option>`).join('')}</select></div><div id="checkout-form-area">${chosen ? checkoutFormMarkup(chosen, clientOptions) : '<p class="notice">Select an active check-in above to open its Check Out form.</p>'}</div>` : '<p class="notice">There are no active check-ins to check out.</p><button class="btn" id="go-checkin">Go to Check In Form</button>'}</section>`);

        const bindOutForm = (r) => {
            const form = $('#checkout'); if (!form) return;
            const draftKey = `draft_checkout_${user.id}_${r.id}`;
            let gpsOut = null, checkoutLocPhoto = null, afterPhotos = [];

            // 恢复草稿
            const savedDraft = JSON.parse(sessionStorage.getItem(draftKey) || '{}');
            if (savedDraft.location_name) $('#input-out-loc-name').value = savedDraft.location_name;
            if (savedDraft.notes) $('#input-out-notes').value = savedDraft.notes;
            if (savedDraft.gpsOut) { gpsOut = savedDraft.gpsOut; $('#gps-out-status').textContent = `${gpsOut.latitude.toFixed(5)}, ${gpsOut.longitude.toFixed(5)} ±${Math.round(gpsOut.accuracy)}m`; }

            $('#input-out-loc-name')?.addEventListener('input', (e) => { savedDraft.location_name = e.target.value; sessionStorage.setItem(draftKey, JSON.stringify(savedDraft)); });
            $('#input-out-notes')?.addEventListener('input', (e) => { savedDraft.notes = e.target.value; sessionStorage.setItem(draftKey, JSON.stringify(savedDraft)); });

            const gpsText = g => `${g.latitude.toFixed(5)}, ${g.longitude.toFixed(5)} ±${Math.round(g.accuracy)}m`;
            $('#gps-out').onclick = () => getGps(g => { gpsOut = g; $('#gps-out-status').textContent = gpsText(g); savedDraft.gpsOut = g; sessionStorage.setItem(draftKey, JSON.stringify(savedDraft)); });

            $('#camera-out').onclick = () => openCamera(files => {
                checkoutLocPhoto = files[0]; $('#camera-out-status').textContent = `1 checkout location photo captured`;
                $('#out-loc-preview').innerHTML = `<img src="${URL.createObjectURL(checkoutLocPhoto)}" style="height:80px;border-radius:4px;object-fit:cover;">`;
            });

            $('#camera-out-more').onclick = () => openCamera(files => {
                afterPhotos = afterPhotos.concat(files); $('#camera-out-status').textContent = `${afterPhotos.length} after photo(s) captured`;
                files.forEach(file => {
                    const img = document.createElement('img');
                    img.src = URL.createObjectURL(file); img.style.height = '80px'; img.style.borderRadius = '4px'; img.style.objectFit = 'cover';
                    $('#after-preview').appendChild(img);
                });
            });

            form.onsubmit = async e => {
                e.preventDefault();
                const f = e.target;
                if (!gpsOut) return toast('Please get GPS Location before submitting.');
                if (!checkoutLocPhoto) return toast('Please take a Checkout Location Photo.');
                if (!afterPhotos.length) return toast('Please take at least one After Photo.');

                const allPhotos = [{ file: checkoutLocPhoto, phase: 'checkout_location' }, ...afterPhotos.map(file => ({ file, phase: 'after' }))];
                sessionStorage.removeItem(draftKey);
                await saveAction('check_out', r.id, { location_name: f.checkout_location.value.trim(), notes: f.notes.value }, gpsOut, allPhotos);
            };
        };
        $('#checkout-record')?.addEventListener('change', e => {
            const r = active.find(x => x.id === e.target.value);
            $('#checkout-form-area').innerHTML = r ? checkoutFormMarkup(r, clientOptions) : '<p class="notice">Select an active check-in above to open its Check Out form.</p>';
            if (r) bindOutForm(r);
        });
        if (chosen) bindOutForm(chosen);
        $('#go-checkin')?.addEventListener('click', () => { view = 'checkin'; render() });
    }
}

function checkoutFormMarkup(r, clientOptions) {
    return `<div class="status"><strong>${esc(r.location_name || r.site_name || 'Unnamed location')}</strong><div class="tiny muted">Checked in at ${fmt(r.check_in_device_at)}</div></div>
    <form id="checkout">
        <div class="field"><label>Check-out Time</label><input class="time-readonly" value="${esc(new Date().toLocaleString())}" readonly></div>
        <div class="field">
            <label>Client Name / Location *</label>
            <input name="checkout_location" id="input-out-loc-name" list="clients-list-out" required maxlength="200" value="${esc(r.location_name || r.site_name || '')}" placeholder="Confirm customer or site name">
            <datalist id="clients-list-out">${clientOptions}</datalist>
        </div>
        <div class="field"><label>Get GPS Location *</label><div class="flex"><button class="btn alt" type="button" id="gps-out">Get GPS Location</button><span class="muted tiny" id="gps-out-status">Not captured</span></div></div>
        <div class="field"><label>Checkout Location Photo *</label><button class="btn alt" type="button" id="camera-out">Take Checkout Location Photo</button><div id="out-loc-preview" style="display:flex; gap:10px; margin-top:10px;"></div></div>
        <div class="field"><label>After Photo(s) *</label><div class="flex"><button class="btn alt" type="button" id="camera-out-more">Take After Photo(s)</button></div><span class="muted tiny" id="camera-out-status">No photos captured</span><div id="after-preview" style="display:flex; gap:10px; margin-top:10px; flex-wrap:wrap;"></div></div>
        <div class="field"><label>After Note (optional)</label><textarea name="notes" id="input-out-notes" rows="2" placeholder=""></textarea></div>
        <button class="btn good" type="submit">Submit Check Out</button>
    </form>`;
}

async function openCamera(onDone) {
    // 🌟 1. 如果是原生 App 环境，强制调起相机
    if (window.Capacitor?.Plugins?.Camera) {
        try {
            const image = await window.Capacitor.Plugins.Camera.getPhoto({
                quality: 80,
                allowEditing: false,
                resultType: 'base64',
                source: 'CAMERA',          // 👈 核心：强制只打开相机
                saveToGallery: false,      // 👈 核心：拍完照不保存到手机相册（防止篡改）
                // 下面这两个可以删掉，因为 source 是 CAMERA，不会有相册选项
                // promptLabelHeader: '拍照',
                // promptLabelPicture: '拍照',
                // promptLabelPhoto: '从相册选' 
            });

            if (image && image.base64String) {
                const res = await fetch(`data:image/${image.format};base64,${image.base64String}`);
                const blob = await res.blob();
                const file = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
                onDone([file]);
            }
        } catch (e) {
            toast('拍照已取消或失败');
        }
        return;
    }

    // （以下网页版代码保持不变，用于电脑端测试）
    if (!navigator.mediaDevices?.getUserMedia) { toast('Live camera requires a supported browser and HTTPS connection.'); return; }
    let stream, files = [];
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal"><div class="flex between"><h2>Take Photo</h2><button class="btn alt" id="camera-close">Cancel</button></div><video id="camera-video" autoplay playsinline style="width:100%;max-height:55vh;background:#111;border-radius:12px"></video><canvas id="camera-canvas" style="display:none"></canvas><p class="muted" id="camera-count">0 photos captured</p><div class="flex"><button class="btn" id="camera-shot">Capture Photo</button><button class="btn good" id="camera-done">Use Photos</button></div></div>`;
    document.body.append(bg);
    const close = () => { try { stream?.getTracks().forEach(t => t.stop()) } catch { } bg.remove() };
    bg.querySelector('#camera-close').onclick = close; bg.onclick = e => { if (e.target === bg) close() };
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        bg.querySelector('#camera-video').srcObject = stream;
    } catch (e) { close(); toast('Cannot open camera. Please allow camera permission and use HTTPS.'); return; }
    bg.querySelector('#camera-shot').onclick = async () => {
        const v = bg.querySelector('#camera-video'), c = bg.querySelector('#camera-canvas');
        if (!v.videoWidth) return toast('Camera is not ready yet.');
        const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
        c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', .85));
        if (blob) { files.push(new File([blob], `camera-${Date.now()}-${files.length + 1}.jpg`, { type: 'image/jpeg' })); bg.querySelector('#camera-count').textContent = `${files.length} photo(s) captured`; }
    };
    bg.querySelector('#camera-done').onclick = () => { if (!files.length) { toast('Please capture at least one photo.'); return; } close(); onDone(files); };
}

function getGps(done) {
    // 🌟 如果是原生 App 环境，使用 Capacitor 插件
    if (window.Capacitor?.Plugins?.Geolocation) {
        window.Capacitor.Plugins.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 })
            .then(p => {
                done({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy });
            })
            .catch(e => toast('GPS Error: ' + (e.message || 'Permission denied')));
    } else {
        // 否则（网页版），退回使用浏览器原生的 GPS
        if (!navigator.geolocation) return toast('GPS not supported in this browser');
        navigator.geolocation.getCurrentPosition(
            p => done({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
            e => toast('GPS: ' + e.message),
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    }
}

async function compress(file) {
    if (!file.type.startsWith('image/')) throw Error('Choose image files only');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    let blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .72));
    if (blob.size > 550000) blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .48));
    return blob;
}

async function uploadPhotoToB2(fileBlob) {
    if (!fileBlob) return null;
    if (!navigator.onLine) throw new Error('Offline mode detected during B2 upload activation');
    const { uploadUrl, fileKey } = await api('/api/get-upload-url');
    const b2Response = await fetch(uploadUrl, { method: 'PUT', body: fileBlob, headers: { 'Content-Type': 'image/jpeg' } });
    if (!b2Response.ok) throw new Error('Failed to push photo to Backblaze B2.');
    return fileKey;
}

async function saveAction(action, id, extra, gps, files) {
    try {
        const key = uid();
        const payload = { id, action, device_at: new Date().toISOString(), ...extra, ...gps, photo_urls: [] };
        const task = { key, owner: user.id, type: 'record', payload, status: 'Pending', created: Date.now(), tries: 0 };
        await put('queue', task);
        for (const item of Array.from(files || [])) {
            const file = item.file || item; const phase = item.phase || (action === 'check_in' ? 'before' : 'after');
            const blob = await compress(file); const buffer = await blob.arrayBuffer();
            await put('photos', { id: uid(), owner: user.id, recordId: id, phase: phase, buffer: buffer, type: 'image/jpeg', status: 'Pending', created: Date.now() });
        }
        toast('Saved locally. Synchronization queued.');
        await loadQueue(); view = 'sync'; render(); syncNow();
    } catch (e) { toast('Save failed: ' + e.message); }
}

async function syncNow() {
    if (syncing || !user || !navigator.onLine) return;
    syncing = true;
    try {
        const tasks = (await all('queue')).filter(x => x.owner === user.id).sort((a, b) => a.created - b.created);
        for (const task of tasks) {
            try {
                const localPhotos = (await all('photos')).filter(p => p.owner === user.id && p.recordId === task.payload.id);
                task.payload.photo_urls = task.payload.photo_urls || [];
                for (const p of localPhotos) {
                    if (p.status === 'Synced') continue;
                    try {
                        const blob = new Blob([p.buffer], { type: p.type || 'image/jpeg' });
                        const cloudKey = await uploadPhotoToB2(blob);
                        if (cloudKey) task.payload.photo_urls.push({ key: cloudKey, phase: p.phase });
                        await del('photos', p.id);
                    } catch (photoErr) {
                        p.status = 'Failed'; p.error = photoErr.message; await put('photos', p); throw photoErr;
                    }
                }
                await post('/api/records/sync', task.payload);
                await del('queue', task.key);
            } catch (e) {
                task.status = 'Failed'; task.error = e.message; task.tries++; await put('queue', task);
                if (/Server unavailable|Please sign in|Session expired/.test(e.message)) break;
            }
        }
        const orphanPhotos = (await all('photos')).filter(p => p.owner === user.id);
        for (const p of orphanPhotos) {
            try {
                const blob = new Blob([p.buffer], { type: p.type || 'image/jpeg' });
                const cloudKey = await uploadPhotoToB2(blob);
                if (cloudKey) { try { await post('/api/photos/orphan-bind', { photoId: p.id, recordId: p.recordId, url: cloudKey }) } catch { } await del('photos', p.id); }
            } catch (e) { p.status = 'Failed'; p.error = e.message; await put('photos', p); }
        }
        await loadQueue();
        if (navigator.onLine) { try { await loadServerData() } catch { } }
        if (['sync', 'overview', 'records', 'checkin', 'checkout'].includes(view)) render();
    } finally { syncing = false; }
}

async function renderSync() {
    const photos = (await all('photos')).filter(x => x.owner === user.id);
    layout(`<section class="panel"><h2>Offline Synchronization</h2><p class="notice">Records and compressed photos are stored on this device until the server confirms receipt. Keep the app installed and do not clear browser data while uploads are pending.</p><div class="flex"><button class="btn" id="syncnow">Submit to Database</button><span class="muted">${queue.length} record actions · ${photos.length} photos pending</span></div><h3>Queued Actions</h3>${queue.map(t => `<div class="status">${pill(t.status)} ${esc(t.payload.action)} · ${esc(t.payload.location_name || t.payload.id)} · ${fmt(t.payload.device_at)} ${t.error ? `<div class="tiny offline">${esc(t.error)}</div>` : ''}</div>`).join('') || '<div class="empty">No pending record actions</div>'}<h3>Queued Photos</h3>${photos.map(p => `<div class="status">${pill(p.status)} ${esc(p.phase)} · ${Math.round((p.buffer ? p.buffer.byteLength : (p.blob ? p.blob.size : 0)) / 1024)} KB ${p.error ? esc(p.error) : ''}</div>`).join('') || '<div class="empty">No pending photos</div>'}</section>`);
    $('#syncnow').onclick = async () => { toast('Attempting synchronization...'); await syncNow(); toast('Synchronization attempt finished. Check pending items.') };
}

async function renderBackup() {
    let info = { schedule: { enabled: false, time: '02:00', keep: 14 }, files: [], users: [] };
    try { info = await api('/api/admin/backup/settings'); } catch (e) { toast(e.message) }
    try { info.users = (await api('/api/admin/users')).users } catch { }
    layout(`<section class="panel"><h2>Scheduled Backup</h2><p class="muted">Automatic backups are saved inside the Docker app storage at <code>storage/backups</code>. They include database table data and uploaded photos.</p><form id="backup-schedule"><div class="field"><label><input type="checkbox" name="enabled" ${info.schedule.enabled ? 'checked' : ''}> Enable automatic backup</label></div><div class="field"><label>Daily backup time (server UTC)</label><input type="time" name="time" value="${esc(info.schedule.time || '02:00')}" required></div><div class="field"><label>Keep latest backups</label><input type="number" name="keep" min="1" max="365" value="${Number(info.schedule.keep) || 14}" required></div><button class="btn">Save Schedule</button><button type="button" class="btn alt" id="backup-now">Create Backup Now</button></form></section>
 <section class="panel"><h2>Manual Backup</h2><p class="muted">Downloads a compressed archive to this device. Includes database data and photos. Store it securely.</p><button class="btn" id="manual-backup">Download Backup (.tar.gz)</button><div id="backup-status" class="muted tiny"></div></section>
 <section class="panel"><h2>Clear Attendance Data</h2><p class="notice">Permanent action. Matching attendance records and their uploaded photos will be deleted. Create and download a backup first. At least one filter is required.</p><form id="clear-data"><div class="field"><label>From date</label><input type="date" name="from"></div><div class="field"><label>To date</label><input type="date" name="to"></div><div class="field"><label>User</label><select name="userId"><option value="">All users (within other selected filters)</option>${info.users.map(u => `<option value="${esc(u.id)}">${esc(u.full_name)} — ${esc(u.email)}</option>`).join('')}</select></div><div class="field"><label>Location contains</label><input name="location" maxlength="120" placeholder="Enter part of a location name"></div><button class="btn danger">Permanently Delete Matching Data</button></form><div id="clear-result" class="muted tiny"></div></section>
 <section class="panel"><h2>Backups Stored in Docker</h2>${info.files?.map(f => `<div class="status flex between"><span>${esc(f.name)} · ${(f.size / 1024 / 1024).toFixed(2)} MB · ${fmt(f.created)}</span><a href="/api/admin/backup/download/${encodeURIComponent(f.name)}">Download</a></div>`).join('') || '<div class="empty">No scheduled backups saved yet.</div>'}</section>`);

    $('#backup-schedule').onsubmit = async e => {
        e.preventDefault();
        const f = e.target;
        try {
            await post('/api/admin/backup/schedule', { enabled: f.enabled.checked, time: f.time.value, keep: Number(f.keep.value) }, 'PATCH');
            toast('Backup schedule saved');
            await renderBackup();
        } catch (err) { toast(err.message) }
    };
    async function download(url, filename) {
        const response = await fetch(apiUrl(url), { credentials: API_CREDENTIALS });
        if (!response.ok) { let msg = 'Backup failed'; try { msg = (await response.json()).error || msg } catch { } throw Error(msg) }
        const blob = await response.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }
    $('#manual-backup').onclick = async () => {
        const b = $('#manual-backup'); b.disabled = true;
        $('#backup-status').textContent = 'Creating archive…';
        try {
            const response = await fetch(apiUrl('/api/admin/backup/manual'), { method: 'POST', credentials: API_CREDENTIALS });
            if (!response.ok) { let m = 'Backup failed'; try { m = (await response.json()).error || m } catch { } throw Error(m) }
            const blob = await response.blob();
            const disp = response.headers.get('content-disposition') || '';
            const filename = disp.match(/filename="?([^";]+)"?/i)?.[1] || 'field-attendance-backup.tar.gz';
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = filename;
            document.body.append(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 30000);
            $('#backup-status').textContent = 'Backup downloaded.';
            await renderBackup();
        } catch (err) {
            $('#backup-status').textContent = err.message;
        } finally {
            b.disabled = false;
        }
    };
    $('#backup-now').onclick = async () => { try { await download('/api/admin/backup/manual', 'field-attendance-backup.tar.gz'); toast('Backup downloaded') } catch (e) { toast(e.message) } };
    $('#clear-data').onsubmit = async e => {
        e.preventDefault();
        const f = e.target;
        const d = Object.fromEntries(new FormData(f));
        if (!d.from && !d.to && !d.userId && !d.location.trim()) return toast('Select at least one filter before deleting.');
        if (d.from && d.to && d.from > d.to) return toast('From date must be on or before To date.');
        const confirmText = `Permanently delete matching attendance records and their photos? This cannot be undone.\n\nDate: ${d.from || 'any'} to ${d.to || 'any'}\nUser: ${f.userId.selectedOptions[0]?.text || 'all'}\nLocation: ${d.location || 'any'}\n\nPlease create a backup first.`;
        if (!window.confirm(confirmText)) return;
        try {
            const result = await post('/api/admin/backup/clear', d);
            $('#clear-result').textContent = `Deleted ${result.deletedRecords} attendance records and ${result.deletedPhotos} photos.`;
            toast('Data cleared');
            await refresh();
            await renderBackup();
        } catch (err) { toast(err.message) }
    };
}

function renderSettings() {
    const brandingPanel = user.role === 'admin' ? `<section class="panel"><h2>App Branding</h2><p class="muted">Change the program name and logo shown in the admin panel and phone app.</p><form id="branding-form"><div class="field"><label>Program Name</label><input name="appName" required maxlength="80" value="${esc(branding.appName)}"></div><div class="field"><label>Logo Image (PNG, JPG or WEBP)</label><input name="logoFile" type="file" accept="image/png,image/jpeg,image/webp"><small class="muted">Leave empty to keep the current logo. Small logo files recommended.</small>${branding.logo ? `<div class="status"><img class="brand-logo" src="${branding.logo}" alt="Current logo"> Current logo <button type="button" class="btn alt" id="clear-logo">Remove logo</button></div>` : ''}</div><button class="btn">Save Branding</button></form></section>` : '';
    layout(`${brandingPanel}<section class="panel"><h2>Account</h2><p>${esc(user.full_name)} · ${esc(user.email)}</p><form id="password"><div class="field"><label>Current Password</label><input name="old_password" type="password" required></div><div class="field"><label>New Password (12+ characters)</label><input name="new_password" type="password" minlength="12" required></div><button class="btn">Change Password</button></form></section><section class="panel"><h2>Device & Privacy</h2><p class="muted">Offline data is kept in this browser's IndexedDB. Do not use private browsing for attendance. Sign in on the same device after reconnecting. Photos and GPS are visible only to the record owner and administrators.</p><p class="muted">Install this PWA from your browser's Add to Home Screen / Install App menu. Automatic sync works while the app is open and may be delayed by mobile OS background restrictions.</p></section>`);
    if (user.role === 'admin') {
        $('#branding-form').onsubmit = async e => {
            e.preventDefault();
            try {
                let logo = branding.logo;
                const file = e.target.logoFile.files[0];
                if (file) {
                    if (file.size > 450000) throw new Error('Logo must be smaller than 450 KB.');
                    logo = await new Promise((resolve, reject) => {
                        const r = new FileReader();
                        r.onload = () => resolve(r.result);
                        r.onerror = () => reject(new Error('Could not read logo file'));
                        r.readAsDataURL(file);
                    });
                }
                const d = await post('/api/admin/settings', { appName: e.target.appName.value.trim(), logo }, 'PATCH');
                branding = { appName: d.appName, logo: d.logo };
                toast('Branding updated');
                render();
            } catch (err) { toast(err.message) }
        };
        $('#clear-logo')?.addEventListener('click', async () => {
            try {
                const d = await post('/api/admin/settings', { appName: branding.appName, logo: '' }, 'PATCH');
                branding = { appName: d.appName, logo: d.logo };
                toast('Logo removed');
                render();
            } catch (err) { toast(err.message) }
        });
    }
    $('#password').onsubmit = async e => {
        e.preventDefault();
        try {
            await post('/api/change-password', Object.fromEntries(new FormData(e.target)));
            toast('Password changed. Please sign in again.');
            user = null;
            localStorage.removeItem('fa_user');
            renderAuth();
        } catch (err) { toast(err.message) }
    };
}

function renderAuth(mode = 'login', token = '') {
    const isSignup = mode === 'signup';
    const isForgot = mode === 'forgot';
    const isReset = mode === 'reset';

    if (isForgot) {
        app().innerHTML = `<div class="auth"><div class="authbox"><div class="brand" style="color:#14243b">${brandMarkup()}</div><h1>Reset Password</h1><p class="muted">Enter your email to receive a reset link.</p><form id="forgotform"><div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div><button class="btn" style="width:100%">Send Reset Link</button></form><p><button class="btn alt" id="back-to-login" style="width:100%">Back to Sign In</button></p><p class="muted tiny">Internet is required to reset your password.</p></div></div>`;
        $('#back-to-login').onclick = () => renderAuth('login');
        $('#forgotform').onsubmit = async e => {
            e.preventDefault();
            try {
                await post('/api/forgot-password', { email: e.target.email.value.trim() });
                toast('If an account exists, a reset link has been sent.');
                renderAuth('login');
            } catch (err) { toast(err.message) }
        };
        return;
    }

    if (isReset) {
        app().innerHTML = `<div class="auth"><div class="authbox"><div class="brand" style="color:#14243b">${brandMarkup()}</div><h1>New Password</h1><p class="muted">Enter your new secure password.</p><form id="resetform"><div class="field"><label>New Password (12+ characters)</label><input name="password" type="password" minlength="12" required autocomplete="new-password"></div><button class="btn" style="width:100%">Update Password</button></form><p><button class="btn alt" id="back-to-login" style="width:100%">Back to Sign In</button></p></div></div>`;
        $('#back-to-login').onclick = () => { window.history.replaceState({}, '', '/'); renderAuth('login'); };
        $('#resetform').onsubmit = async e => {
            e.preventDefault();
            try {
                await post('/api/reset-password', { token, new_password: e.target.password.value });
                toast('Password updated successfully. Please sign in.');
                window.history.replaceState({}, '', '/');
                renderAuth('login');
            } catch (err) { toast(err.message) }
        };
        return;
    }

    app().innerHTML = `<div class="auth"><div class="authbox"><div class="brand" style="color:#14243b">${brandMarkup()}</div><h1>${isSignup ? 'Create Account' : 'Welcome Back'}</h1><p class="muted">${isSignup ? 'Register a field worker account' : 'Sign in to access attendance records'}</p><form id="authform">${isSignup ? '<div class="field"><label>Full Name</label><input name="full_name" required minlength="2"></div>' : ''}<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div><div class="field"><label>Password (12+ characters)</label><input name="password" type="password" required minlength="12" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></div>${!isSignup ? `<div style="text-align: right; margin-bottom: 15px;"><button type="button" class="btn-link" id="forgot-btn" style="background:none; border:none; color:#2563eb; cursor:pointer; font-size:13px; text-decoration:underline;">Forgot Password?</button></div>` : ''}<button class="btn" style="width:100%">${isSignup ? 'Create Account' : 'Sign In'}</button></form><p><button class="btn alt" id="toggle" style="width:100%">${isSignup ? 'Already registered? Sign In' : 'New user? Sign Up'}</button></p><p class="muted tiny">Internet is required for first login. Previously signed-in users can save attendance offline on this device.</p></div></div>`;

    $('#toggle').onclick = () => renderAuth(isSignup ? 'login' : 'signup');
    if (!isSignup) {
        $('#forgot-btn').onclick = () => renderAuth('forgot');
    }

    $('#authform').onsubmit = async e => {
        e.preventDefault();
        try {
            const d = await post(isSignup ? '/api/signup' : '/api/login', Object.fromEntries(new FormData(e.target)));
            user = d.user;
            localStorage.setItem('fa_user', JSON.stringify(user));
            view = 'overview';
            await refresh();
            toast('Signed in');
        } catch (err) { toast(err.message) }
    };
}

async function loadServerData() {
    try {
        const results = await Promise.all([api('/api/records'), api('/api/clients')]);
        records = results[0].records;
        clients = results[1].clients;
    } catch (e) {
        console.warn('Failed to load records/clients', e);
    }

    if (user.role === 'admin') {
        try {
            summary = await api('/api/admin/summary');
        } catch (e) { console.warn('Summary failed', e); }

        try {
            const u = await api('/api/admin/users');
            users = u.users;
        } catch (e) { console.warn('Users failed', e); }
    }
}

async function refresh() {
    if (!user) return;
    try {
        await loadServerData();
        await loadQueue();
        render();
    } catch (e) {
        await loadQueue();
        render();
        toast(e.message);
    }
}

async function start() {
    if (!document.getElementById('app')) { document.addEventListener('DOMContentLoaded', start, { once: true }); return }

    const urlParams = new URLSearchParams(window.location.search);
    const resetToken = urlParams.get('reset_token');
    if (resetToken) {
        return renderAuth('reset', resetToken);
    }

    try {
        for (const t of await all('queue')) {
            if (t.status === 'Failed') { t.status = 'Pending'; delete t.error; await put('queue', t) }
        }
        for (const p of await all('photos')) {
            if (p.status === 'Failed') { p.status = 'Pending'; delete p.error; await put('photos', p) }
        }
    } catch { }
    if ('serviceWorker' in navigator && !window.Capacitor?.isNativePlatform?.()) {
        navigator.serviceWorker.register('/sw.js').catch(() => { });
    }
    try {
        const d = await api('/api/me');
        user = d.user;
        localStorage.setItem('fa_user', JSON.stringify(user));
    } catch {
        try { user = JSON.parse(localStorage.getItem('fa_user') || 'null') } catch { user = null }
    }
    try {
        const res = await api('/api/settings');
        if (res && typeof res === 'object') {
            branding = {
                appName: res.appName || 'Field Attendance',
                logo: res.logo || ''
            };
        }
        document.title = branding.appName;
    } catch { }
    if (user) await refresh(); else renderAuth();
    window.addEventListener('online', () => { toast('Connection restored. Retrying uploads...'); syncNow() });
    window.addEventListener('focus', () => { if (user) syncNow() });
    setInterval(() => { if (user && navigator.onLine) syncNow() }, 60000);
}
start();