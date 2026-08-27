/**
 * main.js — RailForge Application Orchestrator
 * v2: Save/load, drag handles, junctions, route configurator,
 *     priority, signal toggle, validation, multi-platform, collision.
 */
import { Camera } from './engine/Camera.js';
import { Grid } from './engine/Grid.js';
import { Renderer } from './engine/Renderer.js';
import { InputHandler } from './engine/InputHandler.js';
import { Track, dist, canConnect } from './objects/Track.js';
import { Station } from './objects/Station.js';
import { Train, TRAIN_COLORS, PRIORITY_CONFIG } from './objects/Train.js';
import { Signal } from './objects/Signal.js';
import { Junction } from './objects/Junction.js';
import { SimulationEngine } from './simulation/SimulationEngine.js';
import { PathFinder } from './simulation/PathFinder.js';
import { SocketManager } from './network/SocketManager.js';

// ═══════════════════════════════════════════════════════════
//  App State
// ═══════════════════════════════════════════════════════════
const app = {
  tracks: new Map(),
  stations: new Map(),
  trains: new Map(),
  signals: new Map(),
  junctions: new Map(),

  activeTool: 'select',
  selectedElement: null,
  hoverElement: null,
  _hoveredHandle: null,
  _buildState: null,
  remoteUsers: new Map(),
  _undoStack: [],
  _maxUndo: 50,

  // Route configurator temp state
  _routeConfigTrain: null,
  _routeConfigStops: [],
};

// ═══════════════════════════════════════════════════════════
//  Initialize Modules
// ═══════════════════════════════════════════════════════════
const canvas = document.getElementById('main-canvas');
const camera = new Camera(canvas);
const grid = new Grid();
const renderer = new Renderer(canvas, camera, grid);
const input = new InputHandler(canvas, camera, grid, app);
const simulation = new SimulationEngine(app);
const pathFinder = new PathFinder();
const socket = new SocketManager(app);

let trainCounter = 1;
let stationCounter = 1;

// ═══════════════════════════════════════════════════════════
//  App Methods
// ═══════════════════════════════════════════════════════════

app.setTool = (tool) => {
  app.activeTool = tool;
  app._buildState = null;
  app.selectedElement = null;
  app._hoveredHandle = null;
  updateToolbarUI();
  updatePropertiesPanel();
  updatePreviewHint();
  const container = document.getElementById('canvas-container');
  container.className = `tool-${tool}`;
};

app.handleToolClick = (snapped, world) => {
  switch (app.activeTool) {
    case 'select': return handleSelectClick(world);
    case 'straight-track': return handleStraightTrackClick(snapped);
    case 'curved-track': return handleCurvedTrackClick(snapped);
    case 'siding-track': return handleSidingTrackClick(snapped);
    case 'station': return handleStationClick(snapped, world);
    case 'train': return handleTrainClick(world);
    case 'signal': return handleSignalClick(world);
    case 'junction': return handleJunctionClick(world);
    case 'eraser': return handleEraserClick(world);
  }
};

app.handleToolMove = (snapped, world) => {
  app.hoverElement = findElementAt(world);
  if (app.activeTool === 'straight-track' && app._buildState?.start) {
    app._buildState.previewEnd = snapped;
  }
  if (app.activeTool === 'siding-track' && app._buildState?.start) {
    app._buildState.previewEnd = snapped;
  }
  if (app.activeTool === 'curved-track' && app._buildState) {
    if (app._buildState.phase === 'end') {
      app._buildState.previewEnd = snapped;
    } else if (app._buildState.phase === 'control') {
      app._buildState.previewCP = snapped;
    }
  }
};

app.handleToolRelease = () => {};

app.handleToolDoubleClick = (world) => {
  if (app.activeTool === 'select') {
    const elem = findElementAt(world);
    if (elem?.type === 'station') {
      const station = app.stations.get(elem.id);
      if (station) {
        const name = prompt('Station name:', station.name);
        if (name) {
          station.name = name;
          sendOp('update-station', station.toJSON());
          updatePropertiesPanel();
        }
      }
    }
  }
};

app.cancelCurrentAction = () => {
  app._buildState = null;
  updatePreviewHint();
};

app.deleteSelected = () => {
  if (!app.selectedElement) return;
  const { type, id } = app.selectedElement;

  switch (type) {
    case 'track':
      app.tracks.delete(id);
      sendOp('remove-track', { id });
      for (const [sid, s] of app.stations) {
        if (s.trackId === id) { app.stations.delete(sid); sendOp('remove-station', { id: sid }); }
      }
      break;
    case 'station':
      app.stations.delete(id);
      sendOp('remove-station', { id });
      break;
    case 'train':
      app.trains.delete(id);
      sendOp('remove-train', { id });
      break;
    case 'signal':
      app.signals.delete(id);
      sendOp('remove-signal', { id });
      break;
    case 'junction':
      app.junctions.delete(id);
      sendOp('remove-junction', { id });
      break;
  }
  app.selectedElement = null;
  updatePropertiesPanel();
};

app.toggleSimulation = () => {
  if (simulation.playing) {
    simulation.pause();
    socket.sendSimControl({ playing: false });
  } else {
    const ok = simulation.play();
    if (ok) socket.sendSimControl({ playing: true, speed: simulation.speed });
  }
  updateSimButtons();
};

app.undo = () => {
  if (app._undoStack.length === 0) return;
  const action = app._undoStack.pop();
  if (action.type === 'add-track') {
    app.tracks.delete(action.data.id);
    sendOp('remove-track', { id: action.data.id });
  }
};

app.broadcastCursor = (world) => {
  socket.sendCursor({ x: world.x, y: world.y });
};

app.notify = (message, type = 'info') => {
  showNotification(message, type);
};

// v2: Save room
app.saveRoom = async () => {
  try {
    const saveBtn = document.getElementById('save-room-btn');
    saveBtn?.classList.add('saving');
    await socket.saveRoom();
    setTimeout(() => saveBtn?.classList.remove('saving'), 600);
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'warning');
  }
};

// v2: Track handle drag end
app.onTrackHandleDragEnd = (track) => {
  sendOp('update-track', track.toJSON());
  showNotification('Track updated', 'success');
};

// ── Remote operation handlers ──
app.applyRemoteOperation = (op) => {
  const { type, data } = op;
  switch (type) {
    case 'add-track':
    case 'update-track':
      app.tracks.set(data.id, new Track(data));
      break;
    case 'remove-track':
      app.tracks.delete(data.id);
      break;
    case 'add-station':
    case 'update-station':
      app.stations.set(data.id, new Station(data));
      break;
    case 'remove-station':
      app.stations.delete(data.id);
      break;
    case 'add-train':
    case 'update-train':
      app.trains.set(data.id, new Train(data));
      break;
    case 'remove-train':
      app.trains.delete(data.id);
      break;
    case 'add-signal':
    case 'update-signal':
      app.signals.set(data.id, new Signal(data));
      break;
    case 'remove-signal':
      app.signals.delete(data.id);
      break;
    case 'add-junction':
    case 'update-junction':
      app.junctions.set(data.id, new Junction(data));
      break;
    case 'remove-junction':
      app.junctions.delete(data.id);
      break;
  }
};

