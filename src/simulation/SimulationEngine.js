/**
 * SimulationEngine — game loop for train movement, signals, collisions.
 * v2: Station dwell, priority routing, track validation, real collision stops,
 *     junction auto-switching, platform assignment.
 */
export class SimulationEngine {
  constructor(appState) {
    this.app = appState;
    this.playing = false;
    this.speed = 1;
    this._time = 0;
    this._collisionNotified = false;
    this._stationProximityMap = new Map(); // trainId → stationId (for dwell tracking)
  }

  get time() { return this._time; }

  play() {
    // ── Feature 7: Validate track connectivity before starting ──
    const errors = this._validateTrains();
    if (errors.length > 0) {
      for (const err of errors) {
        this.app.notify?.(err, 'error');
      }
      return false;
    }

    this.playing = true;
    for (const [, train] of this.app.trains) {
      if (train.currentTrackId && !train.collided) {
        train.running = true;
      }
    }
    return true;
  }

  pause() {
    this.playing = false;
    for (const [, train] of this.app.trains) {
      train.running = false;
    }
  }

  stop() {
    this.playing = false;
    for (const [, train] of this.app.trains) {
      train.running = false;
      train.t = 0;
      train.routeIndex = 0;
      train.dwelling = false;
      train.dwellTimeRemaining = 0;
      train.currentStopIndex = 0;
      if (train.route.length > 0) {
        train.currentTrackId = train.route[0];
      }
      // Reset collision
      if (train.collided) {
        train.resetCollision();
      }
      const track = this.app.tracks.get(train.currentTrackId);
      if (track) train.updatePosition(track);
    }

    // Release all station platforms
    for (const [, station] of this.app.stations) {
      for (const platform of station.platforms) {
        platform.occupied = false;
        platform.trainId = null;
      }
    }

    this._stationProximityMap.clear();
  }

  setSpeed(speed) {
    this.speed = Math.max(0.25, Math.min(4, speed));
  }

  /** Called every frame from the render loop */
  update(dt) {
    if (!this.playing) return;

    const adjustedDt = dt * this.speed;
    this._time += adjustedDt;

    // ── Auto-switch junctions based on approaching trains ──
    this._updateJunctions();

    // ── Move trains (with priority-aware bottleneck handling) ──
    this._moveTrains(adjustedDt);

    // ── Check station proximity for dwell ──
    this._checkStationStops();

    // ── Auto-manage signals ──
    this._updateSignals();

    // ── Check collisions ──
    this._checkCollisions();
  }

  // ─── Feature 7: Track Validation ───────────────────────────

  _validateTrains() {
    const errors = [];
    for (const [, train] of this.app.trains) {
      if (train.collided) continue;
      if (!train.currentTrackId) {
        errors.push(`⚠️ ${train.name}: No track assigned — can't run.`);
        continue;
      }
      const track = this.app.tracks.get(train.currentTrackId);
      if (!track) {
        errors.push(`⚠️ ${train.name}: Track not found — no track ahead, can't run.`);
        continue;
      }
      // Check if there's at least one connected track or a route
      if (train.route.length === 0) {
        const hasConnections = track.connections.start.length > 0 || track.connections.end.length > 0;
        if (!hasConnections && track.getLength() < 30) {
          errors.push(`⚠️ ${train.name}: No track ahead — place more track to create a route.`);
        }
      }
    }
    return errors;
  }

  // ─── Feature 5: Priority-aware Train Movement ──────────────

  _moveTrains(dt) {
    const trainArr = [...this.app.trains.values()];

    // Sort by priority (high first) for processing order
    trainArr.sort((a, b) => b.getPriorityWeight() - a.getPriorityWeight());

    // Track which track segments are currently occupied
    const occupiedTracks = new Map(); // trackId → {trainId, priority}

    // First pass: mark occupied tracks
    for (const train of trainArr) {
      if (train.running && train.currentTrackId && !train.collided) {
        const existing = occupiedTracks.get(train.currentTrackId);
        if (existing) {
          // Another train is on same track — lower priority slows down
          if (train.getPriorityWeight() < existing.priority) {
            train.speed = Math.max(10, train._baseSpeed * 0.3);
          }
        } else {
          occupiedTracks.set(train.currentTrackId, {
            trainId: train.id,
            priority: train.getPriorityWeight(),
          });
        }
      }
    }

    // Second pass: advance trains — pass junctions so they can be auto-switched
    for (const train of trainArr) {
      if (!train.collided) {
        train.advance(dt, this.app.tracks, this.app.junctions);
      }
    }
  }

  // ─── Feature 4: Station Stop Checking ──────────────────────

