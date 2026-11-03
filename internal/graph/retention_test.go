package graph

import (
	"testing"
	"time"

	"netvis/internal/capture"
)

func waitForCondition(t *testing.T, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not met before timeout")
}

func TestRetentionKeepsEverythingByDefault(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1})
	g.Prune(time.Now().Add(365 * 24 * time.Hour))

	snap := g.Snapshot()
	if len(snap.Hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(snap.Hosts))
	}
	if len(snap.Edges) != 1 {
		t.Fatalf("got %d edges, want 1", len(snap.Edges))
	}
}

func TestHostTTLExpiresHostsEdgesAndCaches(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails {
		return hostDetails{Hostname: "example.test", Organization: "Example"}
	}
	g.SetRetention(time.Minute, 0)

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1})

	waitForCondition(t, 2*time.Second, func() bool {
		snap := g.Snapshot()
		if len(snap.Hosts) != 2 {
			return false
		}
		for _, h := range snap.Hosts {
			if h.Hostname == "" {
				return false
			}
		}
		return true
	})

	g.lookupMu.Lock()
	cacheLen := len(g.nameCache)
	g.lookupMu.Unlock()
	if cacheLen != 2 {
		t.Fatalf("name cache entries = %d, want 2", cacheLen)
	}

	g.Prune(time.Now().Add(2 * time.Minute))

	snap := g.Snapshot()
	if len(snap.Hosts) != 0 {
		t.Fatalf("got %d hosts after expiry, want 0", len(snap.Hosts))
	}
	if len(snap.Edges) != 0 {
		t.Fatalf("got %d edges after expiry, want 0", len(snap.Edges))
	}

	g.lookupMu.Lock()
	cacheLen = len(g.nameCache)
	pendingLen := len(g.pending)
	g.lookupMu.Unlock()
	if cacheLen != 0 {
		t.Errorf("name cache entries = %d after expiry, want 0", cacheLen)
	}
	if pendingLen != 0 {
		t.Errorf("pending lookups = %d after expiry, want 0", pendingLen)
	}

	g.mu.RLock()
	groupLen := len(g.nameGroups)
	g.mu.RUnlock()
	if groupLen != 0 {
		t.Errorf("name groups = %d after expiry, want 0", groupLen)
	}
}

func TestHostTTLExpiresIdleEdgesButKeepsActiveHosts(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }
	g.SetRetention(time.Minute, 0)

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "10.0.0.2", Proto: "TCP", Bytes: 1})
	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "10.0.0.3", Proto: "TCP", Bytes: 1})

	now := time.Now()
	g.mu.Lock()
	g.edges[g.edgeKey("10.0.0.1", "10.0.0.2")].lastSeen = now.Add(-2 * time.Minute)
	for _, h := range g.hosts {
		h.lastSeen = now
	}
	g.mu.Unlock()

	g.Prune(now)

	snap := g.Snapshot()
	if len(snap.Hosts) != 3 {
		t.Fatalf("got %d hosts, want 3", len(snap.Hosts))
	}
	if len(snap.Edges) != 1 {
		t.Fatalf("got %d edges, want 1", len(snap.Edges))
	}
	if snap.Edges[0].SrcIP != "10.0.0.1" || snap.Edges[0].DstIP != "10.0.0.3" {
		t.Errorf("unexpected remaining edge: %s -> %s", snap.Edges[0].SrcIP, snap.Edges[0].DstIP)
	}
}

func TestMaxHostsEvictsLeastRecentlyActive(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "10.0.0.2", Proto: "TCP", Bytes: 1})
	g.Apply(capture.Event{SrcIP: "10.0.0.2", DstIP: "10.0.0.3", Proto: "TCP", Bytes: 1})

	base := time.Now()
	g.mu.Lock()
	g.hosts["10.0.0.1"].lastSeen = base
	g.hosts["10.0.0.2"].lastSeen = base.Add(time.Second)
	g.hosts["10.0.0.3"].lastSeen = base.Add(2 * time.Second)
	g.mu.Unlock()

	g.SetRetention(0, 2)

	snap := g.Snapshot()
	if len(snap.Hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(snap.Hosts))
	}
	for _, h := range snap.Hosts {
		if h.IP == "10.0.0.1" {
			t.Errorf("least recently active host was not evicted: %+v", h)
		}
	}
	if len(snap.Edges) != 1 {
		t.Fatalf("got %d edges, want 1", len(snap.Edges))
	}
	if snap.Edges[0].SrcIP != "10.0.0.2" || snap.Edges[0].DstIP != "10.0.0.3" {
		t.Errorf("edge referencing evicted host was not pruned: %s -> %s", snap.Edges[0].SrcIP, snap.Edges[0].DstIP)
	}
}

func TestStartRetentionPrunesAndStops(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }
	g.SetRetention(10*time.Millisecond, 0)
	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1})

	stop := g.StartRetention(5 * time.Millisecond)
	defer stop()

	waitForCondition(t, 2*time.Second, func() bool {
		snap := g.Snapshot()
		return len(snap.Hosts) == 0 && len(snap.Edges) == 0
	})

	// Stopping twice is safe.
	stop()
	stop()
}

func TestRetentionRepairsGroupAfterCanonicalEviction(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{Hostname: "dual-stack.test"} }

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "2001:db8::1", Proto: "TCP", Bytes: 1})

	waitForCondition(t, 2*time.Second, func() bool {
		snap := g.Snapshot()
		return len(snap.Hosts) == 2 && len(snap.Hosts[0].IPs) == 2 && len(snap.Hosts[1].IPs) == 2
	})

	g.mu.Lock()
	canonical := g.nameGroups["dual-stack.test"]
	member := ""
	for ip := range g.hosts {
		if ip != canonical {
			member = ip
		}
	}
	if member == "" {
		g.mu.Unlock()
		t.Fatal("group does not have two members")
	}
	base := time.Now()
	g.hosts[canonical].lastSeen = base
	g.hosts[member].lastSeen = base.Add(time.Second)
	g.mu.Unlock()

	g.SetRetention(0, 1)

	snap := g.Snapshot()
	if len(snap.Hosts) != 1 {
		t.Fatalf("got %d hosts, want 1", len(snap.Hosts))
	}
	h := snap.Hosts[0]
	if h.IP != member {
		t.Errorf("remaining host = %s, want %s", h.IP, member)
	}
	if h.Group != member {
		t.Errorf("remaining host group = %q, want %q", h.Group, member)
	}
	if len(h.IPs) != 1 || h.IPs[0] != member {
		t.Errorf("remaining host addresses = %v, want [%s]", h.IPs, member)
	}

	g.mu.RLock()
	canonical = g.nameGroups["dual-stack.test"]
	g.mu.RUnlock()
	if canonical != member {
		t.Errorf("name group canonical = %q, want %q", canonical, member)
	}
}