app.updateRemoteCursor = (data) => {
  const user = app.remoteUsers.get(data.id);
  if (user) user.cursor = { x: data.x, y: data.y };
};

app.addRemoteUser = (data) => {
  app.remoteUsers.set(data.id, { name: data.name, color: data.color, cursor: null });
  updateUsersUI();
};

app.removeRemoteUser = (id) => {
  const user = app.remoteUsers.get(id);
  if (user) app.notify?.(`${user.name} left the room`, 'info');
  app.remoteUsers.delete(id);
  updateUsersUI();
};

app.applyRemoteSimControl = (data) => {
  if (data.playing !== undefined) {
    if (data.playing) simulation.play(); else simulation.pause();
  }
  if (data.speed !== undefined) {
    simulation.setSpeed(data.speed);
    document.getElementById('sim-speed-slider').value = data.speed;
    document.getElementById('sim-speed-value').textContent = `${data.speed}×`;
  }
  updateSimButtons();
};

// ═══════════════════════════════════════════════════════════
//  Tool Handlers
// ═══════════════════════════════════════════════════════════

function handleSelectClick(world) {
  const elem = findElementAt(world);

  // v2: Signal toggle on click
  if (elem?.type === 'signal') {
    const signal = app.signals.get(elem.id);
    if (signal && app.selectedElement?.type === 'signal' && app.selectedElement.id === elem.id) {
      // Already selected — toggle it
      signal.toggleManual();
      sendOp('update-signal', signal.toJSON());
      showNotification(`Signal set to ${signal.state.toUpperCase()} (manual override)`, 'info');
      updatePropertiesPanel();
      return;
    }
  }

  // v2: Junction toggle on click
  if (elem?.type === 'junction') {
    const junction = app.junctions.get(elem.id);
    if (junction && app.selectedElement?.type === 'junction' && app.selectedElement.id === elem.id) {
      junction.toggleRoute();
      sendOp('update-junction', junction.toJSON());
      showNotification('Junction route toggled', 'info');
      updatePropertiesPanel();
      return;
    }
  }

  app.selectedElement = elem;
  updatePropertiesPanel();
}

function handleStraightTrackClick(snapped) {
  if (!app._buildState) {
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState = { start: snapPt || snapped, previewEnd: snapped };
    updatePreviewHint('Click to place end point • Right-click to cancel');
  } else {
    const snapPt = findNearEndpoint(snapped, 25);
    const end = snapPt || snapped;
    const start = app._buildState.start;
    if (dist(start, end) < 10) return;

    const track = new Track({ type: 'straight', start: { ...start }, end: { ...end } });
    autoConnect(track);
    autoCreateJunction(track);
    app.tracks.set(track.id, track);
    sendOp('add-track', track.toJSON());
    pushUndo({ type: 'add-track', data: track.toJSON() });
    app._buildState = null;
    updatePreviewHint();
    app.notify('Track placed', 'success');
  }
}

function handleCurvedTrackClick(snapped) {
  if (!app._buildState) {
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState = { phase: 'end', start: snapPt || snapped, previewEnd: snapped };
    updatePreviewHint('Click to place end point');
  } else if (app._buildState.phase === 'end') {
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState.end = snapPt || snapped;
    app._buildState.phase = 'control';
    app._buildState.previewCP = snapped;
    updatePreviewHint('Click to set curve control point');
  } else if (app._buildState.phase === 'control') {
    const { start, end } = app._buildState;
    const cp = snapped;
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const dx = cp.x - midX;
    const dy = cp.y - midY;

    const track = new Track({
      type: 'curve', start: { ...start }, end: { ...end },
      cp1: { x: start.x + dx, y: start.y + dy },
      cp2: { x: end.x + dx, y: end.y + dy },
    });

    autoConnect(track);
    autoCreateJunction(track);
    app.tracks.set(track.id, track);
    sendOp('add-track', track.toJSON());
    pushUndo({ type: 'add-track', data: track.toJSON() });
    app._buildState = null;
    updatePreviewHint();
    app.notify('Curved track placed', 'success');
  }
}

// v2: Siding track tool
function handleSidingTrackClick(snapped) {
  if (!app._buildState) {
    const snapPt = findNearEndpoint(snapped, 25);
    app._buildState = { start: snapPt || snapped, previewEnd: snapped };
    updatePreviewHint('Click to place siding end point • Right-click to cancel');
  } else {
    const snapPt = findNearEndpoint(snapped, 25);
    const end = snapPt || snapped;
    const start = app._buildState.start;
    if (dist(start, end) < 10) return;

    const track = new Track({
      type: 'straight', trackClass: 'siding',
      start: { ...start }, end: { ...end },
    });
    autoConnect(track);
    autoCreateJunction(track);
    app.tracks.set(track.id, track);
    sendOp('add-track', track.toJSON());
    pushUndo({ type: 'add-track', data: track.toJSON() });
    app._buildState = null;
    updatePreviewHint();
    app.notify('Siding track placed', 'success');
  }
}

function handleStationClick(snapped, world) {
  let bestTrack = null;
  let bestDist = 50;
  let bestT = 0;

  for (const [, track] of app.tracks) {
    const t = track.closestT(world.x, world.y);
    const p = track.getPointAt(t);
    const d = dist(world, p);
    if (d < bestDist) { bestDist = d; bestTrack = track; bestT = t; }
  }

  if (!bestTrack) {
    app.notify('Place station near a track segment', 'warning');
    return;
  }

  const station = new Station({
    name: `Station ${stationCounter++}`,
    trackId: bestTrack.id, trackT: bestT, color: '#4e8cff',
  });
  station.updateFromTrack(bestTrack);
  app.stations.set(station.id, station);
  sendOp('add-station', station.toJSON());
  app.notify(`${station.name} placed`, 'success');
}