  _checkStationStops() {
    for (const [, train] of this.app.trains) {
      if (!train.running || train.collided || train.dwelling) continue;
      if (train.stationStops.length === 0) continue;
      if (train.currentStopIndex >= train.stationStops.length) continue;

      const nextStop = train.stationStops[train.currentStopIndex];
      const station = this.app.stations.get(nextStop?.stationId);
      if (!station) continue;

      // Check proximity to the target station
      const dx = train.x - station.x;
      const dy = train.y - station.y;
      const dist = Math.sqrt(dx*dx + dy*dy);

      if (dist < 40) {
        // ── Assign platform & offset position to prevent overlap ──
        const platformId = station.assignPlatform(train.id);
        if (platformId) {
          train.assignedPlatform = platformId;
          // Offset train position based on platform index
          const platIdx = station.platforms.findIndex(p => p.id === platformId);
          if (platIdx >= 0) {
            const track = this.app.tracks.get(station.trackId);
            if (track) {
              const normal = track.getNormalAt(station.trackT);
              const offsetDist = (platIdx - (station.platforms.length - 1) / 2) * 18;
              train.x = station.x + normal.x * offsetDist;
              train.y = station.y + normal.y * offsetDist;
            }
          }
        }

        // Start dwell (3 seconds fixed)
        train.startDwell(3);
        this.app.notify?.(`🚉 ${train.name} arrived at ${station.name} (${platformId || 'P?'})`, 'info');
      }
    }

    // Release platforms for trains that have left
    for (const [, station] of this.app.stations) {
      for (const platform of station.platforms) {
        if (!platform.occupied || !platform.trainId) continue;
        const train = this.app.trains.get(platform.trainId);
        if (!train || !train.dwelling) {
          if (train && !train.dwelling && train.assignedPlatform === platform.id) {
            station.releasePlatform(train.id);
            train.assignedPlatform = null;
          }
        }
      }
    }
  }

  // ─── Junction Auto-Switching ───────────────────────────────

  _updateJunctions() {
    if (!this.app.junctions) return;

    for (const [, junction] of this.app.junctions) {
      if (!junction.autoSwitch || junction.manualOverride) continue;

      // Find closest approaching train
      let closestTrain = null;
      let closestDist = 120; // detection range

      for (const [, train] of this.app.trains) {
        if (!train.running || train.collided) continue;
        const dx = train.x - junction.x;
        const dy = train.y - junction.y;
        const d = Math.sqrt(dx*dx + dy*dy);
        if (d < closestDist) {
          closestDist = d;
          closestTrain = train;
        }
      }

      if (closestTrain && closestTrain.route.length > 0) {
        // Figure out which tracks the train needs to connect through this junction
        const routeIdx = closestTrain.routeIndex;
        const currentTrackId = closestTrain.route[routeIdx];
        const nextTrackId = closestTrain.route[routeIdx + 1];

        if (currentTrackId && nextTrackId &&
            junction.connectedTrackIds.includes(currentTrackId) &&
            junction.connectedTrackIds.includes(nextTrackId)) {
          junction.setRouteForTrain(currentTrackId, nextTrackId);
        }
      }
    }
  }

  // ─── Signal Management ─────────────────────────────────────

  _updateSignals() {
    for (const [, signal] of this.app.signals) {
      // ── Feature 6: Skip manually overridden signals ──
      if (signal.manualOverride || !signal.autoManage || !signal.trackId) continue;

      let closestDist = Infinity;

      for (const [, train] of this.app.trains) {
        if (!train.running) continue;
        const dx = train.x - signal.x;
        const dy = train.y - signal.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < closestDist) {
          closestDist = dist;
        }
      }

      if (closestDist < 60) {
        signal.state = 'red';
      } else if (closestDist < 150) {
        signal.state = 'yellow';
      } else {
        signal.state = 'green';
      }
    }
  }

  // ─── Feature 9: Realistic Collision Handling ───────────────

  _checkCollisions() {
    const trainArr = [...this.app.trains.values()].filter(t => t.running && !t.collided);

    for (let i = 0; i < trainArr.length; i++) {
      for (let j = i + 1; j < trainArr.length; j++) {
        const a = trainArr[i];
        const b = trainArr[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (dist < 20) {
          // FULL STOP — both trains collide
          a.running = false;
          a.collided = true;
          a.collidedWith = b.id;
          a.speed = 0;

          b.running = false;
          b.collided = true;
          b.collidedWith = a.id;
          b.speed = 0;

          if (!this._collisionNotified) {
            this._collisionNotified = true;
            this.app.notify?.(
              `🚨 COLLISION! ${a.name} and ${b.name} have collided! Both trains stopped.`,
              'error'
            );
            setTimeout(() => { this._collisionNotified = false; }, 5000);
          }
        } else if (dist < 50) {
          // Proximity warning — slow down lower priority train
          const lowerPriority = a.getPriorityWeight() < b.getPriorityWeight() ? a : b;
          lowerPriority.speed = Math.max(10, lowerPriority._baseSpeed * 0.4);
        }
      }
    }
  }
}
