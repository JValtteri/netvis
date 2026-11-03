# Design Dock

## Overview

NetVis provides a graphical representation of live network traffic on a
2-dimensional canvas. A Go backend captures packets with libpcap, aggregates them
into a host/connection graph, and streams updates to a browser frontend over
WebSockets. The frontend renders the graph as blobs and edges with animated
packets.

## Architecture

### Components

| Component | Path | Responsibility |
| --- | --- | --- |
| CLI | `cmd/netvis/` | Parse flags (`-iface`, `-filter`, `-addr`), start capture and HTTP server, handle shutdown. |
| Capture | `internal/capture/` | Open an interface via libpcap (cgo + gopacket), apply BPF filters, parse L3/L4, emit normalized events. |
| Graph | `internal/graph/` | Thread-safe host/edge store, traffic counters, async hostname/organization/country resolution, snapshots. |
| Server | `internal/server/` | Static file serving, WebSocket upgrade, hub broadcast, client ping/pong. |
| Frontend | `web/static/` | Canvas renderer, force layout, host info window, interactions, settings UI. |

### Data flow

```
libpcap ──► capture.Event ──┬──► graph.Apply ──► snapshot (on connect)
                            └──► hub.BroadcastEvent ──► 16 ms aggregate ──► traffic ──► WebSocket
```

`hub.BroadcastEvent` folds each event into a per-edge/protocol `traffic` record
for the current 16 ms window instead of forwarding the event itself. The
frontend therefore receives work proportional to the number of active
edge/protocol pairs in a window, not the number of packets.

### Event model

Each captured packet becomes an event:

```json
{
  "ts": "2026-10-26T12:00:00Z",
  "srcIP": "192.168.1.10",
  "dstIP": "93.184.216.34",
  "proto": "TCP",
  "bytes": 1420
}
```

The hub aggregates events by `(srcIP, dstIP, proto, frontend)` into records:

```json
{
  "srcIP": "192.168.1.10",
  "dstIP": "93.184.216.34",
  "proto": "TCP",
  "count": 128,
  "bytes": 181760,
  "frontend": true
}
```

`frontend` is omitted for ordinary traffic and set for TCP connections to the
NetVis web port; keeping it in the key means UI traffic is never merged with
other traffic on the same edge.

WebSocket messages are wrapped as:

- `{"type": "traffic", "data": [<record>, ...]}` — one aggregate per active
  edge/protocol in the 16 ms window.
- `{"type": "batch", "data": [<message>, ...]}` — traffic and host messages are
  collected into a fixed 16 ms window (bounded to 2048 messages) before being
  sent to clients. A traffic message is always placed first.
- `{"type": "snapshot", "data": {"hosts": [...], "edges": [...], "serverIPs": [...], "webPort": 8080}}`
- `{"type": "host", "data": <host>}` — sent when a host's display name is resolved
  asynchronously.

The frontend still accepts legacy `{"type": "packet", "data": <event>}` messages
and normalizes them to one-record aggregates.

## Visualization

### Hosts

- Each observed host is a blob. Hosts are keyed by identity, not by raw
  address: when reverse DNS resolves two addresses (for example a host's IPv4
  and IPv6 addresses) to the same hostname, they are grouped into one host and
  rendered as a single blob. The first address that resolved the name becomes
  the group's canonical identity; the host record carries `group` and the full
  `ips` list. The blob label prefers an IPv4 address when the group has one,
  and the host info window shows separate IPv4 and IPv6 lines for the group's
  addresses. Hosts with no resolvable hostname remain separate per IP.
- Display details are resolved asynchronously and cached per IP:
  - **All hosts** use reverse DNS for a hostname (3 s timeout).
  - **External hosts** additionally use a whois lookup: query `whois.iana.org`
    for the authoritative RIR server, then query that server and extract the
    organization (`org-name`, `OrgName`, `organization`, `owner`, `descr`, or
    `netname`) and country (`country`, `country-code`, or `country code`).
  - The graph host record carries `hostname`, `organization`, and `country`.
    The canvas label uses the hostname for local hosts and external hosts
    alike, falling back to the organization when no hostname is known. Long
    labels are truncated to their last two dotted portions.
  - If no name is available the label is left empty. Resolution results are
    pushed to clients as `host` messages and fill in the label and host info
    window when they arrive.
