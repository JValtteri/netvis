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
	mu        sync.RWMutex
	hosts     map[string]*Host
	edges     map[string]*Edge
	dnsCache  map[string]string
	dnsMu     sync.RWMutex
}

func New() *Graph {
	return &Graph{
		hosts:    make(map[string]*Host),
		edges:    make(map[string]*Edge),
		dnsCache: make(map[string]string),
	}
}

func (g *Graph) edgeKey(src, dst string) string {
	return src + "->" + dst
}

func (g *Graph) Apply(ev capture.Event) {
	g.mu.Lock()
	defer g.mu.Unlock()

	// Ensure hosts exist
	if _, ok := g.hosts[ev.SrcIP]; !ok {
		g.hosts[ev.SrcIP] = &Host{IP: ev.SrcIP, Hostname: g.lookupHostname(ev.SrcIP)}
	}
	if _, ok := g.hosts[ev.DstIP]; !ok {
		g.hosts[ev.DstIP] = &Host{IP: ev.DstIP, Hostname: g.lookupHostname(ev.DstIP)}
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
}

func (g *Graph) lookupHostname(ip string) string {
	g.dnsMu.RLock()
	if h, ok := g.dnsCache[ip]; ok {
		g.dnsMu.RUnlock()
		return h
	}
	g.dnsMu.RUnlock()

	// Best effort async-like lookup with timeout
	done := make(chan string, 1)
	go func() {
		names, err := net.LookupAddr(ip)
		if err != nil || len(names) == 0 {
			done <- ip
			return
		}
		h := strings.TrimSuffix(names[0], ".")
		g.dnsMu.Lock()
		g.dnsCache[ip] = h
		g.dnsMu.Unlock()
		done <- h
	}()

	select {
	case h := <-done:
		return h
	case <-time.After(200 * time.Millisecond):
		g.dnsMu.Lock()
		g.dnsCache[ip] = ip
		g.dnsMu.Unlock()
		return ip
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
