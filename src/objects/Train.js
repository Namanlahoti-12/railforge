/**
 * Train — data model and rendering for a train moving along tracks.
 *
 * v6: Directional RouteStep-based movement.
 *
 * Route format changed from string[] (track IDs) to RouteStep[]:
 *   { trackId, fromNode, toNode, fromT, toT, direction }
 *
 * advance() reads direction, fromT, toT from the current step.
 * The train NEVER guesses direction from nearest endpoint.
 *
 * Backward compatibility: if route contains plain strings (legacy saves),
 * the train runs to the end of its current track and stops cleanly.
 */

const TRAIN_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

const PRIORITY_CONFIG = {
  high:   { label: 'Express', badge: '⚡', color: '#ef4444', weight: 3 },
  medium: { label: 'Regular', badge: '●',  color: '#eab308', weight: 2 },
  low:    { label: 'Local',   badge: '▽',  color: '#22c55e', weight: 1 },
};

export class Train {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.name = data.name || 'Train';
    this.color = data.color || TRAIN_COLORS[Math.floor(Math.random() * TRAIN_COLORS.length)];
    this.currentTrackId = data.currentTrackId || null;
    this.t = data.t ?? 0;               // parametric position on current track [0,1]
    this.speed = data.speed ?? 60;       // world units per second
    this._baseSpeed = data._baseSpeed ?? data.speed ?? 60;
    this.direction = data.direction ?? 1; // 1 = forward (t↑), -1 = reverse (t↓)
    this.route = data.route || [];        // RouteStep[] — see PathFinder v7
    this.routeIndex = data.routeIndex ?? 0;
    this.running = data.running ?? false;
    this.carriages = data.carriages ?? 2;
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.angle = data.angle ?? 0;

    // ── Station Routing ──
    this.stationStops = data.stationStops || [];  // [{stationId, stationName}]
    this.currentStopIndex = data.currentStopIndex ?? 0;

    // ── Priority ──
    this.priority = data.priority || 'medium'; // 'high' | 'medium' | 'low'

    // ── Collision ──
    this.collided = data.collided ?? false;
    this.collidedWith = data.collidedWith || null;

    // ── Dwell timer ──
    this.dwelling = data.dwelling ?? false;
    this.dwellTimeRemaining = data.dwellTimeRemaining ?? 0;

    // ── Platform assignment ──
    this.assignedPlatform = data.assignedPlatform ?? null;

    // ── Station→RouteIndex map (debug hint; proximity detection is authoritative) ──
    this.stationSegmentMap = data.stationSegmentMap || {};

    // ── Destination / Terminus state ──
    this.destinationReached = data.destinationReached ?? false;