function handleTrainClick(world) {
  let bestTrack = null;
  let bestDist = 50;
  let bestT = 0;

  for (const [, track] of app.tracks) {
    const t = track.closestT(world.x, world.y);
    const p = track.getPointAt(t);
    const d = dist(world, p);
    if (d < bestDist) { bestDist = d; bestTrack = track; bestT = t; }
  }

  if (!bestTrack) {
    app.notify('Place train near a track segment', 'warning');
    return;
  }

  // Place train with an empty route — user must configure stops via "Configure Route".
  // This prevents the train from following a random BFS order instead of the timetable.
  const train = new Train({
    name: `Train ${trainCounter++}`,
    currentTrackId: bestTrack.id, t: bestT, speed: 60,
    route: [],
    routeIndex: 0,
    color: TRAIN_COLORS[(trainCounter - 1) % TRAIN_COLORS.length],
  });
  train.updatePosition(bestTrack);
  app.trains.set(train.id, train);
  sendOp('add-train', train.toJSON());
  app.notify(`${train.name} placed — select it and click Configure Route to set stations`, 'info');
}

function handleSignalClick(world) {
  let bestTrack = null;
  let bestDist = 50;
  let bestT = 0;

  for (const [, track] of app.tracks) {
    const t = track.closestT(world.x, world.y);
    const p = track.getPointAt(t);
    const d = dist(world, p);
    if (d < bestDist) { bestDist = d; bestTrack = track; bestT = t; }
  }

  if (!bestTrack) {
    app.notify('Place signal near a track segment', 'warning');
    return;
  }

  const signal = new Signal({ trackId: bestTrack.id, trackT: bestT, state: 'green' });
  signal.updateFromTrack(bestTrack);
  app.signals.set(signal.id, signal);
  sendOp('add-signal', signal.toJSON());
  app.notify('Signal placed', 'success');
}

// v3: Junction placement — detect endpoint AND midpoint crossings
function handleJunctionClick(world) {
  const nearbyTracks = [];
  for (const [, track] of app.tracks) {
    // Check endpoints
    if (dist(world, track.start) < 25) {
      nearbyTracks.push({ trackId: track.id, point: track.start });
      continue;
    }
    if (dist(world, track.end) < 25) {
      nearbyTracks.push({ trackId: track.id, point: track.end });
      continue;
    }
    // Check midpoint/closest point on track
    if (track.hitTest(world.x, world.y, 20)) {
      const t = track.closestT(world.x, world.y);
      const p = track.getPointAt(t);
      nearbyTracks.push({ trackId: track.id, point: p });
    }
  }

  if (nearbyTracks.length < 2) {
    app.notify('Place junction where 2+ tracks meet or cross', 'warning');
    return;
  }

  // Calculate average position
  const avgX = nearbyTracks.reduce((s, e) => s + e.point.x, 0) / nearbyTracks.length;
  const avgY = nearbyTracks.reduce((s, e) => s + e.point.y, 0) / nearbyTracks.length;

  // Check if junction already exists here
  for (const [, j] of app.junctions) {
    if (dist({ x: avgX, y: avgY }, { x: j.x, y: j.y }) < 25) {
      app.notify('Junction already exists here', 'warning');
      return;
    }
  }

  const junction = new Junction({
    x: avgX, y: avgY,
    connectedTrackIds: nearbyTracks.map(e => e.trackId),
  });

  app.junctions.set(junction.id, junction);
  sendOp('add-junction', junction.toJSON());
  app.notify(`Junction placed (${nearbyTracks.length} tracks connected)`, 'success');
}

function handleEraserClick(world) {
  const elem = findElementAt(world);
  if (elem) {
    app.selectedElement = elem;
    app.deleteSelected();
    app.notify('Element deleted', 'info');
  }
}

// ═══════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════

function findElementAt(world) {
  for (const [id, train] of app.trains) {
    if (train.hitTest(world.x, world.y)) return { type: 'train', id };
  }
  for (const [id, station] of app.stations) {
    if (station.hitTest(world.x, world.y)) return { type: 'station', id };
  }
  for (const [id, signal] of app.signals) {
    if (signal.hitTest(world.x, world.y)) return { type: 'signal', id };
  }
  for (const [id, junction] of app.junctions) {
    if (junction.hitTest(world.x, world.y)) return { type: 'junction', id };
  }
  for (const [id, track] of app.tracks) {
    if (track.hitTest(world.x, world.y, 12)) return { type: 'track', id };
  }
  return null;
}

function findNearEndpoint(point, threshold) {
  for (const [, track] of app.tracks) {
    if (dist(point, track.start) < threshold) return { ...track.start };
    if (dist(point, track.end) < threshold) return { ...track.end };
  }
  return null;
}

function autoConnect(newTrack) {
  for (const [, track] of app.tracks) {
    if (track.id === newTrack.id) continue;
    if (canConnect(newTrack.start, track.start)) {
      newTrack.connections.start.push(track.id);
      track.connections.start.push(newTrack.id);
    }
    if (canConnect(newTrack.start, track.end)) {
      newTrack.connections.start.push(track.id);
      track.connections.end.push(newTrack.id);
    }
    if (canConnect(newTrack.end, track.start)) {
      newTrack.connections.end.push(track.id);
      track.connections.start.push(newTrack.id);
    }
    if (canConnect(newTrack.end, track.end)) {
      newTrack.connections.end.push(track.id);
      track.connections.end.push(newTrack.id);
    }
  }
}

// v3: Auto-create junction when 3+ tracks meet at a point OR cross midpoints
function autoCreateJunction(newTrack) {
  // Check endpoints
  for (const endpoint of [newTrack.start, newTrack.end]) {
    const meetingTracks = [];
    for (const [, track] of app.tracks) {
      if (dist(endpoint, track.start) < 20 || dist(endpoint, track.end) < 20) {
        meetingTracks.push(track.id);
      }
    }
    if (meetingTracks.length >= 3) {
      let exists = false;
      for (const [, j] of app.junctions) {
        if (dist(endpoint, { x: j.x, y: j.y }) < 25) { exists = true; break; }
      }
      if (!exists) {
        const junction = new Junction({
          x: endpoint.x, y: endpoint.y,
          connectedTrackIds: meetingTracks,
        });
        app.junctions.set(junction.id, junction);
        sendOp('add-junction', junction.toJSON());
        app.notify('Junction auto-created', 'info');
      }
    }
  }

  // Check if new track crosses any existing tracks at midpoints
  for (const [, existingTrack] of app.tracks) {
    if (existingTrack.id === newTrack.id) continue;
    // Sample both tracks and check for intersections
    const steps = 20;
    for (let i = 1; i < steps; i++) {
      const pNew = newTrack.getPointAt(i / steps);
      for (let j = 1; j < steps; j++) {
        const pExist = existingTrack.getPointAt(j / steps);
        if (dist(pNew, pExist) < 15) {
          // Crossing detected at midpoints!
          const crossPt = { x: (pNew.x + pExist.x) / 2, y: (pNew.y + pExist.y) / 2 };
          let exists = false;
          for (const [, jn] of app.junctions) {
            if (dist(crossPt, { x: jn.x, y: jn.y }) < 25) { exists = true; break; }
          }
          if (!exists) {
            const junction = new Junction({
              x: crossPt.x, y: crossPt.y,
              connectedTrackIds: [newTrack.id, existingTrack.id],
            });
            app.junctions.set(junction.id, junction);
            sendOp('add-junction', junction.toJSON());
            app.notify('Junction auto-created (track crossing)', 'info');
          }
          return; // One crossing per track pair is enough
        }
      }
    }
  }
}

