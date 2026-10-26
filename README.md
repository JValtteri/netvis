# Network Traffic Visualizer

Provides a live graphical representation of network traffic.

## Build

Requires `libpcap-dev` (Linux). Install on Debian/Ubuntu:

```bash
sudo apt install libpcap-dev
```

Build:

```bash
go build ./cmd/netvis
```

Or run directly:

```bash
sudo go run ./cmd/netvis -iface eth0
```

## Usage

```bash
sudo ./netvis -iface <interface> [-filter "tcp port 80"] [-addr :8080]
```

- `-iface` (required): network interface to capture on
- `-filter`: optional BPF filter
- `-addr`: HTTP listen address (default `:8080`)

Open http://localhost:8080 in your browser. Requires root/CAP_NET_RAW for packet capture.

## Features

- Live packet capture via libpcap
- Web UI with 2D canvas visualization
- Hosts shown as blobs with IP/hostname
- Edges between IP pairs
- Animated particles along edges (color by protocol, size by packet size)
- Real-time updates via WebSocket
