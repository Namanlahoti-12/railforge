/**
 * Train — data model and rendering for a train moving along tracks.
 */

const TRAIN_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

export class Train {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.name = data.name || 'Train';
    this.color = data.color || TRAIN_COLORS[Math.floor(Math.random() * TRAIN_COLORS.length)];
    this.currentTrackId = data.currentTrackId || null;
    this.t = data.t ?? 0;               // parametric position on current track [0,1]
    this.speed = data.speed ?? 60;       // world units per second
    this.direction = data.direction ?? 1; // 1 = forward, -1 = reverse
    this.route = data.route || [];        // ordered array of track IDs
    this.routeIndex = data.routeIndex ?? 0;
    this.running = data.running ?? false;
    this.carriages = data.carriages ?? 2;
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.angle = data.angle ?? 0;

    // Headlight flicker
    this._headlightPhase = Math.random() * Math.PI * 2;
  }

  toJSON() {
    return {
      id: this.id, name: this.name, color: this.color,
      currentTrackId: this.currentTrackId,
      t: this.t, speed: this.speed, direction: this.direction,
      route: [...this.route], routeIndex: this.routeIndex,
      running: this.running, carriages: this.carriages,
      x: this.x, y: this.y, angle: this.angle,
    };
  }

  /** Update train position based on current track */
  updatePosition(track) {
    if (!track) return;
    const p = track.getPointAt(this.t);
    const tan = track.getTangentAt(this.t);
    this.x = p.x;
    this.y = p.y;
    this.angle = Math.atan2(tan.y, tan.x) * (this.direction === -1 ? 1 : 1);
    if (this.direction === -1) this.angle += Math.PI;
  }

  /** Advance the train by delta time */
  advance(dt, tracks) {
    if (!this.running || !this.currentTrackId) return;
    const track = tracks.get(this.currentTrackId);
    if (!track) return;

    const trackLen = track.getLength();
    if (trackLen === 0) return;

    const dtParam = (this.speed * dt) / trackLen;
    this.t += dtParam * this.direction;

    // Check if we've reached the end of this track segment
    if (this.t >= 1) {
      this.t = 1;
      // Try to move to next track in route
      if (this.route.length > 0 && this.routeIndex < this.route.length - 1) {
        this.routeIndex++;
        this.currentTrackId = this.route[this.routeIndex];
        this.t = 0;
        // Determine direction based on connection
        const nextTrack = tracks.get(this.currentTrackId);
        if (nextTrack) {
          const endPt = track.end;
          const distToStart = Math.hypot(endPt.x - nextTrack.start.x, endPt.y - nextTrack.start.y);
          const distToEnd = Math.hypot(endPt.x - nextTrack.end.x, endPt.y - nextTrack.end.y);
          this.direction = distToStart < distToEnd ? 1 : -1;
          this.t = distToStart < distToEnd ? 0 : 1;
        }
      } else {
        // Reverse at end
        this.direction *= -1;
        this.t = 1;
      }
    } else if (this.t <= 0) {
      this.t = 0;
      if (this.route.length > 0 && this.routeIndex > 0) {
        this.routeIndex--;
        this.currentTrackId = this.route[this.routeIndex];
        const prevTrack = tracks.get(this.currentTrackId);
        if (prevTrack) {
          const startPt = track.start;
          const distToStart = Math.hypot(startPt.x - prevTrack.start.x, startPt.y - prevTrack.start.y);
          const distToEnd = Math.hypot(startPt.x - prevTrack.end.x, startPt.y - prevTrack.end.y);
          this.direction = distToEnd < distToStart ? -1 : 1;
          this.t = distToEnd < distToStart ? 1 : 0;
        }
      } else {
        this.direction *= -1;
        this.t = 0;
      }
    }

    this.updatePosition(track);
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

    // ── Selection glow ──
    if (isSelected || isHover) {
      ctx.shadowColor = isSelected ? 'rgba(78, 140, 255, 0.6)' : 'rgba(124, 92, 252, 0.4)';
      ctx.shadowBlur = 12 / zoom;
    }

    // ── Locomotive ──
    const r = 3;

    // Body
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
    if (this.running) {
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

    // ── Label ──
    ctx.rotate(-this.angle); // un-rotate for readable text
    const fontSize = Math.max(8, 10 / Math.sqrt(zoom));
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = isSelected ? '#4e8cff' : '#c0c8d8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(this.name, 0, -locoH/2 - 8);

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

export { TRAIN_COLORS };