function sendOp(type, data) {
  socket.sendOperation(type, data);
}

function pushUndo(action) {
  app._undoStack.push(action);
  if (app._undoStack.length > app._maxUndo) app._undoStack.shift();
}

// ═══════════════════════════════════════════════════════════
//  Rendering Callbacks
// ═══════════════════════════════════════════════════════════

// Draw tracks
renderer.onDraw((ctx, cam) => {
  for (const [id, track] of app.tracks) {
    let state = 'default';
    if (app.selectedElement?.type === 'track' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'track' && app.hoverElement.id === id) state = 'hover';
    track.render(ctx, cam, state);

    // v2: Render drag handles for selected track
    if (state === 'selected') {
      track.renderHandles(ctx, cam, app._hoveredHandle);
    }
  }

  // Build preview
  if ((app.activeTool === 'straight-track' || app.activeTool === 'siding-track') && app._buildState?.start && app._buildState?.previewEnd) {
    const preview = new Track({
      type: 'straight', start: app._buildState.start, end: app._buildState.previewEnd,
      trackClass: app.activeTool === 'siding-track' ? 'siding' : 'mainline',
    });
    preview.renderPreview(ctx, cam);
  }

  if (app.activeTool === 'curved-track' && app._buildState) {
    const bs = app._buildState;
    if (bs.phase === 'end' && bs.previewEnd) {
      const preview = new Track({ type: 'straight', start: bs.start, end: bs.previewEnd });
      preview.renderPreview(ctx, cam);
    } else if (bs.phase === 'control' && bs.previewCP) {
      const midX = (bs.start.x + bs.end.x) / 2;
      const midY = (bs.start.y + bs.end.y) / 2;
      const dx = bs.previewCP.x - midX;
      const dy = bs.previewCP.y - midY;
      const preview = new Track({
        type: 'curve', start: bs.start, end: bs.end,
        cp1: { x: bs.start.x + dx, y: bs.start.y + dy },
        cp2: { x: bs.end.x + dx, y: bs.end.y + dy },
      });
      preview.renderPreview(ctx, cam);
    }
  }
});

// Draw junctions
renderer.onDraw((ctx, cam) => {
  for (const [id, junction] of app.junctions) {
    let state = 'default';
    if (app.selectedElement?.type === 'junction' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'junction' && app.hoverElement.id === id) state = 'hover';
    junction.render(ctx, cam, state);
  }
});

// Draw stations
renderer.onDraw((ctx, cam) => {
  for (const [id, station] of app.stations) {
    let state = 'default';
    if (app.selectedElement?.type === 'station' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'station' && app.hoverElement.id === id) state = 'hover';
    station.render(ctx, cam, state);
  }
});

// Draw signals
renderer.onDraw((ctx, cam) => {
  for (const [id, signal] of app.signals) {
    let state = 'default';
    if (app.selectedElement?.type === 'signal' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'signal' && app.hoverElement.id === id) state = 'hover';
    signal.render(ctx, cam, state);
  }
});

// Draw trains
renderer.onDraw((ctx, cam, dt) => {
  simulation.update(dt);
  for (const [id, train] of app.trains) {
    let state = 'default';
    if (app.selectedElement?.type === 'train' && app.selectedElement.id === id) state = 'selected';
    else if (app.hoverElement?.type === 'train' && app.hoverElement.id === id) state = 'hover';
    train.render(ctx, cam, state, simulation.time);
  }
});

// Draw remote cursors
renderer.onDraw((ctx, cam) => {
  for (const [, user] of app.remoteUsers) {
    if (!user.cursor) continue;
    const { x, y } = user.cursor;
    ctx.save();
    ctx.fillStyle = user.color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 4, y + 14);
    ctx.lineTo(x + 9, y + 9);
    ctx.closePath();
    ctx.fill();
    const fontSize = 10 / cam.zoom;
    ctx.font = `500 ${fontSize}px Inter, sans-serif`;
    const metrics = ctx.measureText(user.name);
    const tagW = metrics.width + 8 / cam.zoom;
    const tagH = fontSize + 4 / cam.zoom;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath();
    ctx.roundRect(x + 12 / cam.zoom, y + 12 / cam.zoom, tagW, tagH, 3 / cam.zoom);
    ctx.fill();
    ctx.fillStyle = user.color;
    ctx.textBaseline = 'top';
    ctx.fillText(user.name, x + 12 / cam.zoom + 4 / cam.zoom, y + 12 / cam.zoom + 2 / cam.zoom);
    ctx.restore();
  }
});

// ═══════════════════════════════════════════════════════════
//  Minimap
// ═══════════════════════════════════════════════════════════
const minimapCanvas = document.getElementById('minimap-canvas');
const minimapCtx = minimapCanvas.getContext('2d');

function renderMinimap() {
  const mw = minimapCanvas.width;
  const mh = minimapCanvas.height;
  minimapCtx.clearRect(0, 0, mw, mh);
  minimapCtx.fillStyle = '#0a0e1a';
  minimapCtx.fillRect(0, 0, mw, mh);

  if (app.tracks.size === 0) { requestAnimationFrame(renderMinimap); return; }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, track] of app.tracks) {
    for (const p of [track.start, track.end]) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }

  const pad = 40;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const worldW = maxX - minX || 1;
  const worldH = maxY - minY || 1;
  const scale = Math.min(mw / worldW, mh / worldH);
  const offX = (mw - worldW * scale) / 2;
  const offY = (mh - worldH * scale) / 2;

  const toMini = (wx, wy) => ({
    x: (wx - minX) * scale + offX,
    y: (wy - minY) * scale + offY,
  });

  minimapCtx.strokeStyle = '#4e6080';
  minimapCtx.lineWidth = 1.5;
  for (const [, track] of app.tracks) {
    const a = toMini(track.start.x, track.start.y);
    const b = toMini(track.end.x, track.end.y);
    minimapCtx.beginPath();
    minimapCtx.moveTo(a.x, a.y);
    minimapCtx.lineTo(b.x, b.y);
    minimapCtx.stroke();
  }

  minimapCtx.fillStyle = '#4e8cff';
  for (const [, station] of app.stations) {
    const p = toMini(station.x, station.y);
    minimapCtx.beginPath();
    minimapCtx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  for (const [, train] of app.trains) {
    const p = toMini(train.x, train.y);
    minimapCtx.fillStyle = train.collided ? '#ef4444' : train.color;
    minimapCtx.beginPath();
    minimapCtx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  const vb = camera.getVisibleBounds();
  const vTL = toMini(vb.minX, vb.minY);
  const vBR = toMini(vb.maxX, vb.maxY);
  minimapCtx.strokeStyle = 'rgba(78, 140, 255, 0.5)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(vTL.x, vTL.y, vBR.x - vTL.x, vBR.y - vTL.y);
  requestAnimationFrame(renderMinimap);
}
renderMinimap();

// ═══════════════════════════════════════════════════════════
//  UI Functions
// ═══════════════════════════════════════════════════════════

function updateToolbarUI() {
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === app.activeTool);
  });
}

