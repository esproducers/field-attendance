const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? new Date(d).toLocaleString() : '—';
const uid = () => (self.crypto && crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
let user = null, view = 'overview', records = [], users = [], sites = [], summary = {}, queue = [], syncing = false, selected = null, selectedCheckoutId = null, branding = { appName: 'Field Attendance', logo: '' };
const app = () => document.getElementById('app');

function toast(m) { const t = $('#toast'); if (!t) return; t.textContent = m; t.style.display = 'block'; clearTimeout(toast.timer); toast.timer = setTimeout(() => t.style.display = 'none', 4500) }

async function api(url, opts = {}) {
    let response;
    try {
        response = await fetch(url, {
            credentials: 'same-origin',
            ...opts,
            headers: {
                ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
                ...opts.headers
            }
        });
    } catch {
        throw new Error('Server unavailable. Your saved offline records remain on this device.');
    }
    const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
    return body;
}
const post = (url, body, method = 'POST') => api(url, { method, body: JSON.stringify(body) });

const openDb = () => new Promise((resolve, reject) => {
    const r = indexedDB.open('field-attendance-local-v2', 1);
    r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
});
async function dbOp(store, mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = action(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
    });
}
const put = (store, item) => dbOp(store, 'readwrite', s => s.put(item));
const get = (store, id) => dbOp(store, 'readonly', s => s.get(id));
const all = store => dbOp(store, 'readonly', s => s.getAll());
const del = (store, id) => dbOp(store, 'readwrite', s => s.delete(id));

async function loadQueue() {
    queue = (await all('queue')).filter(x => x.owner === user?.id).sort((a, b) => a.created - b.created);
    return queue;
}

function brandMarkup() {
    return `${branding.logo ? `<img class="brand-logo" src="${branding.logo}" alt="" />` : '<i>✓</i>'} <span>${esc(branding.appName || 'Field Attendance')}</span>`;
}
function navItem(k, label) { return `<button class="nav ${view === k ? 'active' : ''}" data-view="${k}">${label}</button>` }

function layout(body) {
    app().innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand">${brandMarkup()}</div>${navItem('overview', '▦ Overview')}${navItem('records', '◷ Attendance Records')}${user.role === 'admin' ? navItem('users', '♙ User Management') + navItem('sites', '⌖ Sites') + navItem('audit', '☷ Audit Logs') + navItem('backup', '▣ Backup') : navItem('checkin', '⊕ Check In') + navItem('checkout', '⇥ Check Out') + navItem('sync', '⇅ Offline Sync')}${navItem('settings', '⚙ Settings')}<button class="nav" id="logout">↪ Sign Out</button></aside><main class="main"><div class="top"><div><h1>${({ overview: 'Dashboard', records: 'Attendance Records', users: 'User Management', sites: 'Sites', audit: 'Audit Logs', backup: 'Backup', check: 'Check In / Out', checkin: 'Check In', checkout: 'Check Out', sync: 'Offline Sync', settings: 'Settings' })[view]}</h1><div class="muted tiny">${esc(user.full_name)} · ${esc(user.role)} · <span class="${navigator.onLine ? '' : 'offline'}">${navigator.onLine ? 'Online' : 'Offline'}</span></div></div><button class="btn alt" id="refresh">↻ Refresh</button></div>${body}</main></div>`;
    document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; render() });
    $('#logout').onclick = async () => { try { await api('/api/logout', { method: 'POST' }) } catch { } user = null; localStorage.removeItem('fa_user'); renderAuth() };
    $('#refresh').onclick = refresh;
}

function pill(v) { return `<span class="pill ${v === 'Synced' || v === 'completed' ? 'ok' : v === 'Failed' ? 'bad' : 'wait'}">${esc(v)}</span>` }

