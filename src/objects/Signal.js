/**
 * Signal — data model and rendering for railway signals.
 */
export class Signal {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.trackId = data.trackId || null;
    this.trackT = data.trackT ?? 0.5;
    this.state = data.state || 'green'; // 'red' | 'yellow' | 'green'
    this.autoManage = data.autoManage ?? true; // auto-switch based on trains
  }

  toJSON() {
    return {
      id: this.id, x: this.x, y: this.y,
      trackId: this.trackId, trackT: this.trackT,
      state: this.state, autoManage: this.autoManage,
    };
  }

  /** Update position from associated track */
  updateFromTrack(track) {
    if (!track) return;
    const p = track.getPointAt(this.trackT);
    const n = track.getNormalAt(this.trackT);
    this.x = p.x - n.x * 20;
    this.y = p.y - n.y * 20;
  }

  /** Hit-test */
  hitTest(wx, wy, threshold = 15) {
    const dx = wx - this.x;
    const dy = wy - this.y;
    return dx*dx + dy*dy < threshold * threshold;
  }

  /** Render the signal */
  render(ctx, camera, state = 'default') {
    const zoom = camera.zoom;
    const isSelected = state === 'selected';
    const isHover = state === 'hover';

    ctx.save();

    // Post
    ctx.strokeStyle = '#555f78';
    ctx.lineWidth = Math.max(2, 2.5 / Math.sqrt(zoom));
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(this.x, this.y);
    ctx.lineTo(this.x, this.y - 22);
    ctx.stroke();

    // Signal housing
    const hx = this.x;
    const hy = this.y - 22;
    const hw = 8;
    const hh = 22;

    if (isSelected || isHover) {
      ctx.shadowColor = isSelected ? 'rgba(78, 140, 255, 0.5)' : 'rgba(124, 92, 252, 0.3)';
      ctx.shadowBlur = 10 / zoom;
    }

    ctx.fillStyle = '#1a2140';
    ctx.strokeStyle = isSelected ? '#4e8cff' : isHover ? '#7c5cfc' : '#3a4560';
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.roundRect(hx - hw/2, hy - hh/2, hw, hh, 3);
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Light positions (top=red, mid=yellow, bot=green)
    const lights = [
      { cy: hy - 6, color: '#ef4444', active: this.state === 'red' },
      { cy: hy,     color: '#eab308', active: this.state === 'yellow' },
      { cy: hy + 6, color: '#22c55e', active: this.state === 'green' },
    ];

    for (const light of lights) {
      const r = 2.5;

      if (light.active) {
        // Active glow
        ctx.shadowColor = light.color;
        ctx.shadowBlur = 12 / zoom;
        ctx.fillStyle = light.color;
        ctx.beginPath();
        ctx.arc(hx, light.cy, r, 0, Math.PI * 2);
        ctx.fill();

        // Bright core
        ctx.shadowBlur = 0;
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.beginPath();
        ctx.arc(hx, light.cy, r * 0.5, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Inactive dim
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.arc(hx, light.cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }
}
