//go:build linux && cgo

package capture

import (
	"net"
	"testing"

	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
)

func serialize(t *testing.T, ip *layers.IPv4, ls ...gopacket.SerializableLayer) gopacket.Packet {
	t.Helper()

	all := append([]gopacket.SerializableLayer{ip}, ls...)
	buf := gopacket.NewSerializeBuffer()
	opts := gopacket.SerializeOptions{FixLengths: true, ComputeChecksums: true}
	if err := gopacket.SerializeLayers(buf, opts, all...); err != nil {
		t.Fatalf("serialize packet: %v", err)
	}
	return gopacket.NewPacket(buf.Bytes(), layers.LayerTypeIPv4, gopacket.Default)
}

func ipv4(protocol layers.IPProtocol) *layers.IPv4 {
	return &layers.IPv4{
		Version:  4,
		IHL:      5,
		TTL:      64,
		Protocol: protocol,
		SrcIP:    net.ParseIP("192.168.1.10"),
		DstIP:    net.ParseIP("93.184.216.34"),
	}
}

func processOne(t *testing.T, pkt gopacket.Packet) (Event, bool) {
	t.Helper()

	var (
		got Event
		ok  bool
	)
	c := &Capture{handler: func(ev Event) {
		got = ev
		ok = true
	}}
	c.processPacket(pkt)
	return got, ok
}

func TestProcessPacketTCP(t *testing.T) {
	ip := ipv4(layers.IPProtocolTCP)
	tcp := &layers.TCP{SrcPort: 12345, DstPort: 80, SYN: true, Window: 65535}
	if err := tcp.SetNetworkLayerForChecksum(ip); err != nil {
		t.Fatal(err)
	}

	ev, ok := processOne(t, serialize(t, ip, tcp))
	if !ok {
		t.Fatal("handler was not called")
	}
	if ev.Proto != "TCP" {
		t.Errorf("proto = %q, want TCP", ev.Proto)
	}
	if ev.SrcIP != "192.168.1.10" || ev.DstIP != "93.184.216.34" {
		t.Errorf("unexpected addresses: %s -> %s", ev.SrcIP, ev.DstIP)
	}
	if ev.Bytes <= 0 {
		t.Errorf("bytes = %d, want > 0", ev.Bytes)
	}
	if ev.Timestamp.IsZero() {
		t.Error("timestamp was not set")
	}
}

func TestProcessPacketUDP(t *testing.T) {
	ip := ipv4(layers.IPProtocolUDP)
	udp := &layers.UDP{SrcPort: 5353, DstPort: 53}
	if err := udp.SetNetworkLayerForChecksum(ip); err != nil {
		t.Fatal(err)
	}

	ev, ok := processOne(t, serialize(t, ip, udp))
	if !ok {
		t.Fatal("handler was not called")
	}
	if ev.Proto != "UDP" {
		t.Errorf("proto = %q, want UDP", ev.Proto)
	}
}

func TestProcessPacketICMP(t *testing.T) {
	ip := ipv4(layers.IPProtocolICMPv4)
	icmp := &layers.ICMPv4{
		TypeCode: layers.CreateICMPv4TypeCode(layers.ICMPv4TypeEchoRequest, 0),
	}

	ev, ok := processOne(t, serialize(t, ip, icmp))
	if !ok {
		t.Fatal("handler was not called")
	}
	if ev.Proto != "ICMP" {
		t.Errorf("proto = %q, want ICMP", ev.Proto)
	}
}

func TestProcessPacketOtherProtocol(t *testing.T) {
	// GRE (protocol 47) has no transport layer, so it falls back to OTHER.
	ev, ok := processOne(t, serialize(t, ipv4(47)))
	if !ok {
		t.Fatal("handler was not called")
	}
	if ev.Proto != "OTHER" {
		t.Errorf("proto = %q, want OTHER", ev.Proto)
	}
}

func TestProcessPacketWithoutNetworkLayerIsIgnored(t *testing.T) {
	pkt := gopacket.NewPacket([]byte{0x00}, gopacket.LayerTypePayload, gopacket.Default)
	c := &Capture{handler: func(Event) {
		t.Fatal("handler should not be called for a packet without an IP layer")
	}}
	c.processPacket(pkt)
}
