# Design Dock

## Overview
The project aims to provide a graphical representation of live network traffic using a 2‑dimensional canvas.

### Architecture

The system will have a *listener server* implemented in Go, following good practices for a Go project structure.

The listener server will capture the packets and serve a web page visualizing the network traffic.

### Visualization

Each observed host will be represented by a blob, containing its hostname and IP address. (no duplicates)

Each unique IP‑pair (source → destination) is represented as an **edge**.

Each packet is displayed as a particle travelling along the edge, from the source to the destination. The size of the particles indicates the size of the data in the packet.

The color of the packets is determined by the protocol used.

---

## Project Status

- planning steps to MVP implementation

## Steps to a Working Program

### 1) Project scaffolding
- [ ] Create standard Go layout (e.g. `cmd/netvis/`, `internal/capture/`, `internal/graph/`, `internal/server/`, `web/` or `static/`).
- [ ] Add `README.md` usage notes (build, permissions, interfaces) and update as needed.
- [ ] Define dependencies in `go.mod` (e.g. `github.com/google/gopacket` for capture; standard library for HTTP/WS).

### 2) Packet capture
- [ ] Choose capture source: live interface via libpcap (default) with flags for `-i`/`--iface` and optional BPF filter.
- [ ] Parse packets to extract L3/L4: IP (src/dst), protocol (TCP/UDP/ICMP/other), length/size.
- [ ] Handle permissions (requires root/CAP_NET_RAW/CAP_NET_ADMIN on Linux) and surface clear errors.
- [ ] Emit normalized events (e.g. `{ts, srcIP, dstIP, proto, bytes}`) to the graph/state layer.

### 3) Graph/state model
- [ ] Track hosts: map by IP, store IP and resolved hostname (async reverse DNS with caching/timeouts; best-effort).
- [ ] Track edges: key by `srcIP->dstIP` (or ordered pair), accumulate metadata (packet count/bytes).
- [ ] Provide thread-safe access (channels or sync.RWMutex) for capture goroutine feeding the server.
- [ ] Keep bounded history/retention if desired (MVP can keep in-memory seen hosts/edges).

### 4) Backend server (API + realtime)
- [ ] HTTP server to serve static frontend (`/`).
- [ ] Realtime updates: WebSocket (or SSE) streaming new packets/graph updates to clients.
- [ ] Optional REST endpoints (e.g. `/api/graph` initial snapshot) for simplicity.
- [ ] CORS not needed for same-origin; keep minimal.

### 5) Frontend visualization (2D canvas)
- [ ] Canvas-based renderer (vanilla JS/TS) with simple force/layout or fixed positions (MVP: place blobs in a ring or let them drift lightly).
- [ ] Render blobs per host (label IP/hostname), avoid duplicates.
- [ ] Render edges between IP pairs.
- [ ] Animate particles along edges on packet events; size ~ packet bytes (log scale), color by protocol.
- [ ] Connect to WS, apply incremental updates smoothly.

### 6) Integration, run, and validation
- [ ] Wire capture → state → WS broadcast → frontend.
- [ ] CLI flags: interface, BPF filter, listen address/port.
- [ ] Test on a real interface (e.g. generate traffic with `curl/ping`) and verify blobs/edges/particles appear.
- [ ] Document permissions/setup in README.

### MVP acceptance criteria
- [ ] Program compiles and runs as `netvis` (or `go run ./cmd/netvis`).
- [ ] Captures live packets on a specified interface.
- [ ] Serves web UI showing hosts, edges, and animated particles by protocol/size.
- [ ] No duplicate hosts/edges as specified.

## Open Issues

- [ ] Choose specific layout/physics for blobs/edges (keep simple for MVP).
- [ ] Decide hostname resolution strategy (async + cache, or skip if slow).
- [ ] Handle VLAN/MPLS or IPv6? (start with IPv4; extend later).
- [ ] Rate limiting/visual noise control for busy networks.
