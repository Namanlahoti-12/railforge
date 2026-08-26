import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// Serve production build
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Single Global Workspace ─────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const SAVE_FILE = path.join(DATA_DIR, 'workspace.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// The one and only workspace state
const workspace = {
  tracks: {},
  stations: {},
  trains: {},
  signals: {},
  junctions: {},
  simulation: { playing: false, speed: 1 },
  users: {},
  _dirty: false,
};

// ─── Load saved state on startup ─────────────────────────────
function loadWorkspace() {
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = fs.readFileSync(SAVE_FILE, 'utf-8');
      const saved = JSON.parse(raw);
      workspace.tracks = saved.tracks || {};
      workspace.stations = saved.stations || {};
      workspace.trains = saved.trains || {};
      workspace.signals = saved.signals || {};
      workspace.junctions = saved.junctions || {};
      if (saved.simulation) {
        workspace.simulation = { ...saved.simulation, playing: false };
      }
      console.log('  📂 Workspace loaded from disk');
    }
  } catch (err) {
    console.error('  ✗ Failed to load workspace:', err.message);
  }
}

function saveWorkspace() {
  try {
    const saveData = {
      savedAt: new Date().toISOString(),
      tracks: workspace.tracks,
      stations: workspace.stations,
      trains: workspace.trains,
      signals: workspace.signals,
      junctions: workspace.junctions,
      simulation: workspace.simulation,
    };
    fs.writeFileSync(SAVE_FILE, JSON.stringify(saveData, null, 2), 'utf-8');
    workspace._dirty = false;
    return true;
  } catch (err) {
    console.error('  ✗ Failed to save workspace:', err.message);
    return false;
  }
}

// Load on startup
loadWorkspace();

// Auto-save every 10 seconds if dirty
setInterval(() => {
  if (workspace._dirty) {
    saveWorkspace();
    console.log(`  💾 Auto-saved (${Object.keys(workspace.tracks).length} tracks, ${Object.keys(workspace.trains).length} trains)`);
  }
}, 10000);

// ─── REST API ────────────────────────────────────────────────

app.get('/api/workspace', (req, res) => {
  res.json({
    tracks: workspace.tracks,
    stations: workspace.stations,
    trains: workspace.trains,
    signals: workspace.signals,
    junctions: workspace.junctions,
    simulation: workspace.simulation,
    userCount: Object.keys(workspace.users).length,
  });
});

app.post('/api/workspace/save', (req, res) => {
  const ok = saveWorkspace();
  res.json({ success: ok, savedAt: new Date().toISOString() });
});

// ─── Socket.IO ───────────────────────────────────────────────
io.on('connection', (socket) => {
  const userName = `User-${socket.id.slice(0, 4)}`;
  const userColor = `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`;

  console.log(`✦ ${userName} connected`);

  // Send current workspace state immediately
  workspace.users[socket.id] = { name: userName, color: userColor, cursor: null };

  socket.emit('workspace-state', {
    tracks: workspace.tracks,
    stations: workspace.stations,
    trains: workspace.trains,
    signals: workspace.signals,
    junctions: workspace.junctions,
    simulation: workspace.simulation,
    users: workspace.users,
    userId: socket.id,
    userColor,
    userName,
  });

  // Notify others
  socket.broadcast.emit('user-joined', {
    id: socket.id,
    name: userName,
    color: userColor,
  });

  // ── Set display name ──
  socket.on('set-name', (name) => {
    if (workspace.users[socket.id]) {
      workspace.users[socket.id].name = name;
    }
    socket.broadcast.emit('user-renamed', { id: socket.id, name });
  });

  // ── Operations ──
  socket.on('operation', (op) => {
    applyOperation(workspace, op);
    workspace._dirty = true;
    socket.broadcast.emit('operation', { ...op, _from: socket.id });
  });

  // ── Cursor ──
  socket.on('cursor-move', (cursor) => {
    if (workspace.users[socket.id]) {
      workspace.users[socket.id].cursor = cursor;
    }
    socket.broadcast.emit('cursor-move', { id: socket.id, ...cursor });
  });

  // ── Simulation control ──
  socket.on('simulation-control', (data) => {
    Object.assign(workspace.simulation, data);
    workspace._dirty = true;
    socket.broadcast.emit('simulation-control', data);
  });

  // ── Explicit save ──
  socket.on('save-workspace', (callback) => {
    const ok = saveWorkspace();
    callback?.({ success: ok, savedAt: new Date().toISOString() });
    io.emit('workspace-saved', { savedAt: new Date().toISOString() });
    console.log(`  💾 Workspace saved by ${userName}`);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`✧ ${userName} disconnected`);
    delete workspace.users[socket.id];
    socket.broadcast.emit('user-left', { id: socket.id });

    // Auto-save when last user leaves
    if (Object.keys(workspace.users).length === 0) {
      saveWorkspace();
      console.log('  💾 Workspace auto-saved (last user left)');
    }
  });
});

// ─── Apply Operations ────────────────────────────────────────
function applyOperation(state, op) {
  const { type, data } = op;
  const collections = {
    track: state.tracks,
    station: state.stations,
    train: state.trains,
    signal: state.signals,
    junction: state.junctions,
  };

  const [action, entity] = type.split('-');
  const collection = collections[entity];
  if (!collection) return;

  switch (action) {
    case 'add':
    case 'update':
      collection[data.id] = { ...collection[data.id], ...data };
      break;
    case 'remove':
      delete collection[data.id];
      break;
  }
}

// ─── SPA Fallback ────────────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) res.status(404).send('Not found — run `npm run build` first');
  });
});

// ─── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚂 RailForge server on http://localhost:${PORT}`);
  console.log(`  📂 Workspace: ${SAVE_FILE}\n`);
});