    // Headlight flicker
    this._headlightPhase = Math.random() * Math.PI * 2;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, color: this.color,
      currentTrackId: this.currentTrackId,
      t: this.t, speed: this.speed, _baseSpeed: this._baseSpeed,
      direction: this.direction,
      // Deep-copy each RouteStep (plain object); handles both new and legacy formats
      route: this.route.map(s => (s && typeof s === 'object') ? { ...s } : s),
      routeIndex: this.routeIndex,
      running: this.running, carriages: this.carriages,
      x: this.x, y: this.y, angle: this.angle,
      stationStops: this.stationStops.map(s => ({ ...s })),
      currentStopIndex: this.currentStopIndex,
      priority: this.priority,
      collided: this.collided,
      collidedWith: this.collidedWith,
      dwelling: this.dwelling,
      dwellTimeRemaining: this.dwellTimeRemaining,
      assignedPlatform: this.assignedPlatform,
      stationSegmentMap: { ...this.stationSegmentMap },
      destinationReached: this.destinationReached,
    };
  }

  /** Get priority weight for comparisons */
  getPriorityWeight() {
    return PRIORITY_CONFIG[this.priority]?.weight || 2;
  }

  /** Reset collision state */
  resetCollision() {
    this.collided = false;
    this.collidedWith = null;
    this.speed = this._baseSpeed;
    this.running = false;
    this.destinationReached = false;
  }

  /** Update train world position from current track + t */
  updatePosition(track) {
    if (!track) return;
    const p = track.getPointAt(this.t);
    const tan = track.getTangentAt(this.t);
    this.x = p.x;
    this.y = p.y;
    this.angle = Math.atan2(tan.y, tan.x);
    if (this.direction === -1) this.angle += Math.PI;
  }

  /**
   * Resolve the current route element as a RouteStep object.
   * Returns null if no route, route is exhausted, or element is a legacy string.
   * @returns {RouteStep|null}
   */
  _currentStep() {
    const raw = this.route.length > 0 ? this.route[this.routeIndex] : null;
    return (raw && typeof raw === 'object' && 'toT' in raw) ? raw : null;
  }

  /**
   * Advance the train by delta time.
   *
   * With RouteStep routes (new format):
   *   • Reads direction, fromT, toT from the current step — no guessing.
   *   • On step completion, loads next step with its exact fromT and direction.
   *   • Switches junctions between steps via _switchJunctionForTransition().
   *
   * With legacy string routes or no route:
   *   • Runs to the end of the current track and stops (safe fallback).
   *
   * @param {number} dt          elapsed seconds
   * @param {Map}    tracks      all Track objects
   * @param {Map}    [junctions] all Junction objects (optional)
   */
  advance(dt, tracks, junctions = null) {
    if (!this.running || !this.currentTrackId || this.collided || this.destinationReached) return;

    // ── Dwell at station ──
    if (this.dwelling) {
      this.dwellTimeRemaining -= dt;
      if (this.dwellTimeRemaining <= 0) {
        this.dwelling = false;
        this.dwellTimeRemaining = 0;
        this.currentStopIndex++;
        // If this was the last station stop, stop permanently at the destination!
        if (this.stationStops.length > 0 && this.currentStopIndex >= this.stationStops.length) {
          this.running = false;
          this.destinationReached = true;
          return;
        }
      }
      return;
    }

    const step = this._currentStep();

    if (step) {
      // ════════════════════════════════════════
      //  DIRECTIONAL ROUTESTEP PATH (new format)
      // ════════════════════════════════════════
      //
      // Direction is authoritative from the step — NO nearest-endpoint guessing.
      // The train moves exactly from step.fromT to step.toT.

      this.direction = step.direction; // always in sync with the route step

      const track = tracks.get(step.trackId);
      if (!track) return;

      const trackLen = track.getLength();
      if (trackLen === 0) return;

      const dtParam = (this.speed * dt) / trackLen;
      this.t += dtParam * step.direction;

      // Step complete?
      const stepDone = step.direction === 1
        ? this.t >= step.toT
        : this.t <= step.toT;

      if (stepDone) {
        this.t = step.toT;           // clamp exactly to target
        this.updatePosition(track);

        const prevTrackId = step.trackId;
        this.routeIndex++;
        const nextRaw  = this.route[this.routeIndex];
        const nextStep = (nextRaw && typeof nextRaw === 'object' && 'toT' in nextRaw)
          ? nextRaw : null;

        if (nextStep) {
          // Switch junction so the physical switch aligns with the route
          if (junctions) {
            this._switchJunctionForTransition(junctions, prevTrackId, nextStep.trackId);
          }

          // Load next step — exact fromT and direction, no guessing
          this.currentTrackId = nextStep.trackId;
          this.t              = nextStep.fromT;
          this.direction      = nextStep.direction;

          const nextTrack = tracks.get(this.currentTrackId);
          if (nextTrack) this.updatePosition(nextTrack);
        } else {
          // End of route — stop cleanly at final destination
          this.running = false;
          this.destinationReached = true;
        }
        return;
      }

      this.updatePosition(track);

    } else {
      // If the train already had a multi-step route and completed it, do NOT run down arbitrary tracks
      if (this.route.length > 0 && this.routeIndex >= this.route.length) {
        this.running = false;
        this.destinationReached = true;
        return;
      }
      // Users with old saves should reconfigure their route to get
      // the full directional behaviour.

      const track = tracks.get(this.currentTrackId);
      if (!track) return;

      const trackLen = track.getLength();
      if (trackLen === 0) return;

      const dtParam = (this.speed * dt) / trackLen;
      this.t += dtParam * this.direction;

      if (this.t >= 1) {
        this.t = 1;
        this.updatePosition(track);
        // Attempt to follow legacy string route entries if present
        if (this.route.length > 0 && this.routeIndex < this.route.length - 1) {
          const exitPt = track.end;
          const prevId = this.currentTrackId;
          this.routeIndex++;
          const nextId = typeof this.route[this.routeIndex] === 'string'
            ? this.route[this.routeIndex] : null;
          if (nextId) {
            if (junctions) this._switchJunctionForTransition(junctions, prevId, nextId);
            this.currentTrackId = nextId;
            const nextTrack = tracks.get(nextId);
            if (nextTrack) {
              const dS = Math.hypot(exitPt.x - nextTrack.start.x, exitPt.y - nextTrack.start.y);
              const dE = Math.hypot(exitPt.x - nextTrack.end.x,   exitPt.y - nextTrack.end.y);
              this.t         = dS <= dE ? 0 : 1;
              this.direction = dS <= dE ? 1 : -1;
              this.updatePosition(nextTrack);
            }
          } else { this.running = false; }
        } else { this.running = false; }
        return;
      }

      if (this.t <= 0) {
        this.t = 0;
        this.updatePosition(track);
        if (this.route.length > 0 && this.routeIndex < this.route.length - 1) {
          const exitPt = track.start;
          const prevId = this.currentTrackId;
          this.routeIndex++;
          const nextId = typeof this.route[this.routeIndex] === 'string'
            ? this.route[this.routeIndex] : null;
          if (nextId) {
            if (junctions) this._switchJunctionForTransition(junctions, prevId, nextId);
            this.currentTrackId = nextId;
            const nextTrack = tracks.get(nextId);
            if (nextTrack) {
              const dS = Math.hypot(exitPt.x - nextTrack.start.x, exitPt.y - nextTrack.start.y);
              const dE = Math.hypot(exitPt.x - nextTrack.end.x,   exitPt.y - nextTrack.end.y);
              this.t         = dS <= dE ? 0 : 1;
              this.direction = dS <= dE ? 1 : -1;
              this.updatePosition(nextTrack);
            }
          } else { this.running = false; }
        } else { this.running = false; }
        return;
      }

      this.updatePosition(track);
    }
  }

  /**
   * Find the junction governing the transition fromTrackId → toTrackId
   * and set its activeRoute. Makes the junction physically switch to the
   * correct branch so the visual state matches the train's route.
   * Skips junctions in manual-override mode.
   */
  _switchJunctionForTransition(junctions, fromTrackId, toTrackId) {
    if (fromTrackId === toTrackId) return; // same track (e.g. dwell segment) — no switch needed
    for (const [, junction] of junctions) {
      if (junction.manualOverride) continue;
      if (
        junction.connectedTrackIds.includes(fromTrackId) &&
        junction.connectedTrackIds.includes(toTrackId)
      ) {
        junction.activeRoute = [fromTrackId, toTrackId];
        return;
      }
    }
  }

  /** Start dwelling at a station */
  startDwell(dwellSeconds = 3) {
    this.dwelling = true;
    this.dwellTimeRemaining = dwellSeconds;
  }

  /**
   * Debug helper — log the full route to the browser console.
   * Usage: (from DevTools) window.app.trains.values().next().value.debugRoute()
   */
  debugRoute() {
    if (!this.route.length) {
      console.log(`%c${this.name}: No route configured`, 'color: orange; font-weight: bold');
      return;
    }
    const first = this.route[0];
    const isRouteStep = first && typeof first === 'object' && 'toT' in first;
    if (!isRouteStep) {
      console.log(`%c${this.name}: Legacy string route (${this.route.length} tracks) — reconfigure route to enable directional tracking`, 'color: gray');
      return;
    }
    console.group(`%c${this.name} ROUTE — ${this.route.length} steps`, 'color: #4e8cff; font-weight: bold');
    for (let i = 0; i < this.route.length; i++) {
      const s   = this.route[i];
      const dir = s.direction === 1 ? '→ fwd' : '← rev';
      const cur = i === this.routeIndex ? ' ◄ CURRENT' : '';
      console.log(
        `[${i}] %c${s.trackId.slice(0, 8)}…%c  t: ${s.fromT.toFixed(3)} → ${s.toT.toFixed(3)}  ${dir}${cur}`,
        'color: #22c55e', 'color: inherit'
      );
    }
    console.groupEnd();
  }

  /** Hit-test */
  hitTest(wx, wy, threshold = 20) {
    const dx = wx - this.x;
    const dy = wy - this.y;
    return dx*dx + dy*dy < threshold * threshold;
  }

  /** Render the train */
  render(ctx, camera, state = 'default', time = 0) {
    const zoom = camera.zoom;
    const isSelected = state === 'selected';
    const isHover = state === 'hover';

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    const locoW = 28;
    const locoH = 12;
    const carriageW = 22;
    const carriageH = 10;
    const gap = 3;

    // ── Collision indicator ──
    if (this.collided) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 6);
      ctx.shadowColor = `rgba(239, 68, 68, ${pulse})`;
      ctx.shadowBlur = 20 / zoom;

      ctx.strokeStyle = `rgba(239, 68, 68, ${0.6 + pulse * 0.4})`;
      ctx.lineWidth = 3 / zoom;
      const totalW = locoW + this.carriages * (carriageW + gap) + 10;
      ctx.beginPath();
      ctx.roundRect(-totalW / 2, -locoH / 2 - 4, totalW, locoH + 8, 6);
      ctx.stroke();
    }

    // ── Selection glow ──
    if ((isSelected || isHover) && !this.collided) {
      ctx.shadowColor = isSelected ? 'rgba(78, 140, 255, 0.6)' : 'rgba(124, 92, 252, 0.4)';
      ctx.shadowBlur = 12 / zoom;
    }

    // ── Locomotive ──
    const r = 3;
    ctx.fillStyle = this.color;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.roundRect(-locoW/2, -locoH/2, locoW, locoH, r);
    ctx.fill();
    ctx.stroke();

    // Front stripe
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath();
    ctx.roundRect(locoW/2 - 6, -locoH/2 + 1, 5, locoH - 2, [0, r, r, 0]);
    ctx.fill();

    // Headlight
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    const hlBright = 0.6 + 0.4 * Math.sin(time * 2 + this._headlightPhase);
    if (this.running && !this.collided) {
      ctx.fillStyle = `rgba(255, 240, 180, ${hlBright})`;
      ctx.shadowColor = `rgba(255, 240, 180, ${hlBright * 0.6})`;
      ctx.shadowBlur = 8 / zoom;
      ctx.beginPath();
      ctx.arc(locoW/2, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }

    // Windshield
    ctx.fillStyle = 'rgba(100, 180, 255, 0.3)';
    ctx.fillRect(locoW/2 - 10, -locoH/2 + 2, 3, locoH - 4);

    // ── Carriages ──
    for (let i = 0; i < this.carriages; i++) {
      const cx = -locoW/2 - gap - (carriageW + gap) * i - carriageW / 2;
      ctx.fillStyle = this._darken(this.color, 0.15);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 0.8 / zoom;
      ctx.beginPath();
      ctx.roundRect(cx - carriageW/2, -carriageH/2, carriageW, carriageH, 2);
      ctx.fill();
      ctx.stroke();

      // Windows
      ctx.fillStyle = 'rgba(100, 180, 255, 0.25)';
      const winCount = 3;
      const winW = 3;
      const winGap = (carriageW - 4 - winCount * winW) / (winCount + 1);
      for (let w = 0; w < winCount; w++) {
        const wx = cx - carriageW/2 + 2 + winGap * (w + 1) + winW * w;
        ctx.fillRect(wx, -carriageH/2 + 2, winW, carriageH - 4);
      }

      // Coupler
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();
      ctx.moveTo(cx + carriageW/2, 0);
      ctx.lineTo(cx + carriageW/2 + gap, 0);
      ctx.stroke();
    }

    // ── Wheels ──
    ctx.fillStyle = '#444';
    const wheelR = 2;
    const wheelPositions = [-locoW/2 + 4, -4, 4, locoW/2 - 4];
    for (const wx of wheelPositions) {
      for (const wy of [-locoH/2 - 0.5, locoH/2 + 0.5]) {
        ctx.beginPath();
        ctx.arc(wx, wy, wheelR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Labels (un-rotate for readable text) ──
    ctx.rotate(-this.angle);

    const fontSize = Math.max(8, 10 / Math.sqrt(zoom));

    // Train name
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = isSelected ? '#4e8cff' : '#c0c8d8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.name, 0, -locoH/2 - 10);

    // Priority badge
    const pConfig = PRIORITY_CONFIG[this.priority];
    if (pConfig && zoom > 0.4) {
      const badgeFontSize = Math.max(6, 8 / Math.sqrt(zoom));
      ctx.font = `700 ${badgeFontSize}px Inter, sans-serif`;
      ctx.fillStyle = pConfig.color;
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'left';
      const nameWidth = ctx.measureText(this.name).width;
      ctx.fillText(pConfig.badge, nameWidth / 2 + 4, -locoH/2 - 10);
    }

    // Dwelling indicator
    if (this.dwelling) {
      const dwellFontSize = Math.max(7, 9 / Math.sqrt(zoom));
      ctx.font = `500 ${dwellFontSize}px Inter, sans-serif`;
      ctx.fillStyle = '#eab308';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`⏱ ${Math.ceil(this.dwellTimeRemaining)}s`, 0, locoH/2 + 6);
    }

    // Destination Reached badge
    if (this.destinationReached && !this.collided) {
      const destFontSize = Math.max(7, 9 / Math.sqrt(zoom));
      ctx.font = `600 ${destFontSize}px Inter, sans-serif`;
      ctx.fillStyle = '#22c55e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('🏁 Terminus', 0, locoH/2 + 6);
    }

    // Collision badge
    if (this.collided) {
      const pulse = 0.7 + 0.3 * Math.sin(time * 8);
      const collFontSize = Math.max(8, 11 / Math.sqrt(zoom));
      ctx.font = `800 ${collFontSize}px Inter, sans-serif`;
      ctx.fillStyle = `rgba(239, 68, 68, ${pulse})`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('⚠ COLLISION', 0, locoH/2 + 6);
    }

    ctx.restore();
  }

  _darken(hex, amount) {
    const r = parseInt(hex.slice(1,3), 16);
    const g = parseInt(hex.slice(3,5), 16);
    const b = parseInt(hex.slice(5,7), 16);
    const f = 1 - amount;
    return `rgb(${Math.round(r*f)}, ${Math.round(g*f)}, ${Math.round(b*f)})`;
  }
}

export { TRAIN_COLORS, PRIORITY_CONFIG };