function rowRecord(r) {
    return `<tr><td>${user.role === 'admin' ? `<button class="btn alt" data-record="${esc(r.id)}">View</button>` : `<div class="row-actions"><button class="btn alt" data-record="${esc(r.id)}">View</button>${r.status === 'checked_in' ? `<button class="btn" data-checkout="${esc(r.id)}">Check Out</button>` : ''}</div>`}</td><td>${esc(r.full_name || user.full_name)}</td><td>${esc(r.location_name || r.site_name)}</td><td>${fmt(r.check_in_device_at)}</td><td>${esc(r.check_out_location_name || '—')}</td><td>${fmt(r.check_out_device_at)}</td><td>${pill(r.status)}</td><td>${r.photo_count ?? 0}</td></tr>`;
}
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
    } else if (view === 'sites') {
        layout(`<section class="panel"><h2>Add Site</h2><form id="site-form"><div class="form-grid"><div class="field"><label>Site Name</label><input name="name" required maxlength="120"></div><div class="field"><label>Address</label><input name="address"></div><div class="field"><label>Latitude (optional)</label><input name="latitude" type="number" step="any"></div><div class="field"><label>Longitude (optional)</label><input name="longitude" type="number" step="any"></div></div><button class="btn">Save Site</button></form></section><section class="panel"><h2>Registered Sites</h2>${sites.map(s => `<div class="status"><strong>${esc(s.name)}</strong> — ${esc(s.address || 'No address')}</div>`).join('') || '<p class="muted">No sites configured</p>'}</section>`);
        $('#site-form').onsubmit = async e => { e.preventDefault(); try { await post('/api/sites', Object.fromEntries(new FormData(e.target))); toast('Site created'); await refresh() } catch (err) { toast(err.message) } };
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
    const r = records.find(x => x.id === id); if (!r) return;
    let photos = [];
    try { photos = (await api(`/api/records/${id}/photos`)).photos } catch (e) { toast(e.message) }
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal"><div class="flex between"><h2>Attendance Details</h2><button class="btn alt" id="closemodal">Close</button></div><p><strong>Worker:</strong> ${esc(r.full_name)} (${esc(r.email)})</p><p><strong>Site:</strong> ${esc(r.location_name || r.site_name)}</p><h3>Check In Information</h3><p><strong>Check-in time:</strong> ${fmt(r.check_in_device_at)}</p><p><strong>Check-in location:</strong> ${esc(r.location_name || r.site_name || '—')}</p><p><strong>Check-in GPS:</strong> ${esc(r.check_in_lat ?? '—')}, ${esc(r.check_in_lng ?? '—')} ${r.check_in_lat != null ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${encodeURIComponent(r.check_in_lat + ',' + r.check_in_lng)}">Map</a>` : ''}</p><p><strong>Check-in notes:</strong> ${esc(r.check_in_notes || r.notes || '—')}</p><h3>All Check-in Photos</h3><div class="photo-row">${photos.filter(p => p.phase === 'before').map(p => `<a target="_blank" href="/api/photo/${p.id}"><img class="thumb" src="/api/photo/${p.id}" alt="Before photo"></a>`).join('') || 'None'}</div><h3>Check Out Information</h3><p><strong>Check-out time:</strong> ${fmt(r.check_out_device_at)}</p><p><strong>Check-out location:</strong> ${esc(r.check_out_location_name || r.location_name || '—')}</p><p><strong>Check-out GPS:</strong> ${esc(r.check_out_lat ?? '—')}, ${esc(r.check_out_lng ?? '—')} ${r.check_out_lat != null ? `<a target="_blank" rel="noopener" href="https://www.google.com/maps?q=${encodeURIComponent(r.check_out_lat + ',' + r.check_out_lng)}">Map</a>` : ''}</p><p><strong>Check-out notes:</strong> ${esc(r.check_out_notes || '—')}</p><h3>All Check-out Photos</h3><div class="photo-row">${photos.filter(p => p.phase === 'after').map(p => `<a target="_blank" href="/api/photo/${p.id}"><img class="thumb" src="/api/photo/${p.id}" alt="After photo"></a>`).join('') || 'None'}</div></div>`;
    document.body.append(bg);
    bg.querySelector('#closemodal').onclick = () => bg.remove();
    bg.onclick = e => { if (e.target === bg) bg.remove() };
}

