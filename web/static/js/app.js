const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
});

const hosts = new Map();
const edges = new Map();
const particles = [];

const hostCountEl = document.getElementById('hostCount');
const edgeCountEl = document.getElementById('edgeCount');

function edgeKey(src, dst) {
    return src + '->' + dst;
}

const protocolColors = {
    TCP: '#4a90e2',
    UDP: '#50c878',
    ICMP: '#f39c12',
    OTHER: '#e74c3c'
};

function isLocalIP(ip) {
    if (!ip) return false;
    // IPv4 private/local ranges
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
        const parts = ip.split('.');
        if (parts.length >= 2) {
            const second = parseInt(parts[1]);
            if (second >= 16 && second <= 31) return true;
        }
    }
    if (ip.startsWith('127.')) return true;
    if (ip.startsWith('169.254.')) return true; // link-local
    if (ip === '0.0.0.0') return true;
    // IPv6 loopback/link-local/unique local
    if (ip.startsWith('::1')) return true;
    if (ip.startsWith('fe80:')) return true;
    if (ip.startsWith('fc00:') || ip.startsWith('fd00:')) return true;
    return false;
}

function getHostPosition(ip) {
    if (!hosts.has(ip)) {
        hosts.set(ip, {
            ip: ip,
            hostname: ip,
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.3,
            radius: 22,
            sentCount: 0,
            receivedCount: 0
        });
    }
    return hosts.get(ip);
}

const ws = new WebSocket(`ws://${window.location.host}/ws`);

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    
    if (msg.type === 'snapshot') {
        const data = msg.data;
        if (data.hosts) {
            for (const h of data.hosts) {
                if (!hosts.has(h.ip)) {
                    hosts.set(h.ip, {
                        ip: h.ip,
                        hostname: h.hostname,
                        x: Math.random() * canvas.width,
                        y: Math.random() * canvas.height,
                        vx: (Math.random() - 0.5) * 0.3,
                        vy: (Math.random() - 0.5) * 0.3,
                        radius: 22,
                        sentCount: 0,
                        receivedCount: 0
                    });
                } else {
                    const host = hosts.get(h.ip);
                    host.hostname = h.hostname;
                }
            }
        }
        if (data.edges) {
            for (const e of data.edges) {
                edges.set(edgeKey(e.srcIP, e.dstIP), e);
            }
        }
        updateStats();
    } else if (msg.type === 'packet') {
        const ev = msg.data;
        const srcHost = getHostPosition(ev.srcIP);
        const dstHost = getHostPosition(ev.dstIP);
        srcHost.sentCount = (srcHost.sentCount || 0) + 1;
        dstHost.receivedCount = (dstHost.receivedCount || 0) + 1;
        
        const key = edgeKey(ev.srcIP, ev.dstIP);
        if (!edges.has(key)) {
            edges.set(key, { srcIP: ev.srcIP, dstIP: ev.dstIP, count: 1, bytes: ev.bytes });
        } else {
            const e = edges.get(key);
            e.count++;
            e.bytes += ev.bytes;
        }
        
        // Create particle
        const src = hosts.get(ev.srcIP);
        const dst = hosts.get(ev.dstIP);
        particles.push({
            x: src.x,
            y: src.y,
            tx: dst.x,
            ty: dst.y,
            progress: 0,
            speed: 0.02,
            size: Math.max(2, Math.min(8, Math.log10(ev.bytes + 1) * 3)),
            color: protocolColors[ev.proto] || protocolColors.OTHER,
            life: 1.0
        });
        
        updateStats();
    }
};

function updateStats() {
    hostCountEl.textContent = hosts.size;
    edgeCountEl.textContent = edges.size;
}