function updatePreviewHint(text) {
  const hint = document.getElementById('track-preview-hint');
  if (text) {
    hint.textContent = text;
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    const defaults = {
      'straight-track': 'Click to place start point',
      'curved-track': 'Click to place start point',
      'siding-track': 'Click to place siding start point',
      'station': 'Click near a track to place station',
      'train': 'Click on a track to place train',
      'signal': 'Click near a track to place signal',
      'junction': 'Click where 2+ tracks meet to place junction',
      'eraser': 'Click on an element to delete it',
    };
    if (defaults[app.activeTool]) {
      hint.textContent = defaults[app.activeTool];
      hint.classList.remove('hidden');
    }
  }
}

function updateSimButtons() {
  const playBtn = document.getElementById('sim-play-btn');
  const pauseBtn = document.getElementById('sim-pause-btn');
  if (simulation.playing) {
    playBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
  } else {
    playBtn.classList.remove('hidden');
    pauseBtn.classList.add('hidden');
  }
}

function updatePropertiesPanel() {
  const panel = document.getElementById('properties-panel');
  const title = document.getElementById('properties-title');
  const content = document.getElementById('properties-content');

  if (!app.selectedElement) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const { type, id } = app.selectedElement;

  switch (type) {
    case 'track': {
      const track = app.tracks.get(id);
      if (!track) return;
      title.textContent = 'Track';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Type</span>
          <input class="prop-input" value="${track.type}" readonly />
        </div>
        <div class="prop-field">
          <span class="prop-label">Class</span>
          <select class="prop-input" id="prop-track-class">
            <option value="mainline" ${track.trackClass === 'mainline' ? 'selected' : ''}>Mainline</option>
            <option value="siding" ${track.trackClass === 'siding' ? 'selected' : ''}>Siding</option>
            <option value="crossover" ${track.trackClass === 'crossover' ? 'selected' : ''}>Crossover</option>
          </select>
        </div>
        <div class="prop-field">
          <span class="prop-label">Length</span>
          <input class="prop-input" value="${Math.round(track.getLength())} units" readonly />
        </div>
        <div class="prop-field">
          <span class="prop-label">Speed Limit</span>
          <input class="prop-input" type="number" id="prop-speed-limit" value="${track.speedLimit}" min="10" max="300" />
        </div>
        <div class="prop-info-row">
          <span class="material-icons-round">drag_handle</span>
          <span>Drag the blue handles to reshape</span>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-track">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete Track
          </button>
        </div>
      `;
      document.getElementById('prop-track-class')?.addEventListener('change', (e) => {
        track.trackClass = e.target.value;
        sendOp('update-track', track.toJSON());
      });
      document.getElementById('prop-speed-limit')?.addEventListener('change', (e) => {
        track.speedLimit = parseInt(e.target.value) || 100;
        sendOp('update-track', track.toJSON());
      });
      document.getElementById('prop-delete-track')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'station': {
      const station = app.stations.get(id);
      if (!station) return;
      title.textContent = 'Station';
      const occupiedCount = station.getOccupiedCount();
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Name</span>
          <input class="prop-input" id="prop-station-name" value="${station.name}" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Platforms</span>
          <input class="prop-input" type="number" id="prop-platform-count" value="${station.platformCount}" min="1" max="8" />
        </div>
        ${occupiedCount > 0 ? `<div class="prop-info-row"><span class="material-icons-round" style="color:#ef4444">train</span><span>${occupiedCount}/${station.platforms.length} platforms occupied</span></div>` : ''}
        <div class="prop-field">
          <span class="prop-label">Color</span>
          <div class="prop-color">
            ${['#4e8cff','#7c5cfc','#22c55e','#eab308','#ef4444','#ec4899','#06b6d4','#f97316'].map(c =>
              `<div class="color-swatch ${station.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}"></div>`
            ).join('')}
          </div>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-station">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-station-name')?.addEventListener('change', (e) => {
        station.name = e.target.value;
        sendOp('update-station', station.toJSON());
      });
      document.getElementById('prop-platform-count')?.addEventListener('change', (e) => {
        station.setPlatformCount(parseInt(e.target.value) || 2);
        sendOp('update-station', station.toJSON());
        updatePropertiesPanel();
      });
      content.querySelectorAll('.color-swatch').forEach(sw => {
        sw.addEventListener('click', () => {
          station.color = sw.dataset.color;
          sendOp('update-station', station.toJSON());
          updatePropertiesPanel();
        });
      });
      document.getElementById('prop-delete-station')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'train': {
      const train = app.trains.get(id);
      if (!train) return;
      title.textContent = 'Train';
      const pConfig = PRIORITY_CONFIG[train.priority];
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Name</span>
          <input class="prop-input" id="prop-train-name" value="${train.name}" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Speed</span>
          <input class="prop-input" type="number" id="prop-train-speed" value="${train.speed}" min="10" max="200" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Carriages</span>
          <input class="prop-input" type="number" id="prop-train-carriages" value="${train.carriages}" min="0" max="10" />
        </div>
        <div class="prop-field">
          <span class="prop-label">Priority</span>
          <select class="prop-input" id="prop-train-priority">
            <option value="high" ${train.priority === 'high' ? 'selected' : ''}>⚡ Express (High)</option>
            <option value="medium" ${train.priority === 'medium' ? 'selected' : ''}>● Regular (Medium)</option>
            <option value="low" ${train.priority === 'low' ? 'selected' : ''}>▽ Local (Low)</option>
          </select>
        </div>
        <div class="prop-field">
          <span class="prop-label">Color</span>
          <div class="prop-color">
            ${TRAIN_COLORS.map(c =>
              `<div class="color-swatch ${train.color === c ? 'active' : ''}" style="background:${c}" data-color="${c}"></div>`
            ).join('')}
          </div>
        </div>
        <div class="prop-section-title">Routing</div>
        <div class="prop-field">
          <span class="prop-label">Route (${train.route.length} segments)</span>
          <button class="btn btn-sm btn-secondary" id="prop-auto-route" style="margin-top:4px">
            <span class="material-icons-round" style="font-size:14px">route</span>Auto-route all connected
          </button>
        </div>
        <div class="prop-field">
          <span class="prop-label">Station Stops (${train.stationStops.length})</span>
          <button class="btn btn-sm btn-primary" id="prop-configure-route" style="margin-top:4px">
            <span class="material-icons-round" style="font-size:14px">edit_road</span>Configure Route
          </button>
        </div>
        ${train.collided ? `
          <div class="prop-section-title" style="color:#ef4444">⚠ COLLISION</div>
          <div class="prop-info-row">
            <span class="material-icons-round" style="color:#ef4444">warning</span>
            <span style="color:#ef4444">Train has collided and stopped</span>
          </div>
          <button class="btn btn-sm btn-secondary" id="prop-reset-collision" style="margin-top:6px;border-color:#ef4444;color:#ef4444">
            <span class="material-icons-round" style="font-size:14px">restart_alt</span>Reset Collision
          </button>
        ` : ''}
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-train">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-train-name')?.addEventListener('change', (e) => {
        train.name = e.target.value;
        sendOp('update-train', train.toJSON());
      });
      document.getElementById('prop-train-speed')?.addEventListener('change', (e) => {
        train.speed = parseInt(e.target.value) || 60;
        train._baseSpeed = train.speed;
        sendOp('update-train', train.toJSON());
      });
      document.getElementById('prop-train-carriages')?.addEventListener('change', (e) => {
        train.carriages = parseInt(e.target.value) || 2;
        sendOp('update-train', train.toJSON());
      });
      document.getElementById('prop-train-priority')?.addEventListener('change', (e) => {
        train.priority = e.target.value;
        sendOp('update-train', train.toJSON());
        updatePropertiesPanel();
      });
      content.querySelectorAll('.color-swatch').forEach(sw => {
        sw.addEventListener('click', () => {
          train.color = sw.dataset.color;
          sendOp('update-train', train.toJSON());
          updatePropertiesPanel();
        });
      });
      document.getElementById('prop-auto-route')?.addEventListener('click', () => {
        const connected = pathFinder.getConnectedTracks(train.currentTrackId, app.tracks);
        train.route = connected;
        train.routeIndex = connected.indexOf(train.currentTrackId);
        sendOp('update-train', train.toJSON());
        updatePropertiesPanel();
        app.notify(`Route updated: ${connected.length} segments`, 'success');
      });
      document.getElementById('prop-configure-route')?.addEventListener('click', () => {
        openRouteConfigurator(train);
      });
      document.getElementById('prop-reset-collision')?.addEventListener('click', () => {
        train.resetCollision();
        sendOp('update-train', train.toJSON());
        updatePropertiesPanel();
        app.notify(`${train.name} collision reset`, 'success');
      });
      document.getElementById('prop-delete-train')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'signal': {
      const signal = app.signals.get(id);
      if (!signal) return;
      title.textContent = 'Signal';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">State</span>
          <select class="prop-input" id="prop-signal-state">
            <option value="green" ${signal.state === 'green' ? 'selected' : ''}>🟢 Green</option>
            <option value="yellow" ${signal.state === 'yellow' ? 'selected' : ''}>🟡 Yellow</option>
            <option value="red" ${signal.state === 'red' ? 'selected' : ''}>🔴 Red</option>
          </select>
        </div>
        ${signal.manualOverride ? `
          <div class="prop-info-row">
            <span class="material-icons-round" style="color:#eab308">lock</span>
            <span style="color:#eab308">Manual override active</span>
          </div>
          <button class="btn btn-sm btn-secondary" id="prop-clear-override" style="margin-top:4px">
            <span class="material-icons-round" style="font-size:14px">lock_open</span>Clear Override (Auto)
          </button>
        ` : `
          <div class="prop-field">
            <span class="prop-label">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" id="prop-signal-auto" ${signal.autoManage ? 'checked' : ''} />
                Auto-manage (changes with trains)
              </label>
            </span>
          </div>
        `}
        <div class="prop-info-row">
          <span class="material-icons-round">touch_app</span>
          <span>Click signal again to toggle Red ↔ Green</span>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-signal">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-signal-state')?.addEventListener('change', (e) => {
        signal.state = e.target.value;
        signal.manualOverride = true;
        signal.autoManage = false;
        sendOp('update-signal', signal.toJSON());
        updatePropertiesPanel();
      });
      document.getElementById('prop-signal-auto')?.addEventListener('change', (e) => {
        signal.autoManage = e.target.checked;
        sendOp('update-signal', signal.toJSON());
      });
      document.getElementById('prop-clear-override')?.addEventListener('click', () => {
        signal.clearOverride();
        sendOp('update-signal', signal.toJSON());
        updatePropertiesPanel();
        app.notify('Signal returned to auto mode', 'success');
      });
      document.getElementById('prop-delete-signal')?.addEventListener('click', () => app.deleteSelected());
      break;
    }

    case 'junction': {
      const junction = app.junctions.get(id);
      if (!junction) return;
      title.textContent = 'Junction';
      content.innerHTML = `
        <div class="prop-field">
          <span class="prop-label">Connected Tracks</span>
          <input class="prop-input" value="${junction.connectedTrackIds.length} tracks" readonly />
        </div>
        <div class="prop-field">
          <span class="prop-label">Mode</span>
          <select class="prop-input" id="prop-junction-mode">
            <option value="auto" ${junction.autoSwitch && !junction.manualOverride ? 'selected' : ''}>Auto (route-based)</option>
            <option value="manual" ${junction.manualOverride ? 'selected' : ''}>Manual override</option>
          </select>
        </div>
        ${junction.manualOverride ? `
          <div class="prop-info-row">
            <span class="material-icons-round" style="color:#eab308">lock</span>
            <span style="color:#eab308">Manual override — click junction to toggle</span>
          </div>
        ` : `
          <div class="prop-info-row">
            <span class="material-icons-round">auto_mode</span>
            <span>Auto-switches based on approaching train's route</span>
          </div>
        `}
        <div style="margin-top:12px">
          <button class="btn btn-sm btn-secondary" id="prop-delete-junction">
            <span class="material-icons-round" style="font-size:14px">delete</span>Delete
          </button>
        </div>
      `;
      document.getElementById('prop-junction-mode')?.addEventListener('change', (e) => {
        if (e.target.value === 'auto') {
          junction.autoSwitch = true;
          junction.manualOverride = false;
        } else {
          junction.autoSwitch = false;
          junction.manualOverride = true;
        }
        sendOp('update-junction', junction.toJSON());
        updatePropertiesPanel();
      });
      document.getElementById('prop-delete-junction')?.addEventListener('click', () => app.deleteSelected());
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  Route Configurator
// ═══════════════════════════════════════════════════════════

function openRouteConfigurator(train) {
  app._routeConfigTrain = train;
  app._routeConfigStops = train.stationStops.map(s => ({ ...s }));

  const modal = document.getElementById('route-modal');
  modal.classList.remove('hidden');
  renderRouteStops();
  populateStationDropdown();
}

function renderRouteStops() {
  const list = document.getElementById('route-station-list');
  list.innerHTML = '';

  app._routeConfigStops.forEach((stop, idx) => {
    if (idx > 0) {
      const arrow = document.createElement('div');
      arrow.className = 'route-arrow';
      arrow.textContent = '↓';
      list.appendChild(arrow);
    }

    const item = document.createElement('div');
    item.className = 'route-station-item';
    item.draggable = true;
    item.dataset.index = idx;
    item.innerHTML = `
      <span class="route-index">${idx + 1}</span>
      <span class="route-name">${stop.stationName}</span>
      <button class="route-remove" title="Remove stop">
        <span class="material-icons-round">close</span>
      </button>
    `;

    item.querySelector('.route-remove').addEventListener('click', () => {
      app._routeConfigStops.splice(idx, 1);
      renderRouteStops();
    });

    // Drag and drop
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', idx);
      item.style.opacity = '0.5';
    });
    item.addEventListener('dragend', () => { item.style.opacity = '1'; });
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.style.borderColor = '#4e8cff'; });
    item.addEventListener('dragleave', () => { item.style.borderColor = ''; });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.style.borderColor = '';
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = idx;
      if (fromIdx !== toIdx) {
        const [moved] = app._routeConfigStops.splice(fromIdx, 1);
        app._routeConfigStops.splice(toIdx, 0, moved);
        renderRouteStops();
      }
    });

    list.appendChild(item);
  });
}

function populateStationDropdown() {
  const select = document.getElementById('route-add-station');
  select.innerHTML = '<option value="">+ Add station stop...</option>';
  for (const [id, station] of app.stations) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = station.name;
    select.appendChild(opt);
  }
}

// Route modal events
document.getElementById('route-add-station')?.addEventListener('change', (e) => {
  const stationId = e.target.value;
  if (!stationId) return;
  const station = app.stations.get(stationId);
  if (!station) return;
  app._routeConfigStops.push({ stationId, stationName: station.name });
  e.target.value = '';
  renderRouteStops();
});

document.getElementById('route-save-btn')?.addEventListener('click', () => {
  const train = app._routeConfigTrain;
  if (!train) return;

  // ── Require at least 2 stops to define a route ──
  if (app._routeConfigStops.length < 2) {
    app.notify('Add at least 2 station stops to define a route', 'warning');
    return;
  }

  train.stationStops = app._routeConfigStops.map(s => ({ ...s }));
  train.currentStopIndex = 0;

  // ── Build route via PathFinder (v5 — connection-aware) ──
  const { route, segmentMap, errors } = pathFinder.buildStationRoute(
    train.stationStops,
    app.stations,
    app.tracks
  );

  // ── Show per-leg errors and abort if any leg has no track path ──
  if (errors.length > 0) {
    for (const err of errors) {
      app.notify(err, 'error');
    }
    // Keep the route modal open so the user can fix their layout
    return;
  }

  if (route.length === 0) {
    app.notify(
      '⚠ No connected path found. Ensure tracks between all stations are laid and connected.',
      'warning'
    );
    return;
  }

  // ── Trim route to start at the first station's host track ──
  // This ensures routeIndex is always 0 at the start and advance() steps
  // through the route array correctly without skipping segments.
  const firstStop    = train.stationStops[0];
  const firstStation = app.stations.get(firstStop.stationId);

  let finalRoute   = route;
  let startTrackId = route[0];
  let startT       = 0;

  if (firstStation?.trackId) {
    const idx = route.indexOf(firstStation.trackId);
    if (idx >= 0) {
      finalRoute   = route.slice(idx);      // discard segments before first station
      startTrackId = firstStation.trackId;
      startT       = firstStation.trackT;   // place train exactly at station position
    }
  }

  // ── Apply to train ──
  train.route           = finalRoute;
  train.routeIndex      = 0;              // always 0 after trimming
  train.stationSegmentMap = Object.fromEntries(segmentMap);
  train.currentTrackId  = startTrackId;
  train.t               = startT;
  train.direction       = 1;
  train.running         = false;          // user presses Play to start
  train.currentStopIndex = 0;

  const startTrack = app.tracks.get(startTrackId);
  if (startTrack) train.updatePosition(startTrack);

  sendOp('update-train', train.toJSON());
  document.getElementById('route-modal').classList.add('hidden');
  updatePropertiesPanel();
  app.notify(
    `🗺 Route set: ${finalRoute.length} track segments, ${train.stationStops.length} stops. Press ▶ Play to start.`,
    'success'
  );
});

document.getElementById('route-clear-btn')?.addEventListener('click', () => {
  app._routeConfigStops = [];
  renderRouteStops();
});

document.getElementById('close-route-modal')?.addEventListener('click', () => {
  document.getElementById('route-modal').classList.add('hidden');
});

document.getElementById('route-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'route-modal') {
    document.getElementById('route-modal').classList.add('hidden');
  }
});

// ═══════════════════════════════════════════════════════════
//  Other UI
// ═══════════════════════════════════════════════════════════

function updateUsersUI() {
  const container = document.getElementById('connected-users');
  container.innerHTML = '';
  const selfName = document.getElementById('user-name-input')?.value || 'You';
  const selfDiv = document.createElement('div');
  selfDiv.className = 'user-avatar';
  selfDiv.style.background = socket.userColor || '#4e8cff';
  selfDiv.setAttribute('data-name', selfName + ' (You)');
  selfDiv.textContent = selfName.charAt(0).toUpperCase();
  container.appendChild(selfDiv);

  for (const [, user] of app.remoteUsers) {
    const div = document.createElement('div');
    div.className = 'user-avatar';
    div.style.background = user.color;
    div.setAttribute('data-name', user.name);
    div.textContent = user.name.charAt(0).toUpperCase();
    container.appendChild(div);
  }
}

function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications');
  const iconMap = { info: 'info', success: 'check_circle', warning: 'warning', error: 'error' };
  const notif = document.createElement('div');
  notif.className = `notification ${type}`;
  notif.innerHTML = `<span class="material-icons-round">${iconMap[type] || 'info'}</span> ${message}`;
  container.appendChild(notif);
  setTimeout(() => {
    notif.classList.add('out');
    setTimeout(() => notif.remove(), 300);
  }, type === 'error' ? 5000 : 2500);
}

// ═══════════════════════════════════════════════════════════
//  UI Event Bindings
// ═══════════════════════════════════════════════════════════

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => app.setTool(btn.dataset.tool));
});

document.getElementById('sim-play-btn')?.addEventListener('click', () => app.toggleSimulation());
document.getElementById('sim-pause-btn')?.addEventListener('click', () => app.toggleSimulation());
document.getElementById('sim-stop-btn')?.addEventListener('click', () => {
  simulation.stop();
  socket.sendSimControl({ playing: false });
  updateSimButtons();
});

document.getElementById('sim-speed-slider')?.addEventListener('input', (e) => {
  const speed = parseFloat(e.target.value);
  simulation.setSpeed(speed);
  document.getElementById('sim-speed-value').textContent = `${speed}×`;
  socket.sendSimControl({ speed });
});

document.getElementById('zoom-in-btn')?.addEventListener('click', () => {
  camera.zoomAt(canvas.width / 2, canvas.height / 2, 1.2);
  document.getElementById('zoom-level').textContent = camera.getZoomPercent();
});
document.getElementById('zoom-out-btn')?.addEventListener('click', () => {
  camera.zoomAt(canvas.width / 2, canvas.height / 2, 1 / 1.2);
  document.getElementById('zoom-level').textContent = camera.getZoomPercent();
});
document.getElementById('zoom-fit-btn')?.addEventListener('click', () => {
  if (app.tracks.size === 0) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [, t] of app.tracks) {
    for (const p of [t.start, t.end]) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  camera.fitBounds(minX, minY, maxX, maxY);
  document.getElementById('zoom-level').textContent = camera.getZoomPercent();
});

document.getElementById('toggle-grid-btn')?.addEventListener('click', (e) => {
  grid.visible = !grid.visible;
  e.currentTarget.classList.toggle('active', grid.visible);
});
document.getElementById('toggle-snap-btn')?.addEventListener('click', (e) => {
  grid.snapEnabled = !grid.snapEnabled;
  e.currentTarget.classList.toggle('active', grid.snapEnabled);
});
document.getElementById('close-properties')?.addEventListener('click', () => {
  app.selectedElement = null;
  document.getElementById('properties-panel').classList.add('hidden');
});

document.getElementById('help-btn')?.addEventListener('click', () => {
  document.getElementById('help-modal').classList.remove('hidden');
});
document.getElementById('close-help')?.addEventListener('click', () => {
  document.getElementById('help-modal').classList.add('hidden');
});
document.getElementById('help-modal')?.addEventListener('click', (e) => {
  if (e.target.id === 'help-modal') document.getElementById('help-modal').classList.add('hidden');
});

document.getElementById('copy-room-code')?.addEventListener('click', () => {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    showNotification('Link copied! Share it to collaborate.', 'success');
  });
});

// Save button
document.getElementById('save-room-btn')?.addEventListener('click', () => app.saveRoom());

// ═══════════════════════════════════════════════════════════
//  Single Workspace — No Rooms, No Login
// ═══════════════════════════════════════════════════════════

function loadWorkspaceState(state) {
  for (const [id, data] of Object.entries(state.tracks || {})) {
    app.tracks.set(id, new Track(data));
  }
  for (const [id, data] of Object.entries(state.stations || {})) {
    const s = new Station(data);
    const track = app.tracks.get(s.trackId);
    if (track) s.updateFromTrack(track);
    app.stations.set(id, s);
  }
  for (const [id, data] of Object.entries(state.trains || {})) {
    const t = new Train(data);
    const track = app.tracks.get(t.currentTrackId);
    if (track) t.updatePosition(track);
    app.trains.set(id, t);
  }
  for (const [id, data] of Object.entries(state.signals || {})) {
    const sig = new Signal(data);
    const track = app.tracks.get(sig.trackId);
    if (track) sig.updateFromTrack(track);
    app.signals.set(id, sig);
  }
  for (const [id, data] of Object.entries(state.junctions || {})) {
    app.junctions.set(id, new Junction(data));
  }
  for (const [uid, userData] of Object.entries(state.users || {})) {
    if (uid !== socket.userId) {
      app.remoteUsers.set(uid, { name: userData.name, color: userData.color, cursor: userData.cursor });
    }
  }
  if (state.simulation) {
    if (state.simulation.playing) simulation.play();
    simulation.setSpeed(state.simulation.speed || 1);
    document.getElementById('sim-speed-slider').value = simulation.speed;
    document.getElementById('sim-speed-value').textContent = `${simulation.speed}×`;
    updateSimButtons();
  }
  trainCounter = app.trains.size + 1;
  stationCounter = app.stations.size + 1;
}

// Expose loadWorkspaceState to the app so SocketManager can call it
app.loadWorkspaceState = (data) => {
  loadWorkspaceState(data);
  updateUsersUI();
  const trackCount = app.tracks.size;
  if (trackCount > 0) {
    showNotification(`🚂 Workspace loaded (${trackCount} tracks, ${app.trains.size} trains)`, 'success');
  } else {
    showNotification('🚂 Welcome to RailForge! Start building your railway.', 'info');
  }
};

// Save workspace (not room)
app.saveRoom = async () => {
  try {
    const saveBtn = document.getElementById('save-room-btn');
    saveBtn?.classList.add('saving');
    await socket.saveWorkspace();
    setTimeout(() => saveBtn?.classList.remove('saving'), 600);
  } catch (err) {
    showNotification('Save failed: ' + err.message, 'warning');
  }
};

/** Connect to server — no login, no room codes */
async function connectToWorkspace() {
  // Hide room modal immediately
  const modal = document.getElementById('room-modal');
  modal?.classList.add('hidden');

  try {
    await socket.connect();

    // Set a display name
    const name = localStorage.getItem('railforge-username');
    if (name) socket.setName(name);

    updateUsersUI();
  } catch (err) {
    showNotification('Server unavailable — running offline.', 'warning');
    updateUsersUI();
  }
}

// ── Minimap toggle ──
let minimapVisible = true;
document.getElementById('toggle-minimap-btn')?.addEventListener('click', (e) => {
  minimapVisible = !minimapVisible;
  const minimap = document.getElementById('minimap');
  minimap.classList.toggle('minimap-hidden', !minimapVisible);
  e.currentTarget.classList.toggle('active', minimapVisible);
});

// ═══════════════════════════════════════════════════════════
//  Initial Setup
// ═══════════════════════════════════════════════════════════
app.setTool('select');
updateUsersUI();
connectToWorkspace();

console.log('%c🚂 RailForge Loaded — Single Workspace', 'color: #4e8cff; font-size: 16px; font-weight: bold;');