function editUser(id) {
    const u = users.find(x => x.id === id); if (!u) return;
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal"><h2>Edit User</h2><form id="edit-user"><div class="field"><label>Name</label><input name="full_name" value="${esc(u.full_name)}" required></div><div class="field"><label>Role</label><select name="role"><option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></div><div class="field"><label>Account</label><select name="active"><option value="true" ${u.active ? 'selected' : ''}>Active</option><option value="false" ${!u.active ? 'selected' : ''}>Disabled</option></select></div><div class="actions"><button class="btn">Save Changes</button><button type="button" class="btn alt" id="cancel">Cancel</button></div></form></div>`;
    document.body.append(bg);
    bg.querySelector('#cancel').onclick = () => bg.remove();
    bg.querySelector('form').onsubmit = async e => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.target));
        try {
            await post('/api/admin/users/' + id, { ...d, active: d.active === 'true' }, 'PATCH');
            bg.remove(); toast('User updated'); await refresh();
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

    if (mode === 'checkin') {
        const canCheckIn = active.length === 0;
        layout(`<section class="panel"><div class="flex between"><h2>Check In Form</h2>${canCheckIn ? '<span class="pill ok">Ready to check in</span>' : '<span class="pill wait">Checkout required first</span>'}</div>${canCheckIn ? `<form id="checkin"><div class="field"><label>Check-in Time</label><input class="time-readonly" value="${esc(new Date().toLocaleString())}" readonly></div><div class="field"><label>Location *</label><input name="location_name" required maxlength="200" placeholder="Enter location"></div><div class="field"><label>Get GPS Location *</label><div class="flex"><button class="btn alt" type="button" id="gps-in">Get GPS Location</button><span class="muted tiny" id="gps-in-status">Not captured</span></div></div><div class="field"><label>Location Photo *</label><button class="btn alt" type="button" id="camera-in">Take Location Photo</button><span class="muted tiny" id="camera-in-status"></span></div><div class="field"><label>Before Photo(s) *</label><button class="btn alt" type="button" id="camera-in-more">Add Before Photo(s)</button><span class="muted tiny" id="camera-in-more-status">Photos are saved together</span></div><div class="field"><label>Condition Notes (optional)</label><textarea name="notes" rows="2" placeholder=""></textarea></div><button class="btn good" type="submit">Submit Check In</button></form>` : `<p class="notice">You are currently checked in. Please complete Check Out before checking in at another point.</p><button class="btn" id="go-checkout">Go to Check Out Form</button>`}</section>`);
        let gpsIn = null, inPhotos = [];
        const gpsText = g => `${g.latitude.toFixed(5)}, ${g.longitude.toFixed(5)} ±${Math.round(g.accuracy)}m`;
        $('#gps-in')?.addEventListener('click', () => getGps(g => { gpsIn = g; $('#gps-in-status').textContent = gpsText(g) }));
        const takeIn = () => openCamera(files => { inPhotos = inPhotos.concat(files); $('#camera-in-status').textContent = `${inPhotos.length} photo(s) captured`; $('#camera-in-more-status').textContent = `${inPhotos.length} photo(s) captured` });
        $('#camera-in')?.addEventListener('click', takeIn);
        $('#camera-in-more')?.addEventListener('click', takeIn);
        $('#go-checkout')?.addEventListener('click', () => { selectedCheckoutId = null; view = 'checkout'; render() });
        $('#checkin')?.addEventListener('submit', async e => {
            e.preventDefault();
            const f = e.target;
            if (!gpsIn) return toast('Please get GPS Location before submitting.');
            if (!inPhotos.length) return toast('Please take at least one photo.');
            await saveAction('check_in', uid(), { location_name: f.location_name.value.trim(), notes: f.notes.value }, gpsIn, inPhotos);
        });
    } else {
        let chosen = active.find(x => x.id === selectedCheckoutId) || null;
        layout(`<section class="panel"><div class="flex between"><h2>Check Out Form</h2><span class="pill ${active.length ? 'wait' : 'ok'}">${active.length ? 'Check-in active' : 'No active check-in'}</span></div>${active.length ? `<div class="field"><label>Check Out Location *</label><select id="checkout-record"><option value="">Select the location to check out</option>${active.map(x => `<option value="${esc(x.id)}" ${chosen?.id === x.id ? 'selected' : ''}>${esc(x.location_name || x.site_name || 'Unnamed location')} — ${fmt(x.check_in_device_at)}</option>`).join('')}</select></div><div id="checkout-form-area">${chosen ? checkoutFormMarkup(chosen) : '<p class="notice">Select an active check-in above to open its Check Out form.</p>'}</div>` : '<p class="notice">There are no active check-ins to check out.</p><button class="btn" id="go-checkin">Go to Check In Form</button>'}</section>`);
        const bindOutForm = (r) => {
            const form = $('#checkout'); if (!form) return;
            let gpsOut = null, outPhotos = [];
            const gpsText = g => `${g.latitude.toFixed(5)}, ${g.longitude.toFixed(5)} ±${Math.round(g.accuracy)}m`;
            $('#gps-out').onclick = () => getGps(g => { gpsOut = g; $('#gps-out-status').textContent = gpsText(g) });
            $('#camera-out').onclick = () => openCamera(files => { outPhotos = outPhotos.concat(files); $('#camera-out-status').textContent = `${outPhotos.length} photo(s) captured` });
            $('#camera-out-more').onclick = () => openCamera(files => { outPhotos = outPhotos.concat(files); $('#camera-out-status').textContent = `${outPhotos.length} photo(s) captured` });
            form.onsubmit = async e => {
                e.preventDefault();
                const f = e.target;
                if (!gpsOut) return toast('Please get GPS Location before submitting.');
                if (!outPhotos.length) return toast('Please take at least one after photo.');
                await saveAction('check_out', r.id, { location_name: f.checkout_location.value.trim(), notes: f.notes.value }, gpsOut, outPhotos);
            };
        };
        $('#checkout-record')?.addEventListener('change', e => {
            const r = active.find(x => x.id === e.target.value);
            $('#checkout-form-area').innerHTML = r ? checkoutFormMarkup(r) : '<p class="notice">Select an active check-in above to open its Check Out form.</p>';
            if (r) bindOutForm(r);
        });
        if (chosen) bindOutForm(chosen);
        $('#go-checkin')?.addEventListener('click', () => { view = 'checkin'; render() });
    }
}

