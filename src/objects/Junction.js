/**
 * Junction — interactive switch/turnout at track intersections.
 * Allows trains to branch onto different tracks.
 * Supports auto-routing based on train route and manual override.
 */
export class Junction {
  constructor(data = {}) {
    this.id = data.id || crypto.randomUUID();
    this.x = data.x ?? 0;
    this.y = data.y ?? 0;
    this.connectedTrackIds = data.connectedTrackIds || [];
    // activeRoute: [trackIdA, trackIdB] — which pair of tracks are connected through this junction
    this.activeRoute = data.activeRoute || [];
    this.autoSwitch = data.autoSwitch ?? true; // auto-switch based on approaching train's route
    this.manualOverride = data.manualOverride ?? false;
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x, y: this.y,
      connectedTrackIds: [...this.connectedTrackIds],
      activeRoute: [...this.activeRoute],
      autoSwitch: this.autoSwitch,
      manualOverride: this.manualOverride,
    };
  }

  /** Add a track to this junction */
  addTrack(trackId) {
    if (!this.connectedTrackIds.includes(trackId)) {
      this.connectedTrackIds.push(trackId);
    }
    // Default active route: first two tracks
    if (this.activeRoute.length < 2 && this.connectedTrackIds.length >= 2) {
      this.activeRoute = [this.connectedTrackIds[0], this.connectedTrackIds[1]];
    }
  }

  /** Toggle to the next route combination */
  toggleRoute() {
    if (this.connectedTrackIds.length < 3) return;
    
    const tracks = this.connectedTrackIds;
    const currentKey = this.activeRoute.join(',');
    
    // Generate all possible pairs
    const pairs = [];
    for (let i = 0; i < tracks.length; i++) {
      for (let j = i + 1; j < tracks.length; j++) {
        pairs.push([tracks[i], tracks[j]]);
      }
    }
    
    // Find current pair and advance to next
    const idx = pairs.findIndex(p => p.join(',') === currentKey);
    const nextIdx = (idx + 1) % pairs.length;
    this.activeRoute = pairs[nextIdx];
    this.manualOverride = true;
    this.autoSwitch = false;
  }

  /** Set route for a specific train approaching from trackId */
  setRouteForTrain(fromTrackId, toTrackId) {
    if (this.manualOverride) return false; // manual override active
    if (!this.connectedTrackIds.includes(fromTrackId)) return false;
    if (!this.connectedTrackIds.includes(toTrackId)) return false;
    this.activeRoute = [fromTrackId, toTrackId];
    return true;
  }

  /** Check if a route from → to is currently active */
  isRouteActive(fromTrackId, toTrackId) {
    return this.activeRoute.includes(fromTrackId) && this.activeRoute.includes(toTrackId);
  }

  /** Get the track a train should transition to when coming from fromTrackId */
  getNextTrack(fromTrackId) {
    if (!this.activeRoute.includes(fromTrackId)) return null;
    return this.activeRoute.find(id => id !== fromTrackId) || null;
  }

  /** Hit-test */
  hitTest(wx, wy, threshold = 18) {
    const dx = wx - this.x;
    const dy = wy - this.y;
    return dx*dx + dy*dy < threshold * threshold;
  }

  /** Render the junction */
  render(ctx, camera, state = 'default') {
    const zoom = camera.zoom;
    const isSelected = state === 'selected';
    const isHover = state === 'hover';

    ctx.save();

    // Glow
    if (isSelected || isHover) {
      ctx.shadowColor = isSelected ? 'rgba(78, 140, 255, 0.5)' : 'rgba(124, 92, 252, 0.3)';
      ctx.shadowBlur = 14 / zoom;
    }

    // Diamond shape
    const size = Math.max(8, 10 / Math.sqrt(zoom));
    ctx.fillStyle = this.manualOverride 
      ? 'rgba(234, 179, 8, 0.3)' 
      : 'rgba(30, 40, 70, 0.9)';
    ctx.strokeStyle = isSelected ? '#4e8cff' 
                    : isHover ? '#7c5cfc' 
                    : this.manualOverride ? '#eab308' : '#5a8ccc';
    ctx.lineWidth = Math.max(1.5, 2 / Math.sqrt(zoom));

    ctx.beginPath();
    ctx.moveTo(this.x, this.y - size);
    ctx.lineTo(this.x + size, this.y);
    ctx.lineTo(this.x, this.y + size);
    ctx.lineTo(this.x - size, this.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Inner active indicator
    const innerSize = size * 0.4;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(this.x, this.y, innerSize, 0, Math.PI * 2);
    ctx.fill();

    // Lock icon for manual override
    if (this.manualOverride) {
      const fontSize = Math.max(8, 10 / Math.sqrt(zoom));
      ctx.font = `${fontSize}px Inter, sans-serif`;
      ctx.fillStyle = '#eab308';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('🔒', this.x, this.y - size - 3);
    }

    // Label
    if (zoom > 0.5) {
      const fontSize = Math.max(7, 9 / Math.sqrt(zoom));
      ctx.font = `600 ${fontSize}px Inter, sans-serif`;
      ctx.fillStyle = isSelected ? '#4e8cff' : '#8898b8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('JCT', this.x, this.y + size + 4);
    }

    ctx.restore();
  }
}