- Colour coding:
  - **Green** — local/private-network host.
  - **Blue** — remote/external host.
  - **Grey** — silent host that has not sent a packet.
  - **Dimmed (30% opacity)** — passive host with no traffic sent or received
    within the passive timeout (default 120 s).
  - **Glow** — host that sent a packet within the active glow duration (default
    10 s). The glow fades in on activity and fades out smoothly instead of
    toggling abruptly.
- Blob radius scales with traffic volume (sent + received bytes): the busiest
  host uses the maximum size, the least busy the minimum, others interpolate
  linearly.
- Blob mass is proportional to its radius, so heavier blobs move less in the
  force layout and collision resolution.

### Edges

- Each unique ordered IP pair (source → destination) is an edge.
- Edges are drawn behind hosts and accumulate packet count and byte totals.
- Only TCP connections to the NetVis frontend on its web port (reported in the
  snapshot as `webPort`) that involve one of the server's addresses are rendered
  as a thin glowing yellow line. Other traffic to/from the server machine is
  treated normally.

### Packets

- Each aggregated traffic record spawns a sampled particle from source to
  destination, except TCP connections to the NetVis frontend, which have no
  particles (the glowing edge represents them). Each record spawns at most four
  particles, and each connection (directed edge) is limited in particles
  per second, so a busy pair still shows sustained motion without flooding the
  canvas.
- At high packet rates the renderer keeps a bounded visual budget (400 in-flight
  particles) and samples new particles instead of evicting particles that are
  still travelling. Each particle may therefore represent more than one packet,
  but every spawned particle reaches its destination.
- Traffic records are queued and applied once per animation frame, so per-message
  JavaScript work does not scale with host/edge updates or DOM writes.
- Particle position is recalculated from the live host positions every frame, so
  fast-moving hosts are not missed.
- Particle motion is frame-rate independent.
- Colour is determined by protocol: TCP (blue), UDP (green), ICMP (orange),
  other (red).
- Size is derived from packet bytes on a log scale, multiplied by the packet-size
  setting.
- Glow is drawn from cached pre-rendered sprites (one per protocol colour)
  instead of a per-particle Canvas `shadowBlur`.

### Layout and interactions

- A force layout pulls connected hosts together. Attraction strength depends on
  locality: local↔local, local↔external, external↔external have separate,
  configurable strengths.
- Collision resolution uses each host's combined blob + IP/hostname label
  bounding box as a soft repulsion (a fraction of the overlap is resolved per
  frame). The collision area scales with the rendered label content, with extra
  vertical spacing so IP/hostname labels on nearby hosts don't touch.
- The world is finite, but its walls are not hard stops: whenever a blob would
  cross an edge, the world expands symmetrically in every direction around the
  centering-force centre. Dragged blobs also trigger expansion instead of being
  clamped at the boundary.
- Long IPv6 address labels are truncated for display; copying a host still uses
  the full address.
- Blob velocity is damped by drag, so blobs settle instead of creeping forward.
- The view is controlled by a camera (scale + offset) rather than by scaling host
  positions. Zoom/fit leaves graph coordinates independent of the viewport.
- Dragging a blob repositions it and temporarily excludes it from physics.
- A host info window opens next to the host after hovering it for 0.5 s, or when
  the host is clicked. Clicking a host pins the window; clicking anywhere outside
  the window dismisses it. Small blobs use a fixed minimum click area of twice the
  default minimum host size, so they are easier to click and drag; the extra area
  applies only when the blob itself is smaller than that.
- The window shows the host's IPv4 and IPv6 addresses (each on its own line,
  omitted when the host has no address of that family), hostname, organization,
  country, total packet count (sent + received), total data sent, total data
  received, and last active time. It follows the host as the layout moves and
  updates live as traffic arrives.
- Clicking any field in the window copies that field's text to the clipboard and
  shows a toast notification.
- A hover-opened window closes once the cursor has been outside both the host and
  the window for 0.3 s. Hovering the window keeps it open, and dragging a host
  does not trigger hover tooltips.
- The canvas is cleared to opaque black each frame to prevent smearing/trails.

## Frontend controls

### Legend (top-left)

Shows host and protocol colours plus Hosts/Connections counters. A `−`/`+`
button collapses the legend groups while keeping the NetVis title and counters
visible.

### Settings menu (top-right hamburger)

Sliders:

- Attraction local↔local (default 0.100)
- Attraction local↔external (default 0.660)
- Attraction external↔external (default 0.020)
- Packet speed (default 0.005)
- Packet size (default 0.3)
- Min host size (default 5 px)
- Max host size (default 44 px)
- Active glow duration (default 10 s)
- Passive timeout (default 120 s)
- Auto-remove passive hosts (checkbox, off by default; checked hosts are pruned
  continuously once they become passive)