function checkoutFormMarkup(r) {
    return `<div class="status"><strong>${esc(r.location_name || r.site_name || 'Unnamed location')}</strong><div class="tiny muted">Checked in at ${fmt(r.check_in_device_at)}</div></div><form id="checkout"><div class="field"><label>Check-out Time</label><input class="time-readonly" value="${esc(new Date().toLocaleString())}" readonly></div><div class="field"><label>Check Out Location *</label><input name="checkout_location" required maxlength="200" value="${esc(r.location_name || r.site_name || '')}" placeholder="Confirm customer or site name"></div><div class="field"><label>Get GPS Location *</label><div class="flex"><button class="btn alt" type="button" id="gps-out">Get GPS Location</button><span class="muted tiny" id="gps-out-status">Not captured</span></div></div><div class="field"><label>After Photos *</label><div class="flex"><button class="btn alt" type="button" id="camera-out">Take After Photo(s)</button><button class="btn alt" type="button" id="camera-out-more">Add More Photos</button></div><span class="muted tiny" id="camera-out-status">No photos captured</span></div><div class="field"><label>After Note (optional)</label><textarea name="notes" rows="2" placeholder=""></textarea></div><button class="btn good" type="submit">Submit Check Out</button></form>`;
}

async function openCamera(onDone) {
    if (!navigator.mediaDevices?.getUserMedia) { toast('Live camera requires a supported browser and HTTPS connection.'); return; }
    let stream, files = [];
    const bg = document.createElement('div'); bg.className = 'modalbg';
    bg.innerHTML = `<div class="modal"><div class="flex between"><h2>Take Photo</h2><button class="btn alt" id="camera-close">Cancel</button></div><video id="camera-video" autoplay playsinline style="width:100%;max-height:55vh;background:#111;border-radius:12px"></video><canvas id="camera-canvas" style="display:none"></canvas><p class="muted" id="camera-count">0 photos captured</p><div class="flex"><button class="btn" id="camera-shot">Capture Photo</button><button class="btn good" id="camera-done">Use Photos</button></div></div>`;
    document.body.append(bg);
    const close = () => { try { stream?.getTracks().forEach(t => t.stop()) } catch { } bg.remove() };
    bg.querySelector('#camera-close').onclick = close;
    bg.onclick = e => { if (e.target === bg) close() };
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        bg.querySelector('#camera-video').srcObject = stream;
    } catch (e) {
        close(); toast('Cannot open camera. Please allow camera permission and use HTTPS.'); return;
    }
    bg.querySelector('#camera-shot').onclick = async () => {
        const v = bg.querySelector('#camera-video'), c = bg.querySelector('#camera-canvas');
        if (!v.videoWidth) return toast('Camera is not ready yet.');
        const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
        c.width = Math.round(v.videoWidth * scale);
        c.height = Math.round(v.videoHeight * scale);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        const blob = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', .85));
        if (blob) {
            files.push(new File([blob], `camera-${Date.now()}-${files.length + 1}.jpg`, { type: 'image/jpeg' }));
            bg.querySelector('#camera-count').textContent = `${files.length} photo(s) captured`;
        }
    };
    bg.querySelector('#camera-done').onclick = () => {
        if (!files.length) { toast('Please capture at least one photo.'); return; }
        close(); onDone(files);
    };
}

