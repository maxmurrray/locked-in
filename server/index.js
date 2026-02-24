const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const http = createServer(app);
const io = new Server(http);
const db = new Database('./lockedin.db');

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── Database setup ───
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    created_by TEXT REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT REFERENCES groups(id),
    user_id TEXT REFERENCES users(id),
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS tracked_sites (
    group_id TEXT REFERENCES groups(id),
    domain TEXT NOT NULL,
    PRIMARY KEY (group_id, domain)
  );
  CREATE TABLE IF NOT EXISTS violations (
    id TEXT PRIMARY KEY,
    group_id TEXT REFERENCES groups(id),
    user_id TEXT REFERENCES users(id),
    domain TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS streaks (
    group_id TEXT REFERENCES groups(id),
    user_id TEXT REFERENCES users(id),
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    broken_at DATETIME,
    PRIMARY KEY (group_id, user_id)
  );
`);

const genId = () => crypto.randomBytes(8).toString('hex');
const genCode = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// ─── Auth (simple, no passwords for MVP) ───
app.post('/api/register', (req, res) => {
  const { username } = req.body;
  if (!username || username.length < 2) return res.status(400).json({ error: 'username too short' });
  const id = genId();
  try {
    db.prepare('INSERT INTO users (id, username) VALUES (?, ?)').run(id, username.toLowerCase());
    res.json({ id, username: username.toLowerCase() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'username taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username?.toLowerCase());
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

// ─── Groups ───
app.post('/api/groups', (req, res) => {
  const { name, userId, sites } = req.body;
  const id = genId();
  const invite_code = genCode();
  db.prepare('INSERT INTO groups (id, name, invite_code, created_by) VALUES (?, ?, ?, ?)').run(id, name, invite_code, userId);
  db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(id, userId);
  // Add tracked sites
  const insertSite = db.prepare('INSERT INTO tracked_sites (group_id, domain) VALUES (?, ?)');
  (sites || []).forEach(s => insertSite.run(id, s));
  // Init streak
  db.prepare('INSERT INTO streaks (group_id, user_id) VALUES (?, ?)').run(id, userId);
  res.json({ id, name, invite_code });
});

app.post('/api/groups/join', (req, res) => {
  const { code, userId } = req.body;
  const group = db.prepare('SELECT * FROM groups WHERE invite_code = ?').get(code?.toUpperCase());
  if (!group) return res.status(404).json({ error: 'invalid code' });
  try {
    db.prepare('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)').run(group.id, userId);
    db.prepare('INSERT INTO streaks (group_id, user_id) VALUES (?, ?)').run(group.id, userId);
  } catch (e) { /* already a member */ }
  res.json(group);
});

app.get('/api/groups/:userId', (req, res) => {
  const groups = db.prepare(`
    SELECT g.*, gm.joined_at FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    WHERE gm.user_id = ?
  `).all(req.params.userId);
  res.json(groups);
});

// ─── Leaderboard ───
app.get('/api/leaderboard/:groupId', (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.username, s.started_at, s.broken_at,
      (SELECT MAX(v.created_at) FROM violations v WHERE v.user_id = u.id AND v.group_id = ?) as last_violation
    FROM group_members gm
    JOIN users u ON gm.user_id = u.id
    LEFT JOIN streaks s ON s.user_id = u.id AND s.group_id = ?
    WHERE gm.group_id = ?
    ORDER BY s.broken_at IS NULL DESC, s.started_at ASC
  `).all(req.params.groupId, req.params.groupId, req.params.groupId);
  
  const sites = db.prepare('SELECT domain FROM tracked_sites WHERE group_id = ?').all(req.params.groupId);
  
  res.json({ members, sites: sites.map(s => s.domain) });
});

// ─── Violations (called by extension) ───
app.post('/api/violation', (req, res) => {
  const { userId, domain } = req.body;
  // Find all groups this user is in that track this domain
  const groups = db.prepare(`
    SELECT g.id, g.name FROM groups g
    JOIN group_members gm ON g.id = gm.group_id
    JOIN tracked_sites ts ON g.id = ts.group_id
    WHERE gm.user_id = ? AND ts.domain = ?
  `).all(userId, domain);
  
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  
  groups.forEach(group => {
    const vid = genId();
    db.prepare('INSERT INTO violations (id, group_id, user_id, domain, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)').run(vid, group.id, userId, domain);
    db.prepare('UPDATE streaks SET broken_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ?').run(group.id, userId);
    
    // Notify via socket
    io.to(group.id).emit('violation', {
      username: user?.username,
      domain,
      groupName: group.name,
      groupId: group.id
    });
  });
  
  res.json({ busted: groups.length > 0, groups: groups.length });
});

// ─── Reset streak ───
app.post('/api/reset-streak', (req, res) => {
  const { userId, groupId } = req.body;
  db.prepare('UPDATE streaks SET started_at = CURRENT_TIMESTAMP, broken_at = NULL WHERE group_id = ? AND user_id = ?').run(groupId, userId);
  res.json({ ok: true });
});

// ─── Socket.io for realtime ───
io.on('connection', (socket) => {
  socket.on('join-group', (groupId) => {
    socket.join(groupId);
  });
});

// ─── Serve app ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/app.html'));
});

const PORT = process.env.PORT || 3456;
http.listen(PORT, () => console.log(`Locked In running on port ${PORT}`));
