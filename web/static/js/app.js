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

function getHostPosition(ip) {
    if (!hosts.has(ip)) {
        hosts.set(ip, {
            ip: ip,
            hostname: ip,
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.2,
            vy: (Math.random() - 0.5) * 0.2,
            radius: 20
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
                        vx: (Math.random() - 0.5) * 0.2,
                        vy: (Math.random() - 0.5) * 0.2,
                        radius: 20
                    });
                } else {
                    hosts.get(h.ip).hostname = h.hostname;
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
        getHostPosition(ev.srcIP);
        getHostPosition(ev.dstIP);
        
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
    ctx.fillStyle = 'rgba(10, 10, 10, 0.1)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Update host positions (gentle drift)
    for (const host of hosts.values()) {
        host.x += host.vx;
        host.y += host.vy;
        
        if (host.x < host.radius || host.x > canvas.width - host.radius) {
            host.vx *= -1;
        }
        if (host.y < host.radius || host.y > canvas.height - host.radius) {
            host.vy *= -1;
        }
        
        host.x = Math.max(host.radius, Math.min(canvas.width - host.radius, host.x));
        host.y = Math.max(host.radius, Math.min(canvas.height - host.radius, host.y));
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
        // Blob
        ctx.beginPath();
        ctx.arc(host.x, host.y, host.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(74, 144, 226, 0.3)';
        ctx.fill();
        ctx.strokeStyle = '#4a90e2';
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Label
        ctx.fillStyle = '#fff';
        ctx.font = '11px monospace';
        ctx.textAlign = 'center';
        const label = host.hostname.length > 15 ? host.hostname.substring(0, 12) + '...' : host.hostname;
        ctx.fillText(label, host.x, host.y - host.radius - 5);
        ctx.fillText(host.ip, host.x, host.y + host.radius + 15);
    }
    
    requestAnimationFrame(animate);
}

animate();