function getGps(done) {
    if (!navigator.geolocation) return toast('GPS not supported in this browser');
    navigator.geolocation.getCurrentPosition(
        p => done({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy }),
        e => toast('GPS: ' + e.message),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
}

async function compress(file) {
    if (!file.type.startsWith('image/')) throw Error('Choose image files only');
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    let blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .72));
    if (blob.size > 550000) blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', .48));
    return blob;
}

async function uploadPhotoToB2(fileBlob) {
    if (!fileBlob) return null;
    if (!navigator.onLine) throw new Error('Offline mode detected during B2 upload activation');
    const { uploadUrl, downloadUrl } = await api('/api/get-upload-url');
    const b2Response = await fetch(uploadUrl, { method: 'PUT', body: fileBlob, headers: { 'Content-Type': 'image/jpeg' } });
    if (!b2Response.ok) throw new Error('Failed to push photo to Backblaze B2.');
    return downloadUrl;
}

async function saveAction(action, id, extra, gps, files) {
    try {
        const key = uid();
        const payload = { id, action, device_at: new Date().toISOString(), ...extra, ...gps, photo_urls: [] };
        const task = { key, owner: user.id, type: 'record', payload, status: 'Pending', created: Date.now(), tries: 0 };
        await put('queue', task);
        for (const file of Array.from(files || [])) {
            const blob = await compress(file);
            await put('photos', {
                id: uid(),
                owner: user.id,
                recordId: id,
                phase: action === 'check_in' ? 'before' : 'after',
                blob,
                status: 'Pending',
                created: Date.now()
            });
        }
        toast('Saved locally. Synchronization queued.');
        await loadQueue();
        view = 'sync';
        render();
        syncNow();
    } catch (e) {
        toast('Save failed: ' + e.message);
    }
}

async function syncNow() {
    if (syncing || !user || !navigator.onLine) return;
    syncing = true;
    try {
        const tasks = (await all('queue')).filter(x => x.owner === user.id).sort((a, b) => a.created - b.created);
        for (const task of tasks) {
            try {
                const localPhotos = (await all('photos')).filter(p =>
                    p.owner === user.id &&
                    p.recordId === task.payload.id &&
                    p.phase === (task.payload.action === 'check_in' ? 'before' : 'after')
                );
                task.payload.photo_urls = task.payload.photo_urls || [];
                for (const p of localPhotos) {
                    if (p.status === 'Synced') continue;
                    try {
                        const cloudUrl = await uploadPhotoToB2(p.blob);
                        if (cloudUrl && !task.payload.photo_urls.includes(cloudUrl)) task.payload.photo_urls.push(cloudUrl);
                        await del('photos', p.id);
                    } catch (photoErr) {
                        p.status = 'Failed';
                        p.error = photoErr.message;
                        await put('photos', p);
                        throw photoErr;
                    }
                }
                await post('/api/records/sync', task.payload);
                await del('queue', task.key);
            } catch (e) {
                task.status = 'Failed';
                task.error = e.message;
                task.tries++;
                await put('queue', task);
                if (/Server unavailable|Please sign in|Session expired/.test(e.message)) break;
            }
        }
        const orphanPhotos = (await all('photos')).filter(p => p.owner === user.id);
        for (const p of orphanPhotos) {
            try {
                const cloudUrl = await uploadPhotoToB2(p.blob);
                if (cloudUrl) {
                    try { await post('/api/photos/orphan-bind', { photoId: p.id, recordId: p.recordId, url: cloudUrl }) } catch { }
                    await del('photos', p.id);
                }
            } catch (e) {
                p.status = 'Failed';
                p.error = e.message;
                await put('photos', p);
            }
        }
        await loadQueue();
        if (navigator.onLine) { try { await loadServerData() } catch { } }
        if (['sync', 'overview', 'records', 'checkin', 'checkout'].includes(view)) render();
    } finally {
        syncing = false;
    }
}

