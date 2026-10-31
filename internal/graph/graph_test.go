package graph

import (
	"net"
	"sync/atomic"
	"testing"
	"time"

	"netvis/internal/capture"
)

func TestIsLocalIP(t *testing.T) {
	cases := []struct {
		ip   string
		want bool
	}{
		{"192.168.1.10", true},
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"172.32.0.1", false},
		{"127.0.0.1", true},
		{"169.254.1.1", true},
		{"0.0.0.0", true},
		{"8.8.8.8", false},
		{"1.1.1.1", false},
		{"::1", true},
		{"fe80::1", true},
		{"fd00::1", true},
		{"2001:4860:4860::8888", false},
	}

	for _, tc := range cases {
		t.Run(tc.ip, func(t *testing.T) {
			ip := net.ParseIP(tc.ip)
			if ip == nil {
				t.Fatalf("failed to parse %q", tc.ip)
			}
			if got := isLocalIP(ip); got != tc.want {
				t.Errorf("isLocalIP(%s) = %v, want %v", tc.ip, got, tc.want)
			}
		})
	}
}

func TestApplyCreatesHostsAndAggregatesEdges(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }

	g.Apply(capture.Event{
		Timestamp: time.Now(),
		SrcIP:     "10.0.0.1",
		DstIP:     "8.8.8.8",
		Proto:     "TCP",
		Bytes:     100,
	})
	g.Apply(capture.Event{
		Timestamp: time.Now(),
		SrcIP:     "10.0.0.1",
		DstIP:     "8.8.8.8",
		Proto:     "TCP",
		Bytes:     50,
	})

	snap := g.Snapshot()
	if len(snap.Hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(snap.Hosts))
	}
	if len(snap.Edges) != 1 {
		t.Fatalf("got %d edges, want 1", len(snap.Edges))
	}
	edge := snap.Edges[0]
	if edge.SrcIP != "10.0.0.1" || edge.DstIP != "8.8.8.8" {
		t.Errorf("unexpected edge endpoints: %s -> %s", edge.SrcIP, edge.DstIP)
	}
	if edge.Count != 2 {
		t.Errorf("edge count = %d, want 2", edge.Count)
	}
	if edge.Bytes != 150 {
		t.Errorf("edge bytes = %d, want 150", edge.Bytes)
	}
}

func TestApplySeparatesDirectionalEdges(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 10})
	g.Apply(capture.Event{SrcIP: "8.8.8.8", DstIP: "10.0.0.1", Proto: "TCP", Bytes: 20})

	snap := g.Snapshot()
	if len(snap.Edges) != 2 {
		t.Fatalf("got %d edges, want 2 directional edges", len(snap.Edges))
	}
}

func TestHostNameResolutionIsAsyncAndPushed(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails {
		return hostDetails{Hostname: "test.example", Organization: "Test Org", Country: "US"}
	}

	updates := make(chan Host, 4)
	g.SetHostUpdateHandler(func(h Host) { updates <- h })

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "UDP", Bytes: 1})

	seen := map[string]Host{}
	deadline := time.After(2 * time.Second)
	for len(seen) < 2 {
		select {
		case h := <-updates:
			seen[h.IP] = h
		case <-deadline:
			t.Fatalf("timed out waiting for host updates, saw %v", seen)
		}
	}

	for _, ip := range []string{"10.0.0.1", "8.8.8.8"} {
		h := seen[ip]
		if h.Hostname != "test.example" {
			t.Errorf("update for %s hostname = %q, want %q", ip, h.Hostname, "test.example")
		}
		if h.Organization != "Test Org" {
			t.Errorf("update for %s organization = %q, want %q", ip, h.Organization, "Test Org")
		}
		if h.Country != "US" {
			t.Errorf("update for %s country = %q, want %q", ip, h.Country, "US")
		}
	}

	snap := g.Snapshot()
	for _, h := range snap.Hosts {
		if h.Hostname != "test.example" {
			t.Errorf("snapshot host %s hostname = %q, want %q", h.IP, h.Hostname, "test.example")
		}
		if h.Organization != "Test Org" || h.Country != "US" {
			t.Errorf("snapshot host %s details = %+v, want organization %q country %q", h.IP, h, "Test Org", "US")
		}
	}
}