- Auto-remove passive remote hosts (checkbox, off by default; only non-local
  hosts are pruned once they become passive)
- Frame rate limit (Unlimited, 15, 30 or 60 FPS; limits rendering and physics
  updates and defaults to Unlimited)

Buttons:

- **Remove silent hosts** — hosts that have never sent a packet.
- **Remove passive hosts** — hosts with no activity beyond the passive timeout.

Removing hosts also prunes edges that reference them.

### View controls (bottom-right)

- `+` / `−` buttons zoom in and out around the viewport centre.
- The frame button fits all hosts and their labels into view.
- The mouse wheel zooms toward the cursor; on touch devices a two-finger pinch
  zooms and pans while one finger drags a host.

## Project Status

MVP implemented and building. All planned scaffolding, capture, state, backend,
frontend, and integration steps below are complete.

## Steps to a Working Program

### 1) Project scaffolding
- [x] Create standard Go layout (`cmd/netvis/`, `internal/capture/`,
      `internal/graph/`, `internal/server/`, `web/static/`).
- [x] Add `README.md` usage notes (build, permissions, interfaces).
- [x] Define dependencies in `go.mod` (`gopacket` for capture, `gorilla/websocket`
      for realtime).

### 2) Packet capture
- [x] Live interface capture via libpcap with `-iface` and optional BPF filter.
- [x] Parse packets to extract L3/L4: IP (src/dst), protocol (TCP/UDP/ICMP/other),
      length/size.
- [x] Surface permission errors and document root/`CAP_NET_RAW` requirements.
- [x] Emit normalized `{ts, srcIP, dstIP, proto, bytes}` events.

### 3) Graph/state model
- [x] Track hosts by IP with async, cached display-name resolution: reverse DNS
      for local hosts and whois organization for external hosts (timeouts, empty
      on failure, pushed to clients via `host` messages).
- [x] Track edges keyed by `srcIP->dstIP` with packet/byte totals.
- [x] Thread-safe access via `sync.RWMutex` for capture-fed state.
- [x] In-memory retained hosts/edges with client snapshots.

### 4) Backend server (API + realtime)
- [x] HTTP server serving static frontend.
- [x] WebSocket hub streaming aggregated traffic records and initial snapshots.
- [x] Ping/pong keepalive and slow-client handling.
- [x] Same-origin usage; permissive origin check for local development.

### 5) Frontend visualization (2D canvas)
- [x] Canvas renderer with drifting host blobs and force layout.
- [x] Hosts rendered once per IP, avoiding duplicates.
- [x] Edges rendered between IP pairs behind hosts.
- [x] Animated particles with protocol colour and size based on packet bytes.
- [x] WebSocket connection with snapshot + incremental updates.
- [x] Traffic-scaled host sizes, mass-based physics, label-aware collision
      avoidance, drag/friction, and camera zoom with fit-to-view.
- [x] Active glow, passive dimming, clipboard copy, and server-edge highlighting.

### 6) Integration, run, and validation
- [x] Wire capture → state → WebSocket broadcast → frontend.
- [x] CLI flags for interface, BPF filter, and listen address.
- [x] Manual validation on a live interface with generated traffic.
- [x] Document permissions/setup in README.

### MVP acceptance criteria
- [x] Program compiles and runs as `netvis` (`go build ./cmd/netvis`).
- [x] Captures live packets on a specified interface.
- [x] Serves a web UI showing hosts, edges, and animated particles by
      protocol/size.
- [x] No duplicate hosts/edges.

## Open Issues / Future Work

### Completed performance work

- [x] Add automated tests for capture parsing, graph aggregation, and hub
      behaviour, including a sustained-traffic batching regression test.
- [x] Redraw only when needed (dirty flags + idle skip).
- [x] Batch WebSocket messages on the server with a fixed 16 ms window and a
      bounded batch size, instead of a debounce that sustained traffic could
      postpone indefinitely.
- [x] Remove client-map deletions from an `RLock` path so slow-client cleanup
      cannot race with broadcasts.
- [x] Aggregate traffic server-side per directed edge, protocol, and frontend
      flag over each 16 ms window, sending packet counts and byte totals instead
      of one event per packet. Bandwidth and client work now scale with active
      graph elements rather than packet rate.