async function renderSync() {
    const photos = (await all('photos')).filter(x => x.owner === user.id);
    layout(`<section class="panel"><h2>Offline Synchronization</h2><p class="notice">Records and compressed photos are stored on this device until the server confirms receipt. Keep the app installed and do not clear browser data while uploads are pending.</p><div class="flex"><button class="btn" id="syncnow">Submit to Database</button><span class="muted">${queue.length} record actions · ${photos.length} photos pending</span></div><h3>Queued Actions</h3>${queue.map(t => `<div class="status">${pill(t.status)} ${esc(t.payload.action)} · ${esc(t.payload.location_name || t.payload.id)} · ${fmt(t.payload.device_at)} ${t.error ? `<div class="tiny offline">${esc(t.error)}</div>` : ''}</div>`).join('') || '<div class="empty">No pending record actions</div>'}<h3>Queued Photos</h3>${photos.map(p => `<div class="status">${pill(p.status)} ${esc(p.phase)} · ${Math.round(p.blob.size / 1024)} KB ${p.error ? esc(p.error) : ''}</div>`).join('') || '<div class="empty">No pending photos</div>'}</section>`);
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
        const response = await fetch(url, { credentials: 'same-origin' });
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
            const response = await fetch('/api/admin/backup/manual', { method: 'POST', credentials: 'same-origin' });
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

function renderAuth(signup = false) {
    app().innerHTML = `<div class="auth"><div class="authbox"><div class="brand" style="color:#14243b">${brandMarkup()}</div><h1>${signup ? 'Create Account' : 'Welcome Back'}</h1><p class="muted">${signup ? 'Register a field worker account' : 'Sign in to access attendance records'}</p><form id="authform">${signup ? '<div class="field"><label>Full Name</label><input name="full_name" required minlength="2"></div>' : ''}<div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username"></div><div class="field"><label>Password (12+ characters)</label><input name="password" type="password" required minlength="12" autocomplete="${signup ? 'new-password' : 'current-password'}"></div><button class="btn" style="width:100%">${signup ? 'Create Account' : 'Sign In'}</button></form><p><button class="btn alt" id="toggle" style="width:100%">${signup ? 'Already registered? Sign In' : 'New user? Sign Up'}</button></p><p class="muted tiny">Internet is required for first login. Previously signed-in users can save attendance offline on this device.</p></div></div>`;
    $('#toggle').onclick = () => renderAuth(!signup);
    $('#authform').onsubmit = async e => {
        e.preventDefault();
        try {
            const d = await post(signup ? '/api/signup' : '/api/login', Object.fromEntries(new FormData(e.target)));
            user = d.user;
            localStorage.setItem('fa_user', JSON.stringify(user));
            view = 'overview';
            await refresh();
            toast('Signed in');
        } catch (err) { toast(err.message) }
    };
}

async function loadServerData() {
    const results = await Promise.all([api('/api/records'), api('/api/sites')]);
    records = results[0].records;
    sites = results[1].sites;
    if (user.role === 'admin') {
        const [s, u] = await Promise.all([api('/api/admin/summary'), api('/api/admin/users')]);
        summary = s;
        users = u.users;
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
    try {
        for (const t of await all('queue')) {
            if (t.status === 'Failed') { t.status = 'Pending'; delete t.error; await put('queue', t) }
        }
        for (const p of await all('photos')) {
            if (p.status === 'Failed') { p.status = 'Pending'; delete p.error; await put('photos', p) }
        }
    } catch { }
    try { branding = await api('/api/settings'); document.title = branding.appName || 'Field Attendance' } catch { }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => { });
    try {
        const d = await api('/api/me');
        user = d.user;
        localStorage.setItem('fa_user', JSON.stringify(user));
    } catch {
        try { user = JSON.parse(localStorage.getItem('fa_user') || 'null') } catch { user = null }
    }
    if (user) await refresh(); else renderAuth();
    window.addEventListener('online', () => { toast('Connection restored. Retrying uploads...'); syncNow() });
    window.addEventListener('focus', () => { if (user) syncNow() });
    setInterval(() => { if (user && navigator.onLine) syncNow() }, 60000);
}
start();