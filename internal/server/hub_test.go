package server

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"netvis/internal/capture"
	"netvis/internal/graph"
)

type wsMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func nextMessage(t *testing.T, ch <-chan []byte) wsMessage {
	t.Helper()

	select {
	case raw := <-ch:
		var msg wsMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("unmarshal message: %v", err)
		}
		return msg
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for message")
		return wsMessage{}
	}
}

func TestHubSendsSnapshotOnRegister(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4)}
	hub.register <- client

	msg := nextMessage(t, client.send)
	if msg.Type != "snapshot" {
		t.Fatalf("message type = %q, want snapshot", msg.Type)
	}

	var snap graph.Snapshot
	if err := json.Unmarshal(msg.Data, &snap); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if len(snap.Hosts) != 0 || len(snap.Edges) != 0 {
		t.Errorf("empty graph snapshot should have no hosts/edges, got %+v", snap)
	}
	if len(snap.ServerIPs) == 0 {
		t.Error("snapshot should include the server's local addresses")
	}
}

func TestDetectServerIPs(t *testing.T) {
	ips := detectServerIPs()
	if len(ips) == 0 {
		t.Fatal("expected at least one local interface address")
	}
	for _, ip := range ips {
		if net.ParseIP(ip) == nil {
			t.Errorf("detectServerIPs returned invalid address %q", ip)
		}
	}
}

func TestHubBroadcastsPackets(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	hub.BroadcastEvent(capture.Event{
		SrcIP: "10.0.0.1",
		DstIP: "8.8.8.8",
		Proto: "UDP",
		Bytes: 42,
	})

	msg := nextMessage(t, client.send)
	if msg.Type != "packet" {
		t.Fatalf("message type = %q, want packet", msg.Type)
	}
	var ev capture.Event
	if err := json.Unmarshal(msg.Data, &ev); err != nil {
		t.Fatalf("unmarshal event: %v", err)
	}
	if ev.Proto != "UDP" || ev.Bytes != 42 {
		t.Errorf("unexpected event: %+v", ev)
	}
}

func TestHubFlushesSustainedTraffic(t *testing.T) {
	g := graph.New()
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4096)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				hub.BroadcastEvent(capture.Event{
					SrcIP: "10.0.0.1", DstIP: "8.8.8.8", Proto: "TCP", Bytes: 1400,
				})
			}
		}
	}()

	select {
	case <-client.send:
		// A message arrived while traffic was still flowing.
	case <-time.After(250 * time.Millisecond):
		close(stop)
		<-done
		t.Fatal("no batch flushed during sustained traffic; the flush window is being postponed")
	}
	close(stop)
	<-done
}

func TestHubBroadcastsHostUpdates(t *testing.T) {
	g := graph.New()
	g.SetHostUpdateHandler(nil)
	hub := NewHub(g, ":3993")
	go hub.Run()

	client := &Client{hub: hub, send: make(chan []byte, 4)}
	hub.register <- client
	nextMessage(t, client.send) // initial snapshot

	hub.BroadcastHost(graph.Host{IP: "8.8.8.8", Hostname: "Example Org"})

	msg := nextMessage(t, client.send)
	if msg.Type != "host" {
		t.Fatalf("message type = %q, want host", msg.Type)
	}
	var host graph.Host
	if err := json.Unmarshal(msg.Data, &host); err != nil {
		t.Fatalf("unmarshal host: %v", err)
	}
	if host.IP != "8.8.8.8" || host.Hostname != "Example Org" {
		t.Errorf("unexpected host: %+v", host)
	}
}