function animate() {
    ctx.fillStyle = 'rgba(10, 10, 10, 0.15)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    const hostArray = Array.from(hosts.values());
    
    // If hosts won't fit, zoom out by scaling positions
    if (hostArray.length > 0) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const host of hostArray) {
            if (host.x < minX) minX = host.x;
            if (host.x > maxX) maxX = host.x;
            if (host.y < minY) minY = host.y;
            if (host.y > maxY) maxY = host.y;
        }
        const spanX = Math.max(1, maxX - minX);
        const spanY = Math.max(1, maxY - minY);
        const padding = 80;
        const scaleX = (canvas.width - padding * 2) / spanX;
        const scaleY = (canvas.height - padding * 2) / spanY;
        const scale = Math.min(scaleX, scaleY, 1.0);
        if (scale < 1.0) {
            const centerX = (minX + maxX) / 2;
            const centerY = (minY + maxY) / 2;
            for (const host of hostArray) {
                host.x = (host.x - centerX) * scale + canvas.width / 2;
                host.y = (host.y - centerY) * scale + canvas.height / 2;
            }
        }
    }
    
    // Update host positions (gentle drift) with collision avoidance
    for (let i = 0; i < hostArray.length; i++) {
        const host = hostArray[i];
        host.x += host.vx || 0;
        host.y += host.vy || 0;
        
        if (host.x < host.radius + 60 || host.x > canvas.width - host.radius - 60) {
            host.vx = -(host.vx || 0);
        }
        if (host.y < host.radius + 80 || host.y > canvas.height - host.radius - 80) {
            host.vy = -(host.vy || 0);
        }
        
        host.x = Math.max(host.radius + 60, Math.min(canvas.width - host.radius - 60, host.x));
        host.y = Math.max(host.radius + 80, Math.min(canvas.height - host.radius - 80, host.y));
    }
    
    // Collision avoidance between hosts
    for (let i = 0; i < hostArray.length; i++) {
        for (let j = i + 1; j < hostArray.length; j++) {
            const h1 = hostArray[i];
            const h2 = hostArray[j];
            const dx = h2.x - h1.x;
            const dy = h2.y - h1.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = h1.radius + h2.radius + 40;
            if (dist < minDist && dist > 0) {
                const force = (minDist - dist) / dist * 0.5;
                const fx = dx * force;
                const fy = dy * force;
                h1.x -= fx;
                h1.y -= fy;
                h2.x += fx;
                h2.y += fy;
            }
        }
    }
    
    // Draw edges
    ctx.strokeStyle = 'rgba(100, 100, 100, 0.3)';
    ctx.lineWidth = 1;
    for (const edge of edges.values()) {
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (src && dst) {
            ctx.beginPath();
            ctx.moveTo(src.x, src.y);
            ctx.lineTo(dst.x, dst.y);
            ctx.stroke();
        }
    }
    
    // Draw particles
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.progress += p.speed;
        
        if (p.progress >= 1) {
            particles.splice(i, 1);
            continue;
        }
        
        const x = p.x + (p.tx - p.x) * p.progress;
        const y = p.y + (p.ty - p.y) * p.progress;
        
        ctx.beginPath();
        ctx.arc(x, y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.shadowBlur = 10;
        ctx.shadowColor = p.color;
        ctx.fill();
        ctx.shadowBlur = 0;
    }
    
    // Draw hosts
    for (const host of hosts.values()) {
        const hasSent = (host.sentCount || 0) > 0;
        const local = isLocalIP(host.ip);
        // Blob color: green if local, gray if never sent, blue otherwise
        if (!hasSent) {
            ctx.fillStyle = 'rgba(100, 100, 100, 0.25)';
            ctx.strokeStyle = '#666';
        } else if (local) {
            ctx.fillStyle = 'rgba(80, 200, 120, 0.35)';
            ctx.strokeStyle = '#50c878';
        } else {
            ctx.fillStyle = 'rgba(74, 144, 226, 0.3)';
            ctx.strokeStyle = '#4a90e2';
        }
        ctx.beginPath();
        ctx.arc(host.x, host.y, host.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Label with collision avoidance - draw text with background
        ctx.textAlign = 'center';
        const label = host.hostname && host.hostname.length > 16 ? host.hostname.substring(0, 13) + '...' : (host.hostname || host.ip);
        ctx.font = '11px monospace';
        
        // Draw text background for better readability
        const labelY = host.y - host.radius - 6;
        const ipY = host.y + host.radius + 16;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        const labelWidth = ctx.measureText(label).width;
        const ipWidth = ctx.measureText(host.ip).width;
        ctx.fillRect(host.x - labelWidth / 2 - 2, labelY - 10, labelWidth + 4, 12);
        ctx.fillRect(host.x - ipWidth / 2 - 2, ipY - 10, ipWidth + 4, 12);
        
        ctx.fillStyle = hasSent ? '#fff' : '#aaa';
        ctx.fillText(label, host.x, labelY);
        ctx.fillText(host.ip, host.x, ipY);
    }
    
    requestAnimationFrame(animate);
}

animate();
