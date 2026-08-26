/**
 * PathFinder — graph representation of track network and route computation.
 */
export class PathFinder {
  constructor() {
    this.graph = new Map(); // nodeId → [{ trackId, neighborNodeId, weight }]
  }

  /** Rebuild graph from tracks */
  buildGraph(tracks) {
    this.graph.clear();
    const nodeMap = new Map(); // "x,y" → nodeId
    let nodeCounter = 0;

    const getNode = (p) => {
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (!nodeMap.has(key)) {
        nodeMap.set(key, nodeCounter++);
        this.graph.set(nodeMap.get(key), []);
      }
      return nodeMap.get(key);
    };

    for (const [, track] of tracks) {
      const startNode = getNode(track.start);
      const endNode = getNode(track.end);
      const weight = track.getLength();

      this.graph.get(startNode).push({
        trackId: track.id,
        neighbor: endNode,
        weight,
      });
      this.graph.get(endNode).push({
        trackId: track.id,
        neighbor: startNode,
        weight,
      });
    }

    this._nodeMap = nodeMap;
  }

  /** Find shortest path between two world points → array of track IDs */
  findRoute(startPt, endPt, tracks) {
    this.buildGraph(tracks);

    const startKey = `${Math.round(startPt.x)},${Math.round(startPt.y)}`;
    const endKey = `${Math.round(endPt.x)},${Math.round(endPt.y)}`;
    const startNode = this._nodeMap?.get(startKey);
    const endNode = this._nodeMap?.get(endKey);

    if (startNode === undefined || endNode === undefined) return [];
    if (startNode === endNode) return [];

    // Dijkstra's algorithm
    const dist = new Map();
    const prev = new Map();
    const prevEdge = new Map();
    const visited = new Set();

    for (const [n] of this.graph) {
      dist.set(n, Infinity);
    }
    dist.set(startNode, 0);

    const queue = [startNode];

    while (queue.length > 0) {
      // Find min-distance node
      queue.sort((a, b) => dist.get(a) - dist.get(b));
      const u = queue.shift();

      if (visited.has(u)) continue;
      visited.add(u);

      if (u === endNode) break;

      for (const edge of (this.graph.get(u) || [])) {
        const alt = dist.get(u) + edge.weight;
        if (alt < dist.get(edge.neighbor)) {
          dist.set(edge.neighbor, alt);
          prev.set(edge.neighbor, u);
          prevEdge.set(edge.neighbor, edge.trackId);
          queue.push(edge.neighbor);
        }
      }
    }

    // Reconstruct path
    const route = [];
    let node = endNode;
    while (prev.has(node)) {
      route.unshift(prevEdge.get(node));
      node = prev.get(node);
    }

    return route;
  }

  /** Get all connected track IDs from a starting track (BFS) */
  getConnectedTracks(startTrackId, tracks) {
    this.buildGraph(tracks);
    const connected = new Set();
    const visited = new Set();
    const queue = [];

    // Find nodes for the start track
    for (const [, track] of tracks) {
      if (track.id === startTrackId) {
        const sKey = `${Math.round(track.start.x)},${Math.round(track.start.y)}`;
        const eKey = `${Math.round(track.end.x)},${Math.round(track.end.y)}`;
        const sNode = this._nodeMap?.get(sKey);
        const eNode = this._nodeMap?.get(eKey);
        if (sNode !== undefined) queue.push(sNode);
        if (eNode !== undefined) queue.push(eNode);
        break;
      }
    }

    while (queue.length > 0) {
      const node = queue.shift();
      if (visited.has(node)) continue;
      visited.add(node);

      for (const edge of (this.graph.get(node) || [])) {
        connected.add(edge.trackId);
        if (!visited.has(edge.neighbor)) {
          queue.push(edge.neighbor);
        }
      }
    }

    return [...connected];
  }
}
