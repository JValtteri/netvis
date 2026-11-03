package graph

import (
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"netvis/internal/capture"
)

type Host struct {
	IP string `json:"ip"`
	// IPs lists every address that belongs to this host. A host is grouped by
	// its resolved reverse-DNS hostname, so a machine observed over both IPv4
	// and IPv6 is represented by one Host record whose addresses are in IPs.
	IPs []string `json:"ips,omitempty"`
	// Group is the canonical identity shared by all addresses of the same
	// host. It is normally the IP that first resolved the group's hostname.
	Group        string `json:"group,omitempty"`
	Hostname     string `json:"hostname"`
	Organization string `json:"organization,omitempty"`
	Country      string `json:"country,omitempty"`

	lastSeen time.Time
}

// hostDetails is the result of an asynchronous display-name lookup. Hostname
// comes from reverse DNS, while Organization and Country come from whois for
// external addresses.
type hostDetails struct {
	Hostname     string
	Organization string
	Country      string
}

type Edge struct {
	SrcIP string `json:"srcIP"`
	DstIP string `json:"dstIP"`
	Count int64  `json:"count"`
	Bytes int64  `json:"bytes"`

	lastSeen time.Time
}

type Graph struct {
	mu      sync.RWMutex
	hosts   map[string]*Host
	edges   map[string]*Edge
	onHost  func(Host)
	resolve func(string) hostDetails

	// hostTTL and maxHosts control optional server-side eviction. Zero values
	// keep all observed state for the lifetime of the process.
	hostTTL  time.Duration
	maxHosts int

	// nameGroups maps a resolved hostname to the canonical group (the first IP
	// that resolved to that name). It lets IPv4 and IPv6 addresses of the same
	// host share one identity.
	nameGroups map[string]string

	lookupMu  sync.Mutex
	nameCache map[string]hostDetails
	pending   map[string]bool
}

func New() *Graph {
	return &Graph{
		hosts:      make(map[string]*Host),
		edges:      make(map[string]*Edge),
		nameGroups: make(map[string]string),
		nameCache:  make(map[string]hostDetails),
		pending:    make(map[string]bool),
		resolve:    resolveName,
	}
}

// SetRetention configures optional server-side eviction. A non-positive
// hostTTL disables age-based expiry, and a non-positive maxHosts disables the
// host cap. With both disabled (the default) all observed state is kept.
func (g *Graph) SetRetention(hostTTL time.Duration, maxHosts int) {
	if hostTTL < 0 {
		hostTTL = 0
	}
	if maxHosts < 0 {
		maxHosts = 0
	}

	g.mu.Lock()
	g.hostTTL = hostTTL
	g.maxHosts = maxHosts
	g.pruneLocked(time.Now())
	g.mu.Unlock()
}

// StartRetention starts a background janitor that applies the configured
// retention policy every interval. It returns a function that stops the
// janitor. If retention is disabled, it returns a no-op.
func (g *Graph) StartRetention(interval time.Duration) func() {
	g.mu.RLock()
	enabled := g.hostTTL > 0 || g.maxHosts > 0
	g.mu.RUnlock()
	if !enabled {
		return func() {}
	}
	if interval <= 0 {
		interval = 30 * time.Second
	}

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				g.Prune(time.Now())
			case <-stop:
				return
			}
		}
	}()

	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
		})
	}
}

// Prune applies the configured retention policy once. A zero now uses the
// current time.
func (g *Graph) Prune(now time.Time) {
	if now.IsZero() {
		now = time.Now()
	}
	g.mu.Lock()
	g.pruneLocked(now)
	g.mu.Unlock()
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
	now := time.Now()

	g.mu.Lock()
	// Ensure hosts exist and record activity.
	src, ok := g.hosts[ev.SrcIP]
	if !ok {
		src = newHost(ev.SrcIP, g.cachedDetails(ev.SrcIP), now)
		g.hosts[ev.SrcIP] = src
		newHosts = append(newHosts, ev.SrcIP)
	}
	src.lastSeen = now

	dst, ok := g.hosts[ev.DstIP]
	if !ok {
		dst = newHost(ev.DstIP, g.cachedDetails(ev.DstIP), now)
		g.hosts[ev.DstIP] = dst
		newHosts = append(newHosts, ev.DstIP)
	}
	dst.lastSeen = now

	k := g.edgeKey(ev.SrcIP, ev.DstIP)
	if e, ok := g.edges[k]; ok {
		e.Count++
		e.Bytes += int64(ev.Bytes)
		e.lastSeen = now
	} else {
		g.edges[k] = &Edge{
			SrcIP:    ev.SrcIP,
			DstIP:    ev.DstIP,
			Count:    1,
			Bytes:    int64(ev.Bytes),
			lastSeen: now,
		}
	}

	if g.maxHosts > 0 && len(g.hosts) > g.maxHosts {
		if g.enforceMaxHostsLocked() {
			g.rebuildGroupsLocked()
		}
		// Do not start lookups for hosts that were just evicted.
		kept := newHosts[:0]
		for _, ip := range newHosts {
			if _, ok := g.hosts[ip]; ok {
				kept = append(kept, ip)
			}
		}
		newHosts = kept
	}
	g.mu.Unlock()

	for _, ip := range newHosts {
		g.scheduleLookup(ip)
	}
}