- [x] Remove the hub's per-message JSON unmarshal/re-marshal in `flushBatch`.
      Traffic aggregates are marshaled once and host messages are appended to
      the batch as pre-serialized fragments.
- [x] Pre-rendered, cached glow sprites for packet particles (no per-particle
      `shadowBlur`).
- [x] Bounded particle budget with packet sampling instead of evicting the
      oldest in-flight particles.
- [x] Apply traffic records once per animation frame, with a bounded pending
      queue for backgrounded tabs, and update stats/host sizes only when values
      change rather than per packet.
- [x] Frame-rate-independent particle motion.
- [x] Spatial indexing for collision detection (grid-based neighbor queries).
- [x] Cache host arrays to avoid repeated allocations.
- [x] Throttle physics updates to 30 Hz with accumulator.
- [x] Place new blobs near a connected peer or the world centre without
      overlapping existing hosts' influence spheres, replacing the expensive
      edge-crossing candidate scan.

### Backend memory and long-run stability ideas

The backend keeps hosts, edges, and resolution caches for the lifetime of the
process. Frontend removal controls only change browser state, so they do not
free server memory. The ideas below are grouped by the failure mode they
address. IDs are stable and intended for referencing in discussions and
commits.

#### Bounded memory growth

- [x] **B1 — Expire idle hosts and edges with a TTL.** Record `LastSeen` on
  every host and edge and run a periodic janitor that removes entries idle
  beyond a configurable TTL, pruning their edges and cache entries at the same
  time. *Reasoning:* every unique IP and directed pair observed since startup is
  retained forever, so a long-running capture grows without bound. Implemented
  as `-host-ttl`; the default `0` keeps everything.
- [ ] **B2 — Enforce hard caps with least-recently-active eviction.** Add
  configurable maximum host and edge counts and evict the least recently active
  entries when a cap is reached. *Reasoning:* a TTL alone still permits a large
  burst of new addresses to exhaust memory; a cap gives a predictable worst
  case. The host-cap portion is implemented as `-max-hosts`; an edge cap
  remains future work.
- **B3 — Bound and purge resolution caches.** Give `nameCache` and
  `nameGroups` a TTL and size limit, and delete a host's cache entry when the
  host is evicted. *Reasoning:* both maps only ever grow, including permanent
  negative DNS/whois results, and stale names are never refreshed.
- **B4 — Bound queues by bytes, not only message count.** Apply byte budgets
  to `pendingBatch` and each client's `send` channel, in addition to the
  existing message-count limits. *Reasoning:* 2048 batch messages or 256 queued
  client messages can each be very large when host messages carry long group
  address lists.
- **B5 — Cap concurrent WebSocket clients.** Set a maximum number of
  connections and reject or queue excess clients. *Reasoning:* each client
  reserves a 256-message buffer and receives a full snapshot; with a permissive
  origin check, unbounded connections are a memory and file-descriptor risk.

#### Bounded lookup work

- **B6 — Resolve names through a fixed worker pool.** Replace the goroutine
  started per new IP with a small pool and a bounded work queue, dropping or
  delaying work when the queue is full. *Reasoning:* a burst of new addresses
  can create thousands of goroutines and sockets at once.
- **B7 — Use context-aware DNS with cancellation.** Call a resolver that
  accepts a context instead of wrapping `net.LookupAddr` in a goroutine and
  `time.After`. *Reasoning:* a timed-out lookup can leave its goroutine and
  timer alive until the resolver returns, so leaks accumulate under load.
- **B8 — Rate-limit and share whois queries.** Add a global whois limiter and
  cache the IANA referral by prefix so concurrent lookups do not repeat the
  same chain. *Reasoning:* each external host can trigger up to six TCP queries
  over tens of seconds, risking file-descriptor exhaustion and rate limiting by
  the RIRs.
- **B9 — Cache whois results by network prefix.** Key organization and country
  results by the containing CIDR rather than by individual IP. *Reasoning:*
  whois answers describe allocation blocks, so many hosts share one result;
  per-IP caching repeats queries and stores redundant data.
- **B10 — Cap whois response buffers more tightly.** Lower the 1 MiB
  per-response limit or stream-parse the fields of interest. *Reasoning:* each
  in-flight lookup can hold a large buffer, and the useful fields usually
  appear early in the response.
