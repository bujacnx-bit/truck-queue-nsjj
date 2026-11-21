const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Initialize SQLite Database ---
const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS bays (
    id INTEGER PRIMARY KEY,
    bay_code TEXT NOT NULL UNIQUE,
    zone_id INTEGER NOT NULL,
    zone_name TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'IDLE', -- IDLE, CALLED, LOADING
    current_queue_id INTEGER NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS queues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue_number TEXT NOT NULL,
    plate_number TEXT NOT NULL,
    vehicle_type TEXT NOT NULL,       -- small, 6_wheel, 10_wheel, trailer
    vehicle_type_label TEXT NOT NULL,
    zone_target INTEGER NOT NULL,     -- 1 or 2
    driver_phone TEXT,
    order_no TEXT,
    forklift_driver TEXT,             -- พนักงานโฟล์คลิฟต์
    status TEXT NOT NULL DEFAULT 'WAITING', -- WAITING, CALLED, LOADING, COMPLETED, CANCELLED, SKIPPED
    assigned_bay_id INTEGER NULL,
    assigned_bay_name TEXT NULL,
    created_at TEXT NOT NULL,
    called_at TEXT,
    started_loading_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS forklift_drivers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_counter (
    date_str TEXT PRIMARY KEY,
    zone1_count INTEGER DEFAULT 0,
    zone2_count INTEGER DEFAULT 0
  );
`);

// Auto-migrate column if existing database
try {
  db.exec('ALTER TABLE queues ADD COLUMN forklift_driver TEXT;');
} catch (e) {
  // Column already exists
}

// Seed Initial Bays if not exists
const existingBays = db.prepare('SELECT COUNT(*) as cnt FROM bays').get();
if (existingBays.cnt === 0) {
  const insertBay = db.prepare(`
    INSERT INTO bays (id, bay_code, zone_id, zone_name, name, status, updated_at)
    VALUES (?, ?, ?, ?, ?, 'IDLE', datetime('now', 'localtime'))
  `);
  // จุดที่ 1: รถเล็ก, 6 ล้อ, 10 ล้อ (3 ช่อง)
  insertBay.run(1, 'BAY-1', 1, 'จุดที่ 1 (รถเล็ก/6ล้อ/10ล้อ)', 'ช่องโหลด 1');
  insertBay.run(2, 'BAY-2', 1, 'จุดที่ 1 (รถเล็ก/6ล้อ/10ล้อ)', 'ช่องโหลด 2');
  insertBay.run(3, 'BAY-3', 1, 'จุดที่ 1 (รถเล็ก/6ล้อ/10ล้อ)', 'ช่องโหลด 3');
  // จุดที่ 2: รถเทรลเลอร์ (1 ช่อง)
  insertBay.run(4, 'BAY-T1', 2, 'จุดที่ 2 (รถเทรลเลอร์)', 'ช่องโหลดเทรลเลอร์ T1');
}

// --- Helper Functions ---
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function getTodayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseSqliteDate(str) {
  if (!str) return null;
  // Format: 'YYYY-MM-DD HH:MM:SS' -> parse in local timezone
  const parts = str.split(/[- :]/);
  if (parts.length < 6) return new Date(str);
  return new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
}

function calculateDuration(startStr, endStr) {
  if (!startStr || !endStr) return { text: '-', minutes: 0, seconds: 0 };
  const start = parseSqliteDate(startStr);
  const end = parseSqliteDate(endStr);
  if (!start || !end) return { text: '-', minutes: 0, seconds: 0 };

  const diffMs = end.getTime() - start.getTime();
  if (diffMs < 0) return { text: '-', minutes: 0, seconds: 0 };

  const totalSec = Math.floor(diffMs / 1000);
  const totalMin = Math.floor(totalSec / 60);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const secs = totalSec % 60;

  let text = '';
  if (hours > 0) {
    text = `${hours} ชม. ${mins} นาที`;
  } else if (mins > 0) {
    text = `${mins} นาที ${secs} วิ`;
  } else {
    text = `${secs} วินาที`;
  }

  return { text, minutes: Math.round((totalSec / 60) * 10) / 10, seconds: totalSec };
}

function getNextQueueNumber(zoneTarget) {
  const today = getTodayString();
  let row = db.prepare('SELECT * FROM daily_counter WHERE date_str = ?').get(today);
  if (!row) {
    db.prepare('INSERT INTO daily_counter (date_str, zone1_count, zone2_count) VALUES (?, 0, 0)').run(today);
    row = { date_str: today, zone1_count: 0, zone2_count: 0 };
  }

  let nextSeq = 1;
  let prefix = 'A';
  if (zoneTarget === 1) {
    nextSeq = row.zone1_count + 1;
    prefix = 'A';
    db.prepare('UPDATE daily_counter SET zone1_count = ? WHERE date_str = ?').run(nextSeq, today);
  } else {
    nextSeq = row.zone2_count + 1;
    prefix = 'T';
    db.prepare('UPDATE daily_counter SET zone2_count = ? WHERE date_str = ?').run(nextSeq, today);
  }

  return `${prefix}-${String(nextSeq).padStart(3, '0')}`;
}

const VEHICLE_LABELS = {
  small: 'รถเล็ก (4 ล้อ)',
  '6_wheel': 'รถ 6 ล้อ',
  '10_wheel': 'รถ 10 ล้อ',
  trailer: 'รถเทรลเลอร์'
};

// --- SSE (Server-Sent Events) ---
const sseClients = new Set();

function broadcastEvent(eventType, payload) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

function getCurrentSystemState() {
  const bays = db.prepare(`
    SELECT b.*,
           q.queue_number, q.plate_number, q.vehicle_type, q.vehicle_type_label,
           q.driver_phone, q.order_no, q.called_at, q.started_loading_at, q.forklift_driver
    FROM bays b
    LEFT JOIN queues q ON b.current_queue_id = q.id
    ORDER BY b.id ASC
  `).all();

  const waitingZone1 = db.prepare(`
    SELECT * FROM queues
    WHERE zone_target = 1 AND status = 'WAITING'
    ORDER BY id ASC
  `).all();

  const waitingZone2 = db.prepare(`
    SELECT * FROM queues
    WHERE zone_target = 2 AND status = 'WAITING'
    ORDER BY id ASC
  `).all();

  const activeQueues = db.prepare(`
    SELECT * FROM queues
    WHERE status IN ('CALLED', 'LOADING')
    ORDER BY id ASC
  `).all();

  const forkliftDrivers = db.prepare('SELECT name FROM forklift_drivers ORDER BY name ASC').all().map(r => r.name);

  const today = getTodayString();
  const completedToday = db.prepare(`
    SELECT COUNT(*) as count FROM queues
    WHERE status = 'COMPLETED' AND date(created_at) = ?
  `).get(today);

  return {
    bays,
    waitingZone1,
    waitingZone2,
    activeQueues,
    forkliftDrivers,
    stats: {
      waitingTotal: waitingZone1.length + waitingZone2.length,
      completedToday: completedToday.count,
      serverTime: new Date().toLocaleTimeString('th-TH')
    }
  };
}

// --- Request Handlers ---
function handleApi(req, res, parsedUrl) {
  const method = req.method;
  const pathname = parsedUrl.pathname;

  const jsonResponse = (status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify(data));
  };

  // 1. SSE Stream
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED' })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 2. System State
  if (pathname === '/api/state' && method === 'GET') {
    return jsonResponse(200, getCurrentSystemState());
  }

  // 3. System Info (Local IP & Port)
  if (pathname === '/api/system-info' && method === 'GET') {
    const localIp = getLocalIP();
    return jsonResponse(200, {
      localIp,
      port: PORT,
      url: `http://${localIp}:${PORT}`,
      localUrl: `http://localhost:${PORT}`
    });
  }

  // 4. Reports API
  if (pathname === '/api/reports' && method === 'GET') {
    const targetDate = parsedUrl.searchParams.get('date') || getTodayString();
    const isAll = parsedUrl.searchParams.get('all') === '1';

    let rows = [];
    if (isAll) {
      rows = db.prepare(`
        SELECT * FROM queues
        WHERE status = 'COMPLETED'
        ORDER BY completed_at DESC
      `).all();
    } else {
      rows = db.prepare(`
        SELECT * FROM queues
        WHERE status = 'COMPLETED' AND date(created_at) = ?
        ORDER BY completed_at DESC
      `).all(targetDate);
    }

    let totalLoadingMinutes = 0;
    let totalWaitMinutes = 0;
    let countWithLoading = 0;

    const enriched = rows.map(q => {
      const loadDur = calculateDuration(q.started_loading_at, q.completed_at);
      const waitDur = calculateDuration(q.created_at, q.started_loading_at || q.called_at);
      const totalDur = calculateDuration(q.created_at, q.completed_at);

      if (loadDur.minutes > 0) {
        totalLoadingMinutes += loadDur.minutes;
        countWithLoading++;
      }
      totalWaitMinutes += waitDur.minutes;

      return {
        ...q,
        loading_duration_text: loadDur.text,
        loading_minutes: loadDur.minutes,
        wait_duration_text: waitDur.text,
        wait_minutes: waitDur.minutes,
        total_duration_text: totalDur.text,
        total_minutes: totalDur.minutes
      };
    });

    const avgLoading = countWithLoading > 0 ? (totalLoadingMinutes / countWithLoading).toFixed(1) : 0;
    const avgWait = enriched.length > 0 ? (totalWaitMinutes / enriched.length).toFixed(1) : 0;

    return jsonResponse(200, {
      date: targetDate,
      totalTrucks: enriched.length,
      avgLoadingMinutes: Number(avgLoading),
      avgWaitMinutes: Number(avgWait),
      records: enriched
    });
  }

  // 5. Reports Export CSV API
  if (pathname === '/api/reports/export' && method === 'GET') {
    const targetDate = parsedUrl.searchParams.get('date') || getTodayString();
    const isAll = parsedUrl.searchParams.get('all') === '1';

    let rows = [];
    if (isAll) {
      rows = db.prepare("SELECT * FROM queues WHERE status = 'COMPLETED' ORDER BY completed_at ASC").all();
    } else {
      rows = db.prepare("SELECT * FROM queues WHERE status = 'COMPLETED' AND date(created_at) = ? ORDER BY completed_at ASC").all(targetDate);
    }

    // CSV Header (UTF-8 with BOM for Excel)
    let csv = '\uFEFF';
    csv += 'ลำดับคิว,ทะเบียนรถ,ประเภทรถ,จุด/ช่องโหลด,พนักงานโฟล์คลิฟต์,เลขออเดอร์,เบอร์โทร,เวลาออกบัตรคิว,เวลาเริ่มขึ้นของ,เวลาเสร็จสิ้น,ระยะเวลาขึ้นสินค้า,ระยะเวลารอคิว,เวลารวมทั้งหมด\r\n';

    for (const q of rows) {
      const loadDur = calculateDuration(q.started_loading_at, q.completed_at);
      const waitDur = calculateDuration(q.created_at, q.started_loading_at || q.called_at);
      const totalDur = calculateDuration(q.created_at, q.completed_at);

      const line = [
        `"${q.queue_number}"`,
        `"${q.plate_number}"`,
        `"${q.vehicle_type_label}"`,
        `"${q.assigned_bay_name || '-'}"`,
        `"${q.forklift_driver || '-'}"`,
        `"${q.order_no || '-'}"`,
        `"${q.driver_phone || '-'}"`,
        `"${q.created_at || '-'}"`,
        `"${q.started_loading_at || '-'}"`,
        `"${q.completed_at || '-'}"`,
        `"${loadDur.text}"`,
        `"${waitDur.text}"`,
        `"${totalDur.text}"`
      ].join(',');
      csv += line + '\r\n';
    }

    const filename = `truck_loading_report_${targetDate}.csv`;
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(csv);
  }

  // 6. Get Single Queue
  if (pathname.startsWith('/api/queue/') && method === 'GET') {
    const id = parseInt(pathname.split('/')[3], 10);
    const queue = db.prepare('SELECT * FROM queues WHERE id = ?').get(id);
    if (!queue) {
      return jsonResponse(404, { error: 'ไม่พบหมายเลขคิว' });
    }

    let inFrontCount = 0;
    if (queue.status === 'WAITING') {
      const row = db.prepare(`
        SELECT COUNT(*) as cnt FROM queues
        WHERE zone_target = ? AND status = 'WAITING' AND id < ?
      `).get(queue.zone_target, queue.id);
      inFrontCount = row.cnt;
    }

    return jsonResponse(200, { ...queue, inFrontCount });
  }

  // Body Parsing for POST
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let data = {};
    if (body) {
      try { data = JSON.parse(body); } catch (e) {
        return jsonResponse(400, { error: 'Invalid JSON body' });
      }
    }

    // 7. Register Queue
    if (pathname === '/api/queue/register' && method === 'POST') {
      const { plate_number, vehicle_type, driver_phone, order_no } = data;
      if (!plate_number || !vehicle_type) {
        return jsonResponse(400, { error: 'กรุณากรอกทะเบียนรถและเลือกประเภทรถ' });
      }

      const zone_target = vehicle_type === 'trailer' ? 2 : 1;
      const vehicle_type_label = VEHICLE_LABELS[vehicle_type] || vehicle_type;
      const queue_number = getNextQueueNumber(zone_target);

      const stmt = db.prepare(`
        INSERT INTO queues (
          queue_number, plate_number, vehicle_type, vehicle_type_label,
          zone_target, driver_phone, order_no, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'WAITING', datetime('now', 'localtime'))
      `);
      const info = stmt.run(
        queue_number,
        plate_number.trim(),
        vehicle_type,
        vehicle_type_label,
        zone_target,
        (driver_phone || '').trim(),
        (order_no || '').trim()
      );

      const newQueue = db.prepare('SELECT * FROM queues WHERE id = ?').get(info.lastInsertRowid);
      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(201, newQueue);
    }

    // 8. Call Queue to Bay
    if (pathname === '/api/bay/call' && method === 'POST') {
      const { bay_id, queue_id } = data;
      const bay = db.prepare('SELECT * FROM bays WHERE id = ?').get(bay_id);
      if (!bay) {
        return jsonResponse(404, { error: 'ไม่พบช่องโหลดที่ระบุ' });
      }

      let targetQueue = null;
      if (queue_id) {
        targetQueue = db.prepare('SELECT * FROM queues WHERE id = ?').get(queue_id);
      } else {
        targetQueue = db.prepare(`
          SELECT * FROM queues
          WHERE zone_target = ? AND status = 'WAITING'
          ORDER BY id ASC LIMIT 1
        `).get(bay.zone_id);
      }

      if (!targetQueue) {
        return jsonResponse(400, { error: 'ไม่มีคิวรอสำหรับจุดโหลดนี้' });
      }

      if (bay.current_queue_id && bay.current_queue_id !== targetQueue.id) {
        db.prepare("UPDATE queues SET status = 'SKIPPED' WHERE id = ?").run(bay.current_queue_id);
      }

      db.prepare(`
        UPDATE bays
        SET status = 'CALLED', current_queue_id = ?, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(targetQueue.id, bay.id);

      db.prepare(`
        UPDATE queues
        SET status = 'CALLED', assigned_bay_id = ?, assigned_bay_name = ?,
            called_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(bay.id, bay.name, targetQueue.id);

      let voiceText = '';
      if (bay.zone_id === 1) {
        voiceText = `ขอเชิญคิว ${targetQueue.queue_number} ทะเบียน ${targetQueue.plate_number} เข้าจุดที่หนึ่ง ${bay.name} ค่ะ`;
      } else {
        voiceText = `ขอเชิญคิว ${targetQueue.queue_number} ทะเบียน ${targetQueue.plate_number} เข้าจุดที่สอง ช่องเทรลเลอร์ ค่ะ`;
      }

      const state = getCurrentSystemState();
      broadcastEvent('UPDATE', state);
      broadcastEvent('VOICE_ANNOUNCEMENT', {
        voiceText,
        queueNumber: targetQueue.queue_number,
        plateNumber: targetQueue.plate_number,
        bayName: bay.name,
        zoneName: bay.zone_name
      });

      return jsonResponse(200, { success: true, bay, queue: targetQueue });
    }

    // 9. Start Loading
    if (pathname === '/api/bay/start' && method === 'POST') {
      const { bay_id, forklift_driver } = data;
      const bay = db.prepare('SELECT * FROM bays WHERE id = ?').get(bay_id);
      if (!bay || !bay.current_queue_id) {
        return jsonResponse(400, { error: 'ไม่มีคิวที่กำลังรอขึ้นของในช่องนี้' });
      }

      const driverName = (forklift_driver || '').trim();
      if (driverName) {
        try {
          db.prepare('INSERT OR IGNORE INTO forklift_drivers (name) VALUES (?)').run(driverName);
        } catch (e) {}
      }

      db.prepare(`
        UPDATE bays
        SET status = 'LOADING', updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(bay_id);

      db.prepare(`
        UPDATE queues
        SET status = 'LOADING', started_loading_at = datetime('now', 'localtime'),
            forklift_driver = ?
        WHERE id = ?
      `).run(driverName || null, bay.current_queue_id);

      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(200, { success: true });
    }

    // 9.1 Update Forklift Driver
    if (pathname === '/api/bay/update_driver' && method === 'POST') {
      const { bay_id, forklift_driver } = data;
      const bay = db.prepare('SELECT * FROM bays WHERE id = ?').get(bay_id);
      if (!bay || !bay.current_queue_id) {
        return jsonResponse(400, { error: 'ไม่มีคิวในช่องนี้' });
      }
      const driverName = (forklift_driver || '').trim();
      if (driverName) {
        try {
          db.prepare('INSERT OR IGNORE INTO forklift_drivers (name) VALUES (?)').run(driverName);
        } catch (e) {}
      }
      db.prepare('UPDATE queues SET forklift_driver = ? WHERE id = ?').run(driverName || null, bay.current_queue_id);
      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(200, { success: true });
    }

    // 10. Complete Loading
    if (pathname === '/api/bay/complete' && method === 'POST') {
      const { bay_id } = data;
      const bay = db.prepare('SELECT * FROM bays WHERE id = ?').get(bay_id);
      if (!bay) {
        return jsonResponse(404, { error: 'ไม่พบช่องโหลด' });
      }

      if (bay.current_queue_id) {
        db.prepare(`
          UPDATE queues
          SET status = 'COMPLETED', completed_at = datetime('now', 'localtime')
          WHERE id = ?
        `).run(bay.current_queue_id);
      }

      db.prepare(`
        UPDATE bays
        SET status = 'IDLE', current_queue_id = NULL, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(bay_id);

      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(200, { success: true });
    }

    // 11. Skip Bay
    if (pathname === '/api/bay/skip' && method === 'POST') {
      const { bay_id } = data;
      const bay = db.prepare('SELECT * FROM bays WHERE id = ?').get(bay_id);
      if (!bay || !bay.current_queue_id) {
        return jsonResponse(400, { error: 'ไม่มีคิวที่เรียกอยู่ในช่องนี้' });
      }

      db.prepare("UPDATE queues SET status = 'SKIPPED' WHERE id = ?").run(bay.current_queue_id);

      db.prepare(`
        UPDATE bays
        SET status = 'IDLE', current_queue_id = NULL, updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(bay_id);

      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(200, { success: true });
    }

    // 12. Cancel Queue
    if (pathname === '/api/queue/cancel' && method === 'POST') {
      const { queue_id } = data;
      const queue = db.prepare('SELECT * FROM queues WHERE id = ?').get(queue_id);
      if (!queue) {
        return jsonResponse(404, { error: 'ไม่พบหมายเลขคิว' });
      }

      db.prepare("UPDATE queues SET status = 'CANCELLED' WHERE id = ?").run(queue_id);

      if (queue.assigned_bay_id) {
        db.prepare(`
          UPDATE bays
          SET status = 'IDLE', current_queue_id = NULL, updated_at = datetime('now', 'localtime')
          WHERE id = ? AND current_queue_id = ?
        `).run(queue.assigned_bay_id, queue_id);
      }

      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(200, { success: true });
    }

    // 13. Repeat Announcement
    if (pathname === '/api/bay/announce' && method === 'POST') {
      const { bay_id } = data;
      const bay = db.prepare(`
        SELECT b.*, q.queue_number, q.plate_number
        FROM bays b
        JOIN queues q ON b.current_queue_id = q.id
        WHERE b.id = ?
      `).get(bay_id);

      if (!bay) {
        return jsonResponse(400, { error: 'ไม่มีคิวที่ถูกเรียกอยู่ในช่องนี้' });
      }

      let voiceText = '';
      if (bay.zone_id === 1) {
        voiceText = `ขอเชิญคิว ${bay.queue_number} ทะเบียน ${bay.plate_number} เข้าจุดที่หนึ่ง ${bay.name} ค่ะ`;
      } else {
        voiceText = `ขอเชิญคิว ${bay.queue_number} ทะเบียน ${bay.plate_number} เข้าจุดที่สอง ช่องเทรลเลอร์ ค่ะ`;
      }

      broadcastEvent('VOICE_ANNOUNCEMENT', {
        voiceText,
        queueNumber: bay.queue_number,
        plateNumber: bay.plate_number,
        bayName: bay.name,
        zoneName: bay.zone_name
      });

      return jsonResponse(200, { success: true });
    }

    // 14. Reset Daily
    if (pathname === '/api/system/reset' && method === 'POST') {
      db.prepare("UPDATE bays SET status = 'IDLE', current_queue_id = NULL").run();
      db.prepare("DELETE FROM queues").run();
      db.prepare("DELETE FROM daily_counter").run();
      broadcastEvent('UPDATE', getCurrentSystemState());
      return jsonResponse(200, { success: true, message: 'รีเซ็ตข้อมูลคิวเรียบร้อย' });
    }

    return jsonResponse(404, { error: 'API Endpoint not found' });
  });
}

// --- Static File Server ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (parsedUrl.pathname.startsWith('/api/')) {
    return handleApi(req, res, parsedUrl);
  }

  let filePath = parsedUrl.pathname;
  if (filePath === '/' || filePath === '/driver') {
    filePath = '/index.html';
  } else if (filePath === '/staff' || filePath === '/admin') {
    filePath = '/staff.html';
  } else if (filePath === '/tv' || filePath === '/board') {
    filePath = '/tv.html';
  } else if (filePath === '/qr' || filePath === '/qrcode') {
    filePath = '/qr.html';
  } else if (filePath === '/report' || filePath === '/reports') {
    filePath = '/report.html';
  }

  // Check in PUBLIC_DIR first, fallback to root directory
  let absolutePath = path.join(PUBLIC_DIR, filePath);
  if (!fs.existsSync(absolutePath)) {
    const fallbackPath = path.join(__dirname, filePath);
    if (fs.existsSync(fallbackPath)) {
      absolutePath = fallbackPath;
    }
  }

  fs.stat(absolutePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found - ไม่พบหน้าที่ต้องการ');
    }

    const ext = path.extname(absolutePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(absolutePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const localIp = getLocalIP();
  console.log('========================================================');
  console.log('   🚚 ระบบจัดการคิวรถขนส่งสินค้า (Truck Queue System)    ');
  console.log('========================================================');
  console.log(`📡 Server กำลังทำงานที่:`);
  console.log(`   - บนเครื่องนี้ (Local):       http://localhost:${PORT}`);
  console.log(`   - มือถือ/อุปกรณ์ใน Wi-Fi:   http://${localIp}:${PORT}`);
  console.log('--------------------------------------------------------');
  console.log(`📱 สำหรับคนขับสแกนรับคิว:     http://${localIp}:${PORT}/`);
  console.log(`🖥️ สำหรับเจ้าหน้าที่คลัง:       http://localhost:${PORT}/staff`);
  console.log(`📺 สำหรับจอ TV หน้าลานจอด:      http://localhost:${PORT}/tv`);
  console.log(`📊 สำหรับดูรายงานประวัติ:       http://localhost:${PORT}/report`);
  console.log(`🖨️ หน้าพิมพ์ป้าย QR Code:       http://localhost:${PORT}/qr`);
  console.log('========================================================');
});
