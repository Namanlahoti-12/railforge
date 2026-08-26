/**
 * PathFinder v4 — Coordinate-aware shortest-path routing.
 *
 * Key idea: each station sits at parameter t on a host track.
 * We inject a "virtual node" at the station's exact (x, y) into
 * the graph, splitting its host track into two half-edges:
 *   track.start  ──(weight = len * t)──  stationNode  ──(weight = len * (1-t))──  track.end
 *
 * Dijkstra then finds the true shortest path from one station
 * coordinate to another, following only laid track.
 */
export class PathFinder {
  constructor() {
    // nodeId  →  [ { trackId, toNode, weight, fromT, toT } ]
    this._adj = new Map();
    // "x,y" key → nodeId
    this._nodeMap = new Map();
    this._nodeCoords = new Map();  // nodeId → {x, y}
    this._nodeCounter = 0;
  }

  // ─────────────────────────────────────────────────────────
  //  Internal graph helpers
  // ─────────────────────────────────────────────────────────

  _snap(v) { return Math.round(v); }          // 1-unit precision
  _key(p)  { return `${this._snap(p.x)},${this._snap(p.y)}`; }

  _getOrCreateNode(p) {
    const k = this._key(p);
    if (!this._nodeMap.has(k)) {
      const id = this._nodeCounter++;
      this._nodeMap.set(k, id);
      this._nodeCoords.set(id, { x: p.x, y: p.y });
      this._adj.set(id, []);
    }
    return this._nodeMap.get(k);
  }

  _addEdge(fromNode, toNode, trackId, weight) {
    this._adj.get(fromNode).push({ toNode, trackId, weight });
    this._adj.get(toNode).push({ toNode: fromNode, trackId, weight });
  }

  // ─────────────────────────────────────────────────────────
  //  Build graph from tracks + inject station virtual nodes
  // ─────────────────────────────────────────────────────────

  /**
   * Build the routing graph.
   * @param {Map} tracks
   * @param {Map} [stations]  – optional; injects station coords as virtual nodes
   * @returns {Map} stationNodeMap: stationId → nodeId
   */
  buildGraph(tracks, stations = new Map()) {
    this._adj.clear();
    this._nodeMap.clear();
    this._nodeCoords.clear();
    this._nodeCounter = 0;

    // 1. Collect which station(s) sit on each track
    const stationsByTrack = new Map(); // trackId → [{stationId, t, x, y}]
    for (const [sid, station] of stations) {
      if (!station.trackId) continue;
      if (!stationsByTrack.has(station.trackId)) stationsByTrack.set(station.trackId, []);
      stationsByTrack.get(station.trackId).push({
        stationId: sid,
        t: station.trackT,
        x: station.x,
        y: station.y,
      });
    }

    const stationNodeMap = new Map(); // stationId → nodeId

    // 2. Process each track
    for (const [, track] of tracks) {
      const totalLen = track.getLength() || 1;

      // Endpoints as graph nodes
      const startNode = this._getOrCreateNode(track.start);
      const endNode   = this._getOrCreateNode(track.end);

      // Collect injection points along this track (t=0 = start, t=1 = end)
      const injectPts = [
        { t: 0, nodeId: startNode },
        { t: 1, nodeId: endNode },
      ];

      const trackStations = stationsByTrack.get(track.id) || [];
      for (const s of trackStations) {
        const pt = track.getPointAt(s.t);
        const nodeId = this._getOrCreateNode(pt);
        injectPts.push({ t: s.t, nodeId });
        stationNodeMap.set(s.stationId, nodeId);
      }

      // Sort by t so we can link adjacent points with correct weights
      injectPts.sort((a, b) => a.t - b.t);

      // Add edges between consecutive injection points on this track
      for (let i = 0; i < injectPts.length - 1; i++) {
        const a = injectPts[i];
        const b = injectPts[i + 1];
        const segWeight = (b.t - a.t) * totalLen;
        if (a.nodeId !== b.nodeId && segWeight > 0) {
          this._addEdge(a.nodeId, b.nodeId, track.id, segWeight);
        }
      }
    }

    return stationNodeMap;
  }

  // ─────────────────────────────────────────────────────────
  //  Dijkstra
  // ─────────────────────────────────────────────────────────

