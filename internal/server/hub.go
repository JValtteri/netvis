package server

import (
	"encoding/json"
	"net"
	"strconv"
	"strings"
	"sync"

	"netvis/internal/capture"
	"netvis/internal/graph"
)

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	g          *graph.Graph
	serverIPs  []string
	webPort    int
	mu         sync.RWMutex
}

func NewHub(g *graph.Graph, addr string) *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		g:          g,
		serverIPs:  detectServerIPs(),
		webPort:    extractPort(addr),
	}
}

// extractPort parses the port from an address like ":8080", "0.0.0.0:8080", or "[::]:8080".
func extractPort(addr string) int {
	if addr == "" {
		return 8080
	}
	// Handle IPv6 addresses
	if strings.HasPrefix(addr, "[") {
		if idx := strings.LastIndex(addr, ":"); idx != -1 {
			if p, err := strconv.Atoi(addr[idx+1 : len(addr)-1]); err == nil {
				return p
			}
		}
		return 8080
	}
	if idx := strings.LastIndex(addr, ":"); idx != -1 {
		if p, err := strconv.Atoi(addr[idx+1:]); err == nil {
			return p
		}
	}
	return 8080
}

// detectServerIPs returns the addresses assigned to this machine, across all
// interfaces. Traffic between these addresses and other hosts is local to the
// NetVis server itself.
func detectServerIPs() []string {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}

	seen := make(map[string]bool)
	ips := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		var ip net.IP
		switch v := addr.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil {
			continue
		}
		s := ip.String()
		if seen[s] {
			continue
		}
		seen[s] = true
		ips = append(ips, s)
	}
	return ips
}

func (h *Hub) Run() {
	for {
		select {
		case c := <-h.register:
			h.mu.Lock()
			h.clients[c] = true
			h.mu.Unlock()
			// send snapshot
			snap := h.g.Snapshot()
			snap.ServerIPs = h.serverIPs
			snap.WebPort = h.webPort
			if b, err := json.Marshal(map[string]interface{}{
				"type": "snapshot",
				"data": snap,
			}); err == nil {
				c.send <- b
			}
		case c := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[c]; ok {
				delete(h.clients, c)
				close(c.send)
			}
			h.mu.Unlock()
		case msg := <-h.broadcast:
			h.mu.RLock()
			for c := range h.clients {
				select {
				case c.send <- msg:
				default:
					close(c.send)
					delete(h.clients, c)
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) BroadcastEvent(ev capture.Event) {
	b, err := json.Marshal(map[string]interface{}{
		"type": "packet",
		"data": ev,
	})
	if err != nil {
		return
	}
	h.broadcast <- b
}

// BroadcastHost sends an updated host (e.g. after its hostname or whois
// organization has been resolved) to every connected client.
func (h *Hub) BroadcastHost(host graph.Host) {
	b, err := json.Marshal(map[string]interface{}{
		"type": "host",
		"data": host,
	})
	if err != nil {
		return
	}
	h.broadcast <- b
}
