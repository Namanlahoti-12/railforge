/**
 * SimulationEngine — game loop for train movement, signals, collisions.
 */
export class SimulationEngine {
  constructor(appState) {
    this.app = appState;
    this.playing = false;
    this.speed = 1;
    this._time = 0;
  }

  get time() { return this._time; }

  play() {
    this.playing = true;
    // Start all trains that have a track assigned
    for (const [, train] of this.app.trains) {
      if (train.currentTrackId) train.running = true;
    }
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
      if (train.route.length > 0) {
        train.currentTrackId = train.route[0];
      }
      const track = this.app.tracks.get(train.currentTrackId);
      if (track) train.updatePosition(track);
    }
  }

  setSpeed(speed) {
    this.speed = Math.max(0.25, Math.min(4, speed));
  }

  /** Called every frame from the render loop */
  update(dt) {
    if (!this.playing) return;

    const adjustedDt = dt * this.speed;
    this._time += adjustedDt;

    // ── Move trains ──
    for (const [, train] of this.app.trains) {
      train.advance(adjustedDt, this.app.tracks);
    }

    // ── Auto-manage signals ──
    this._updateSignals();

    // ── Check collisions ──
    this._checkCollisions();
  }

  _updateSignals() {
    for (const [, signal] of this.app.signals) {
      if (!signal.autoManage || !signal.trackId) continue;

      let closestDist = Infinity;
      let closestTrain = null;

      for (const [, train] of this.app.trains) {
        if (!train.running) continue;
        const dx = train.x - signal.x;
        const dy = train.y - signal.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < closestDist) {
          closestDist = dist;
          closestTrain = train;
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

  _checkCollisions() {
    const trainArr = [...this.app.trains.values()].filter(t => t.running);

    for (let i = 0; i < trainArr.length; i++) {
      for (let j = i + 1; j < trainArr.length; j++) {
        const a = trainArr[i];
        const b = trainArr[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx*dx + dy*dy);

        if (dist < 35) {
          // Collision warning — slow both trains
          a.speed = Math.max(10, a.speed * 0.95);
          b.speed = Math.max(10, b.speed * 0.95);

          if (dist < 20 && !this._collisionNotified) {
            this._collisionNotified = true;
            this.app.notify?.('⚠️ Collision warning! Two trains are too close.', 'warning');
            setTimeout(() => { this._collisionNotified = false; }, 3000);
          }
        }
      }
    }
  }

  _collisionNotified = false;
}