  /**
   * Find the shortest path between two node IDs.
   * Returns array of { trackId, fromNode, toNode } edges in order.
   */
  _dijkstra(sourceNode, targetNode) {
    const dist    = new Map();
    const prev    = new Map();   // node → { fromNode, trackId }
    const visited = new Set();

    for (const [n] of this._adj) dist.set(n, Infinity);
    dist.set(sourceNode, 0);

    // Simple priority queue using sorted array (works well for typical graph sizes)
    const pq = [[0, sourceNode]];

    while (pq.length > 0) {
      pq.sort((a, b) => a[0] - b[0]);
      const [d, u] = pq.shift();

      if (visited.has(u)) continue;
      visited.add(u);
      if (u === targetNode) break;

      for (const edge of (this._adj.get(u) || [])) {
        const alt = d + edge.weight;
        if (alt < (dist.get(edge.toNode) ?? Infinity)) {
          dist.set(edge.toNode, alt);
          prev.set(edge.toNode, { fromNode: u, trackId: edge.trackId });
          pq.push([alt, edge.toNode]);
        }
      }
    }

    // Reconstruct edge path
    if (!prev.has(targetNode)) return null; // unreachable

    const edges = [];
    let cur = targetNode;
    while (prev.has(cur)) {
      const { fromNode, trackId } = prev.get(cur);
      edges.unshift({ trackId, fromNode, toNode: cur });
      cur = fromNode;
    }
    return edges;
  }

  // ─────────────────────────────────────────────────────────
  //  Public API
  // ─────────────────────────────────────────────────────────

  /**
   * Build the full ordered route (array of track IDs) for a
   * multi-stop station sequence, using Dijkstra on coordinates.
   *
   * @param {Array}  stationStops  [{stationId, stationName}, ...]
   * @param {Map}    stations      all Station objects
   * @param {Map}    tracks        all Track objects
   * @returns {{ route: string[], segmentMap: Map }}
   *   route        — deduplicated ordered array of track IDs
   *   segmentMap   — stationId → index in route where train stops
   */
  buildStationRoute(stationStops, stations, tracks) {
    if (stationStops.length < 1) return { route: [], segmentMap: new Map() };

    // Build graph with all stations injected
    const stationNodeMap = this.buildGraph(tracks, stations);

    const fullRoute   = [];   // track IDs in order
    const segmentMap  = new Map(); // stationId → route index where this station is

    for (let i = 0; i < stationStops.length - 1; i++) {
      const fromId = stationStops[i].stationId;
      const toId   = stationStops[i + 1].stationId;

      const fromNode = stationNodeMap.get(fromId);
      const toNode   = stationNodeMap.get(toId);

      if (fromNode === undefined || toNode === undefined) {
        console.warn(`[PathFinder] Station node missing: ${fromId} or ${toId}`);
        continue;
      }

      // Mark where this FROM station is in the route
      if (i === 0) {
        segmentMap.set(fromId, fullRoute.length);
      }

      const edges = this._dijkstra(fromNode, toNode);
      if (!edges || edges.length === 0) {
        console.warn(`[PathFinder] No path between ${stationStops[i].stationName} → ${stationStops[i+1].stationName}`);
        continue;
      }

      for (const edge of edges) {
        // Avoid duplicating the last track when segments chain
        if (fullRoute.length === 0 || fullRoute[fullRoute.length - 1] !== edge.trackId) {
          fullRoute.push(edge.trackId);
        }
      }

      // Mark where the TO station falls
      segmentMap.set(toId, fullRoute.length - 1);
    }

    return { route: fullRoute, segmentMap };
  }

  /**
   * Simple version: returns just the track ID array.
   * Used for "auto-route all connected" button.
   */
  buildStationRouteSimple(stationStops, stations, tracks) {
    const { route } = this.buildStationRoute(stationStops, stations, tracks);
    return route;
  }

  /** Find all track IDs reachable from a starting track (BFS). */
  getConnectedTracks(startTrackId, tracks) {
    this.buildGraph(tracks); // no stations needed here

    const startTrack = tracks.get(startTrackId);
    if (!startTrack) return [];

    const startNodeA = this._getOrCreateNode(startTrack.start);
    const startNodeB = this._getOrCreateNode(startTrack.end);

    const visited  = new Set();
    const result   = new Set();
    const queue    = [startNodeA, startNodeB];

    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);

      for (const edge of (this._adj.get(node) || [])) {
        result.add(edge.trackId);
        if (!visited.has(edge.toNode)) queue.push(edge.toNode);
      }
    }

    return [...result];
  }

  /** Check if any track is connected ahead in a given direction. */
  hasTrackAhead(trackId, direction, tracks) {
    const track = tracks.get(trackId);
    if (!track) return false;
    const connections = direction === 1 ? track.connections.end : track.connections.start;
    return connections.length > 0;
  }
}