- **B11 — Expire or back off negative lookup results.** Keep failed lookups
  cached for a bounded time instead of forever. *Reasoning:* permanent negative
  caching avoids retry storms but never frees memory and can hide transient
  resolver failures.

#### Algorithmic scaling and CPU

- **B12 — Index host groups incrementally.** Maintain a
  `hostname/group → members` index instead of scanning every host on each
  resolution. *Reasoning:* `applyResolvedDetails` is O(N) per resolved host,
  which becomes O(N²) over a long run.
- **B13 — Share group address lists.** Store group membership once and derive
  `IPs` at snapshot time, or share a read-only slice, instead of copying the
  full list into every member. *Reasoning:* a group with k addresses currently
  stores k slices of k strings, which is O(k²) memory.
- **B14 — Send incremental group updates.** Broadcast the changed host or a
  compact group update instead of every member when one address joins a group.
  *Reasoning:* joining a k-address group currently emits O(k) updates and
  produces O(k²) messages over the group's lifetime.
- **B15 — Reduce snapshot cost and lock hold time.** Copy state before
  marshaling, send snapshots without an unconditional blocking channel send,
  and consider streaming or paginating large snapshots. *Reasoning:* a snapshot
  holds the graph read lock while copying every host and edge, and a large one
  can stall capture-side updates and the hub.
- **B16 — Reuse per-window buffers and allocation-free keys.** Reuse the
  traffic map and batch slice, and key edges with a struct or `netip.Addr`
  instead of a concatenated string. *Reasoning:* allocating a map every 16 ms
  and building a string key per packet creates GC pressure that grows with
  traffic volume.

#### Observability and validation

- **B17 — Expose state metrics and pprof.** Add a metrics endpoint for host,
  edge, cache, pending-lookup, goroutine, and heap counts, plus
  `net/http/pprof`. *Reasoning:* there is currently no way to see which store
  is growing before the process runs out of memory.
- **B18 — Add scale and long-run tests.** Feed synthetic workloads with many
  unique IPs and assert that eviction, caps, and cache bounds hold.
  *Reasoning:* existing tests cover correctness and batching, not growth over
  time.
- **B19 — Let clients request deletion (complementary).** Add a WebSocket
  message for the frontend's remove actions so the server can free state
  promptly. *Reasoning:* the UI's remove buttons currently affect only browser
  state; authoritative TTLs and caps should remain, but explicit deletion
  avoids keeping data the user already discarded.

### Remaining performance improvement ideas

- [ ] **P1** — Consider compact array records or binary encoding for traffic
      messages on very large graphs.
- [ ] **P2** — Cache label measurements/bounds per host, keyed by label text and
      rounded radius, and avoid clearing the whole cache whenever a radius
      changes. Reuse the cached measurements while drawing instead of calling
      `measureText` for every label every frame.
- [ ] **P3** — Draw all regular edges in a single path and stroke once, and batch
      the glowing frontend edges similarly, instead of one
      `beginPath`/`stroke` per edge.
- [ ] **P4** — Use cached pre-rendered sprites for host glow as well; host
      rendering still uses a per-host `shadowBlur`.
- [ ] **P5** — Cache locality per host (`isLocalIP`) instead of parsing the IP
      string for every edge during physics and rendering.
- [ ] **P6** — Reuse the undirected adjacency map across physics steps, avoid
      per-step object/sort allocations during angle distribution, and use
      numeric collision-pair keys instead of string keys in the processed-pair
      set.
- [ ] **P7** — Skip physics entirely when all hosts are below the sleep
      thresholds and no layout input, host set, or drag state has changed.
- [ ] **P8** — Object pooling or a ring buffer for particles to reduce allocation
      and GC pressure.
- [ ] **P9** — Add adaptive quality controls: lower the particle budget, skip
      glow, or reduce physics/render rates when frame time exceeds a target
      budget.
- [ ] **P10** — Limit `frontendConnections` set size with TTL/LRU cleanup.
- [ ] **P11** — Rate-limit/cache whois lookups more aggressively and add a
      bounded lookup worker pool for very large host sets (expanded in B6–B9).
- [ ] **P12** — Persist or replay capture sessions (pcap export/import).
- [ ] **P13** — Support VLAN/MPLS and improve IPv6 handling.
- [ ] **P14** — Use OffscreenCanvas/Web Worker for rendering on large graphs.
- [ ] **P15** — Consider WebGL renderer for improved performance with many
      hosts/particles.
- [ ] **P16** — Incremental spatial grid updates instead of full rebuilds each
      physics step.
