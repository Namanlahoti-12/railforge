/**
 * Station — data model and rendering for a railway station.
 * v2: Multi-platform support with train staging/assignment.
 */
export class Station {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.name = data.name || 'Station';
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.trackId = data.trackId || null;     // associated track
    this.trackT = data.trackT ?? 0.5;        // position on track (0–1)
    this.platformCount = data.platformCount ?? 2;
    this.color = data.color || '#4e8cff';
    this.width = data.width ?? 80;
    this.height = data.height ?? 24;

    // ── Multi-platform (v2) ──
    this.platforms = data.platforms || this._initPlatforms(this.platformCount);
  }

  _initPlatforms(count) {
    const platforms = [];
    for (let i = 0; i < count; i++) {
      platforms.push({
        id: `p${i + 1}`,
        label: `P${i + 1}`,
        occupied: false,
        trainId: null,
      });
    }
    return platforms;
  }

  toJSON() {
    return {
      id: this.id, name: this.name,
      x: this.x, y: this.y,
      trackId: this.trackId, trackT: this.trackT,
      platformCount: this.platformCount,
      color: this.color,
      width: this.width, height: this.height,
      platforms: this.platforms.map(p => ({ ...p })),
    };
  }

  /** Update platform count and reinitialize platforms */
  setPlatformCount(count) {
    this.platformCount = count;
    // Preserve existing platforms, add/remove as needed
    while (this.platforms.length < count) {
      const idx = this.platforms.length;
      this.platforms.push({
        id: `p${idx + 1}`,
        label: `P${idx + 1}`,
        occupied: false,
        trainId: null,
      });
    }
    while (this.platforms.length > count) {
      this.platforms.pop();
    }
    // Recalculate height
    this.height = Math.max(24, 12 + count * 8);
  }

  /** Assign a train to an available platform. Returns platform id or null. */
  assignPlatform(trainId) {
    // Check if train already has a platform here
    const existing = this.platforms.find(p => p.trainId === trainId);
    if (existing) return existing.id;

    // Find first free platform
    const free = this.platforms.find(p => !p.occupied);
    if (!free) return null; // all platforms full

    free.occupied = true;
    free.trainId = trainId;
    return free.id;
  }

  /** Release a platform when a train departs */
  releasePlatform(trainId) {
    const platform = this.platforms.find(p => p.trainId === trainId);
    if (platform) {
      platform.occupied = false;
      platform.trainId = null;
    }
  }

  /** Check if any platform is available */
  hasAvailablePlatform() {
    return this.platforms.some(p => !p.occupied);
  }

  /** Get count of occupied platforms */
  getOccupiedCount() {
    return this.platforms.filter(p => p.occupied).length;
  }

  /** Update position from associated track */
  updateFromTrack(track) {
    if (!track) return;
    const p = track.getPointAt(this.trackT);
    const n = track.getNormalAt(this.trackT);
    this.x = p.x + n.x * 25;
    this.y = p.y + n.y * 25;
  }

  /** Hit-test */
  hitTest(wx, wy, threshold = 0) {
    const hw = this.width / 2 + threshold;
    const hh = this.height / 2 + threshold;
    return Math.abs(wx - this.x) < hw && Math.abs(wy - this.y) < hh;
  }

  /** Render the station */
  render(ctx, camera, state = 'default') {
    const zoom = camera.zoom;
    const x = this.x;
    const y = this.y;
    const w = this.width;
    const h = Math.max(this.height, 12 + this.platformCount * 8);

    ctx.save();

    const isSelected = state === 'selected';
    const isHover = state === 'hover';

    // Shadow / glow
    if (isSelected || isHover) {
      ctx.shadowColor = isSelected ? 'rgba(78, 140, 255, 0.5)' : 'rgba(124, 92, 252, 0.3)';
      ctx.shadowBlur = 16 / zoom;
    }

    // Main platform rectangle
    ctx.fillStyle = isSelected ? 'rgba(78, 140, 255, 0.2)' : 'rgba(30, 40, 70, 0.85)';
    ctx.strokeStyle = isSelected ? '#4e8cff' : isHover ? '#7c5cfc' : 'rgba(100, 140, 255, 0.3)';
    ctx.lineWidth = Math.max(1, 1.5 / Math.sqrt(zoom));

    const r = 4;
    ctx.beginPath();
    ctx.roundRect(x - w/2, y - h/2, w, h, r);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Platform strips with labels and occupancy
    const stripH = 3;
    const stripGap = (h - this.platforms.length * stripH) / (this.platforms.length + 1);

    for (let i = 0; i < this.platforms.length; i++) {
      const platform = this.platforms[i];
      const sy = y - h/2 + stripGap * (i + 1) + stripH * i;

      // Platform strip
      ctx.fillStyle = platform.occupied ? '#ef4444' : this.color;
      ctx.beginPath();
      ctx.roundRect(x - w/2 + 4, sy, w - 8, stripH, 1.5);
      ctx.fill();

      // Platform label
      if (zoom > 0.6) {
        const labelSize = Math.max(5, 7 / Math.sqrt(zoom));
        ctx.font = `600 ${labelSize}px Inter, sans-serif`;
        ctx.fillStyle = platform.occupied ? '#ef4444' : 'rgba(150, 170, 200, 0.6)';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(platform.label, x - w/2 + 2, sy + stripH/2);
      }
    }

    // Station name label
    const fontSize = Math.max(9, 11 / Math.sqrt(zoom));
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = isSelected ? '#4e8cff' : '#c0c8d8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(this.name, x, y + h/2 + 5);

    // Occupancy counter
    const occupied = this.getOccupiedCount();
    if (occupied > 0 && zoom > 0.5) {
      const counterSize = Math.max(7, 9 / Math.sqrt(zoom));
      ctx.font = `500 ${counterSize}px Inter, sans-serif`;
      ctx.fillStyle = '#ef4444';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`${occupied}/${this.platforms.length}`, x, y - h/2 - 3);
    }

    // Station icon
    ctx.font = `${Math.max(10, 12 / Math.sqrt(zoom))}px "Material Icons Round"`;
    ctx.fillStyle = this.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('apartment', x, y - h/2 - (occupied > 0 ? 14 : 3));

    ctx.restore();
  }
}