func TestHostNameResolutionIsCached(t *testing.T) {
	g := New()
	var calls int32
	g.resolve = func(string) hostDetails {
		atomic.AddInt32(&calls, 1)
		return hostDetails{Hostname: "cached.example"}
	}

	updates := make(chan Host, 4)
	g.SetHostUpdateHandler(func(h Host) { updates <- h })

	event := capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1}
	g.Apply(event)
	for i := 0; i < 2; i++ {
		select {
		case <-updates:
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for initial resolution")
		}
	}

	g.Apply(event)
	time.Sleep(50 * time.Millisecond)

	if got := atomic.LoadInt32(&calls); got != 2 {
		t.Errorf("resolver called %d times, want 2 (one per host, cached afterwards)", got)
	}
}

func TestHostsWithSameHostnameAreGrouped(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails {
		return hostDetails{Hostname: "dual-stack.example"}
	}

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "2001:db8::1", Proto: "TCP", Bytes: 1})

	var snap Snapshot
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap = g.Snapshot()
		if len(snap.Hosts) == 2 && snap.Hosts[0].Group != "" &&
			snap.Hosts[0].Group == snap.Hosts[1].Group {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(snap.Hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(snap.Hosts))
	}

	a, b := snap.Hosts[0], snap.Hosts[1]
	if a.Group == "" || a.Group != b.Group {
		t.Fatalf("groups differ: %q and %q", a.Group, b.Group)
	}
	if a.Group != a.IP && a.Group != b.IP {
		t.Errorf("group %q is not one of the host IPs", a.Group)
	}
	if len(a.IPs) != 2 || len(b.IPs) != 2 {
		t.Fatalf("address lists = %v / %v, want two addresses each", a.IPs, b.IPs)
	}
	// IPv4 is preferred for display.
	if a.IPs[0] != "10.0.0.1" || b.IPs[0] != "10.0.0.1" {
		t.Errorf("address lists = %v / %v, want IPv4 first", a.IPs, b.IPs)
	}
}

func TestHostsWithDifferentHostnamesStaySeparate(t *testing.T) {
	g := New()
	g.resolve = func(ip string) hostDetails {
		return hostDetails{Hostname: "host-" + ip}
	}

	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "10.0.0.2", Proto: "TCP", Bytes: 1})

	var snap Snapshot
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snap = g.Snapshot()
		if len(snap.Hosts) == 2 && snap.Hosts[0].Hostname != "" && snap.Hosts[1].Hostname != "" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(snap.Hosts) != 2 {
		t.Fatalf("got %d hosts, want 2", len(snap.Hosts))
	}
	if snap.Hosts[0].Group == snap.Hosts[1].Group {
		t.Fatalf("distinct hosts share group %q", snap.Hosts[0].Group)
	}
	for _, h := range snap.Hosts {
		if len(h.IPs) != 1 || h.IPs[0] != h.IP {
			t.Errorf("host %s address list = %v, want only itself", h.IP, h.IPs)
		}
	}
}

func TestSnapshotIsACopy(t *testing.T) {
	g := New()
	g.resolve = func(string) hostDetails { return hostDetails{} }
	g.Apply(capture.Event{SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1})

	snap := g.Snapshot()
	snap.Hosts[0].IP = "mutated"
	snap.Edges[0].Bytes = 999

	fresh := g.Snapshot()
	for _, h := range fresh.Hosts {
		if h.IP == "mutated" {
			t.Fatal("snapshot shares host memory with graph state")
		}
	}
	if fresh.Edges[0].Bytes == 999 {
		t.Fatal("snapshot shares edge memory with graph state")
	}
}