func (g *Graph) cachedDetails(ip string) hostDetails {
	g.lookupMu.Lock()
	defer g.lookupMu.Unlock()
	return g.nameCache[ip]
}

func newHost(ip string, details hostDetails, now time.Time) *Host {
	return &Host{
		IP:           ip,
		IPs:          []string{ip},
		Group:        ip,
		Hostname:     details.Hostname,
		Organization: details.Organization,
		Country:      details.Country,
		lastSeen:     now,
	}
}

// scheduleLookup resolves display details for the host without blocking packet
// processing. Local hosts use reverse DNS; external hosts also use a whois
// organization/country lookup.
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
		details := resolve(ip)

		g.lookupMu.Lock()
		g.nameCache[ip] = details
		delete(g.pending, ip)
		g.lookupMu.Unlock()

		g.applyResolvedDetails(ip, details)
	}()
}

// applyResolvedDetails stores resolved display details and, when the hostname
// is known, folds every address that resolved to the same hostname into one
// identity. All affected hosts are pushed to clients so the frontend can merge
// their blobs and traffic counters.
func (g *Graph) applyResolvedDetails(ip string, details hostDetails) {
	g.mu.Lock()
	h, ok := g.hosts[ip]
	if !ok {
		g.mu.Unlock()
		return
	}

	h.Hostname = details.Hostname
	h.Organization = details.Organization
	h.Country = details.Country

	// The first address that resolves a hostname becomes the group's canonical
	// identity. Any other address that resolves to the same name joins it.
	group := ip
	if details.Hostname != "" {
		if canonical, ok := g.nameGroups[details.Hostname]; ok {
			group = canonical
		} else {
			g.nameGroups[details.Hostname] = ip
		}
	}
	h.Group = group

	// Rebuild the address list for every host in this group, and collect the
	// updated records to broadcast.
	members := make([]string, 0, 2)
	for memberIP, member := range g.hosts {
		if member.Group == group {
			members = append(members, memberIP)
		}
	}
	sort.Slice(members, func(i, j int) bool { return ipSortLess(members[i], members[j]) })

	updates := make([]Host, 0, len(members))
	for _, memberIP := range members {
		member := g.hosts[memberIP]
		member.Group = group
		member.IPs = append([]string(nil), members...)
		updates = append(updates, *member)
	}
	cb := g.onHost
	g.mu.Unlock()

	if cb == nil {
		return
	}
	for _, updated := range updates {
		cb(updated)
	}
}

// pruneLocked applies the configured retention policy. The caller must hold
// g.mu.
func (g *Graph) pruneLocked(now time.Time) {
	removed := false
	if g.hostTTL > 0 {
		for ip, h := range g.hosts {
			if now.Sub(h.lastSeen) > g.hostTTL {
				g.removeHostLocked(ip)
				removed = true
			}
		}
		for key, e := range g.edges {
			if now.Sub(e.lastSeen) > g.hostTTL {
				delete(g.edges, key)
			}
		}
	}
	if g.enforceMaxHostsLocked() {
		removed = true
	}
	if removed {
		g.rebuildGroupsLocked()
	}
}

