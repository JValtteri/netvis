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

## Open Issues

- (tbd)
