package graph

import (
	"net"
	"strings"
	"sync"
	"time"

	"netvis/internal/capture"
)

type Host struct {
	IP       string `json:"ip"`
	Hostname string `json:"hostname"`
}

type Edge struct {
	SrcIP string `json:"srcIP"`
	DstIP string `json:"dstIP"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`
}

type Graph struct {
	mu      sync.RWMutex
	hosts   map[string]*Host
	edges   map[string]*Edge
	onHost  func(Host)
	resolve func(string) string

	lookupMu  sync.Mutex
	nameCache map[string]string
	pending   map[string]bool
}

func New() *Graph {
	return &Graph{
		hosts:     make(map[string]*Host),
		edges:     make(map[string]*Edge),
		nameCache: make(map[string]string),
		pending:   make(map[string]bool),
		resolve:   resolveName,
	}
}

// SetHostUpdateHandler registers a callback invoked when a host's display name
// (hostname or whois organization) has been resolved asynchronously.
func (g *Graph) SetHostUpdateHandler(fn func(Host)) {
	g.mu.Lock()
	g.onHost = fn
	g.mu.Unlock()
}

func (g *Graph) edgeKey(src, dst string) string {
	return src + "->" + dst
}

func (g *Graph) Apply(ev capture.Event) {
	var newHosts []string

	g.mu.Lock()
	// Ensure hosts exist
	if _, ok := g.hosts[ev.SrcIP]; !ok {
		g.hosts[ev.SrcIP] = &Host{IP: ev.SrcIP, Hostname: g.cachedName(ev.SrcIP)}
		newHosts = append(newHosts, ev.SrcIP)
	}
	if _, ok := g.hosts[ev.DstIP]; !ok {
		g.hosts[ev.DstIP] = &Host{IP: ev.DstIP, Hostname: g.cachedName(ev.DstIP)}
		newHosts = append(newHosts, ev.DstIP)
	}

	k := g.edgeKey(ev.SrcIP, ev.DstIP)
	if e, ok := g.edges[k]; ok {
		e.Count++
		e.Bytes += int64(ev.Bytes)
	} else {
		g.edges[k] = &Edge{
			SrcIP: ev.SrcIP,
			DstIP: ev.DstIP,
			Count: 1,
			Bytes: int64(ev.Bytes),
		}
	}
	g.mu.Unlock()

	for _, ip := range newHosts {
		g.scheduleLookup(ip)
	}
}

func (g *Graph) cachedName(ip string) string {
	g.lookupMu.Lock()
	defer g.lookupMu.Unlock()
	return g.nameCache[ip]
}

// scheduleLookup resolves a display name for the host without blocking packet
// processing. Local hosts use reverse DNS; external hosts use a whois
// organization lookup.
func (g *Graph) scheduleLookup(ip string) {
	g.lookupMu.Lock()
	if _, ok := g.nameCache[ip]; ok {
		g.lookupMu.Unlock()
		return
	}
	if g.pending[ip] {
		g.lookupMu.Unlock()
		return
	}
	g.pending[ip] = true
	g.lookupMu.Unlock()

	go func() {
		resolve := g.resolve
		if resolve == nil {
			resolve = resolveName
		}
		name := resolve(ip)

		g.lookupMu.Lock()
		g.nameCache[ip] = name
		delete(g.pending, ip)
		g.lookupMu.Unlock()

		var (
			updated Host
			found   bool
			cb      func(Host)
		)
		g.mu.Lock()
		if h, ok := g.hosts[ip]; ok {
			h.Hostname = name
			updated = *h
			found = true
			cb = g.onHost
		}
		g.mu.Unlock()

		if found && cb != nil {
			cb(updated)
		}
	}()
}

func resolveName(ip string) string {
	parsed := net.ParseIP(ip)
	if parsed != nil && isLocalIP(parsed) {
		return lookupHostname(ip)
	}
	return lookupWhoisOrg(ip)
}

func isLocalIP(ip net.IP) bool {
	return ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified()
}

func lookupHostname(ip string) string {
	done := make(chan string, 1)
	go func() {
		names, err := net.LookupAddr(ip)
		if err != nil || len(names) == 0 {
			done <- ""
			return
		}
		done <- strings.TrimSuffix(names[0], ".")
	}()

	select {
	case h := <-done:
		return h
	case <-time.After(500 * time.Millisecond):
		return ""
	}
}

type Snapshot struct {
	Hosts []Host `json:"hosts"`
	Edges []Edge `json:"edges"`
}

func (g *Graph) Snapshot() Snapshot {
	g.mu.RLock()
	defer g.mu.RUnlock()

	s := Snapshot{}
	for _, h := range g.hosts {
		s.Hosts = append(s.Hosts, *h)
	}
	for _, e := range g.edges {
		s.Edges = append(s.Edges, *e)
	}
	return s
}