// enforceMaxHostsLocked removes the least recently active hosts until the host
// cap is satisfied. The caller must hold g.mu.
func (g *Graph) enforceMaxHostsLocked() bool {
	if g.maxHosts <= 0 || len(g.hosts) <= g.maxHosts {
		return false
	}

	excess := len(g.hosts) - g.maxHosts
	if excess > 16 {
		type hostAge struct {
			ip       string
			lastSeen time.Time
		}
		hosts := make([]hostAge, 0, len(g.hosts))
		for ip, h := range g.hosts {
			hosts = append(hosts, hostAge{ip: ip, lastSeen: h.lastSeen})
		}
		sort.Slice(hosts, func(i, j int) bool {
			if hosts[i].lastSeen.Equal(hosts[j].lastSeen) {
				return hosts[i].ip < hosts[j].ip
			}
			return hosts[i].lastSeen.Before(hosts[j].lastSeen)
		})
		for _, h := range hosts[:excess] {
			g.removeHostLocked(h.ip)
		}
		return true
	}

	// The common case adds one or two hosts at a time, so finding the oldest
	// host repeatedly is cheaper than sorting the whole map on every event.
	for i := 0; i < excess; i++ {
		oldestIP := ""
		var oldest time.Time
		for ip, h := range g.hosts {
			if oldestIP == "" || h.lastSeen.Before(oldest) ||
				(h.lastSeen.Equal(oldest) && ip < oldestIP) {
				oldestIP = ip
				oldest = h.lastSeen
			}
		}
		if oldestIP == "" {
			break
		}
		g.removeHostLocked(oldestIP)
	}
	return true
}

// removeHostLocked deletes a host together with its edges and cached lookup
// data. The caller must hold g.mu.
func (g *Graph) removeHostLocked(ip string) {
	delete(g.hosts, ip)
	for key, e := range g.edges {
		if e.SrcIP == ip || e.DstIP == ip {
			delete(g.edges, key)
		}
	}

	g.lookupMu.Lock()
	delete(g.nameCache, ip)
	g.lookupMu.Unlock()

	for name, canonical := range g.nameGroups {
		if canonical == ip {
			delete(g.nameGroups, name)
		}
	}
}

// rebuildGroupsLocked recomputes each group's address list and repairs the
// hostname-to-canonical mapping after hosts have been removed. The caller must
// hold g.mu.
func (g *Graph) rebuildGroupsLocked() {
	groups := make(map[string][]string, len(g.hosts))
	for ip, h := range g.hosts {
		group := h.Group
		if group == "" {
			group = ip
		}
		groups[group] = append(groups[group], ip)
	}

	// Drop name mappings whose canonical host no longer exists.
	for name, canonical := range g.nameGroups {
		if _, ok := groups[canonical]; !ok {
			delete(g.nameGroups, name)
		}
	}

	for group, members := range groups {
		sort.Slice(members, func(i, j int) bool { return ipSortLess(members[i], members[j]) })

		canonical := group
		if _, ok := g.hosts[canonical]; !ok {
			// The old canonical address was evicted; promote a remaining member.
			canonical = members[0]
		}

		hostname := ""
		for _, ip := range members {
			if h := g.hosts[ip]; h.Hostname != "" {
				hostname = h.Hostname
				break
			}
		}
		if hostname != "" {
			g.nameGroups[hostname] = canonical
		}

		for _, ip := range members {
			h := g.hosts[ip]
			h.Group = canonical
			h.IPs = append([]string(nil), members...)
		}
	}
}

// ipSortLess orders addresses for display, preferring IPv4 because it is
// shorter and more familiar in the blob label.
func ipSortLess(a, b string) bool {
	parsedA, parsedB := net.ParseIP(a), net.ParseIP(b)
	a4 := parsedA != nil && parsedA.To4() != nil
	b4 := parsedB != nil && parsedB.To4() != nil
	if a4 != b4 {
		return a4
	}
	return a < b
}

func resolveName(ip string) hostDetails {
	parsed := net.ParseIP(ip)
	if parsed != nil && isLocalIP(parsed) {
		return hostDetails{Hostname: lookupHostname(ip)}
	}

	// External hosts get reverse DNS and whois details in parallel so a slow
	// whois server does not delay the hostname (and vice versa).
	var details hostDetails
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		details.Hostname = lookupHostname(ip)
	}()
	go func() {
		defer wg.Done()
		details.Organization, details.Country = lookupWhoisInfo(ip)
	}()
	wg.Wait()
	return details
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
	case <-time.After(3 * time.Second):
		return ""
	}
}

type Snapshot struct {
	Hosts []Host `json:"hosts"`
	Edges []Edge `json:"edges"`
	// ServerIPs lists the local addresses of the NetVis server. Clients use
	// these to render traffic to/from the server itself differently.
	ServerIPs []string `json:"serverIPs"`
	// WebPort is the TCP port serving the NetVis frontend (HTTP/WebSocket).
	WebPort int `json:"webPort"`
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
