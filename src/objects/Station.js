/**
 * Station — data model and rendering for a railway station.
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
  }

  toJSON() {
    return {
      id: this.id, name: this.name,
      x: this.x, y: this.y,
      trackId: this.trackId, trackT: this.trackT,
      platformCount: this.platformCount,
      color: this.color,
      width: this.width, height: this.height,
    };
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
    const h = this.height;

    ctx.save();

    // Platform body
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

    // Platform strips
    const stripCount = this.platformCount;
    const stripH = 3;
    const stripGap = (h - stripCount * stripH) / (stripCount + 1);
    ctx.fillStyle = this.color;

    for (let i = 0; i < stripCount; i++) {
      const sy = y - h/2 + stripGap * (i + 1) + stripH * i;
      ctx.beginPath();
      ctx.roundRect(x - w/2 + 4, sy, w - 8, stripH, 1.5);
      ctx.fill();
    }

    // Station name label
    const fontSize = Math.max(9, 11 / Math.sqrt(zoom));
    ctx.font = `600 ${fontSize}px Inter, sans-serif`;
    ctx.fillStyle = isSelected ? '#4e8cff' : '#c0c8d8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(this.name, x, y + h/2 + 5);

    // Station icon
    ctx.font = `${Math.max(10, 12 / Math.sqrt(zoom))}px "Material Icons Round"`;
    ctx.fillStyle = this.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('apartment', x, y - h/2 - 3);

    ctx.restore();
  }
}
