const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

canvas.width = window.innerWidth;
canvas.height = window.innerHeight;

window.addEventListener('resize', () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
});

function getMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
}

canvas.addEventListener('mousedown', (e) => {
    const pos = getMousePos(e);
    for (const host of hosts.values()) {
        const dx = pos.x - host.x;
        const dy = pos.y - host.y;
        if (Math.sqrt(dx * dx + dy * dy) <= host.radius) {
            draggedHost = host;
            dragOffsetX = dx;
            dragOffsetY = dy;
            host.vx = 0;
            host.vy = 0;
            break;
        }
    }
});

canvas.addEventListener('mousemove', (e) => {
    const pos = getMousePos(e);
    if (!draggedHost) {
        // Show grab cursor when hovering over a host
        let hover = false;
        for (const host of hosts.values()) {
            const dx = pos.x - host.x;
            const dy = pos.y - host.y;
            if (Math.sqrt(dx * dx + dy * dy) <= host.radius) {
                hover = true;
                break;
            }
        }
        canvas.style.cursor = hover ? 'grab' : 'default';
        return;
    }
    canvas.style.cursor = 'grabbing';
    draggedHost.x = Math.max(draggedHost.radius, Math.min(canvas.width - draggedHost.radius, pos.x - dragOffsetX));
    draggedHost.y = Math.max(draggedHost.radius, Math.min(canvas.height - draggedHost.radius, pos.y - dragOffsetY));
});

window.addEventListener('mouseup', () => {
    draggedHost = null;
    canvas.style.cursor = 'default';
});

const hosts = new Map();
const edges = new Map();
const particles = [];

const hostCountEl = document.getElementById('hostCount');
const edgeCountEl = document.getElementById('edgeCount');

let draggedHost = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

function edgeKey(src, dst) {
    return src + '->' + dst;
}

const protocolColors = {
    TCP: '#4a90e2',
    UDP: '#50c878',
    ICMP: '#f39c12',
    OTHER: '#e74c3c'
};

const settings = {
    attractLocalLocal: 0.030,
    attractLocalExternal: 0.020,
    attractExternalExternal: 0.020,
    packetSpeed: 0.005,
    packetSizeScale: 1,
    minHostSize: 5,
    maxHostSize: 44
};

function bindSlider(id, key, format, onChange) {
    const input = document.getElementById(id);
    const output = document.getElementById(id + 'Value');
    const update = () => {
        const value = parseFloat(input.value);
        settings[key] = value;
        if (output) output.textContent = format(value);
        if (onChange) onChange();
    };
    input.addEventListener('input', update);
    update();
}

bindSlider('attractLocalLocal', 'attractLocalLocal', (v) => v.toFixed(3));
bindSlider('attractLocalExternal', 'attractLocalExternal', (v) => v.toFixed(3));
bindSlider('attractExternalExternal', 'attractExternalExternal', (v) => v.toFixed(3));
bindSlider('packetSpeed', 'packetSpeed', (v) => v.toFixed(3));
bindSlider('packetSize', 'packetSizeScale', (v) => v.toFixed(1));
bindSlider('minHostSize', 'minHostSize', (v) => v.toFixed(0), () => updateHostSizes());
bindSlider('maxHostSize', 'maxHostSize', (v) => v.toFixed(0), () => updateHostSizes());

document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('menuPanel').classList.toggle('hidden');
});

document.getElementById('removeGray').addEventListener('click', removeGrayHosts);

function removeGrayHosts() {
    const removed = [];
    for (const [ip, host] of hosts) {
        if (!(host.sentCount > 0)) {
            removed.push(ip);
        }
    }
    for (const ip of removed) {
        hosts.delete(ip);
    }
    for (const [key, edge] of edges) {
        if (!hosts.has(edge.srcIP) || !hosts.has(edge.dstIP)) {
            edges.delete(key);
        }
    }
    if (draggedHost && removed.includes(draggedHost.ip)) {
        draggedHost = null;
    }
    updateHostSizes();
    updateStats();
}

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

function getHostTraffic(ip) {
    const host = hosts.get(ip);
    if (!host) return 0;
    return (host.bytesSent || 0) + (host.bytesReceived || 0);
}

function updateHostSizes() {
    const hostArray = Array.from(hosts.values());
    if (hostArray.length === 0) return;
    let maxTraffic = -1;
    let minTraffic = Infinity;
    for (const host of hostArray) {
        const t = getHostTraffic(host.ip);
        if (t > maxTraffic) maxTraffic = t;
        if (t < minTraffic) minTraffic = t;
    }
    const minRadius = Math.min(settings.minHostSize, settings.maxHostSize);
    const maxRadius = Math.max(settings.minHostSize, settings.maxHostSize);
    if (maxTraffic === 0) {
        for (const host of hostArray) {
            host.radius = (minRadius + maxRadius) / 2;
        }
        return;
    }
    for (const host of hostArray) {
        const t = getHostTraffic(host.ip);
        if (t === maxTraffic) {
            host.radius = maxRadius;
        } else if (t === minTraffic) {
            host.radius = minRadius;
        } else {
            const ratio = (t - minTraffic) / (maxTraffic - minTraffic);
            host.radius = minRadius + ratio * (maxRadius - minRadius);
        }
    }
}

function getHostPosition(ip) {
    if (!hosts.has(ip)) {
        hosts.set(ip, {
            ip: ip,
            hostname: '',
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.3,
            vy: (Math.random() - 0.5) * 0.3,
            radius: 22,
            sentCount: 0,
            receivedCount: 0,
            bytesSent: 0,
            bytesReceived: 0
        });
        updateHostSizes();
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
                        receivedCount: 0,
                        bytesSent: 0,
                        bytesReceived: 0
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
                const srcHost = hosts.get(e.srcIP);
                const dstHost = hosts.get(e.dstIP);
                if (srcHost) {
                    srcHost.sentCount = (srcHost.sentCount || 0) + (e.count || 0);
                    srcHost.bytesSent = (srcHost.bytesSent || 0) + (e.bytes || 0);
                }
                if (dstHost) {
                    dstHost.receivedCount = (dstHost.receivedCount || 0) + (e.count || 0);
                    dstHost.bytesReceived = (dstHost.bytesReceived || 0) + (e.bytes || 0);
                }
            }
        }
        updateHostSizes();
        updateStats();
    } else if (msg.type === 'packet') {
        const ev = msg.data;
        const srcHost = getHostPosition(ev.srcIP);
        const dstHost = getHostPosition(ev.dstIP);
        srcHost.sentCount = (srcHost.sentCount || 0) + 1;
        dstHost.receivedCount = (dstHost.receivedCount || 0) + 1;
        srcHost.bytesSent = (srcHost.bytesSent || 0) + ev.bytes;
        dstHost.bytesReceived = (dstHost.bytesReceived || 0) + ev.bytes;
        updateHostSizes();
        
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
            speed: settings.packetSpeed,
            size: Math.max(2, Math.min(8, Math.log10(ev.bytes + 1) * 3)) * settings.packetSizeScale,
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
    
    // Attraction force along connections.
    // Local<->local connections pull strongest, local<->external medium,
    // external<->external weakest.
    for (const edge of edges.values()) {
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (!src || !dst || src === dst) continue;
        
        const srcLocal = isLocalIP(src.ip);
        const dstLocal = isLocalIP(dst.ip);
        let strength;
        if (srcLocal && dstLocal) {
            strength = settings.attractLocalLocal;
        } else if (srcLocal || dstLocal) {
            strength = settings.attractLocalExternal;
        } else {
            strength = settings.attractExternalExternal;
        }
        
        const dx = dst.x - src.x;
        const dy = dst.y - src.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetDist = src.radius + dst.radius + 90;
        let force = (dist - targetDist) * strength * 0.02;
        force = Math.max(-1.5, Math.min(1.5, force));
        
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        
        if (src !== draggedHost) {
            src.x += fx;
            src.y += fy;
        }
        if (dst !== draggedHost) {
            dst.x -= fx;
            dst.y -= fy;
        }
    }
    
    // Update host positions (gentle drift) with collision avoidance
    for (let i = 0; i < hostArray.length; i++) {
        const host = hostArray[i];
        if (host === draggedHost) continue;
        
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
                if (h1 !== draggedHost) {
                    h1.x -= fx;
                    h1.y -= fy;
                }
                if (h2 !== draggedHost) {
                    h2.x += fx;
                    h2.y += fy;
                }
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
        
        // Labels: IP above the blob, hostname below (empty if unavailable)
        ctx.textAlign = 'center';
        ctx.font = '11px monospace';
        
        const ipY = host.y - host.radius - 6;
        const hostnameY = host.y + host.radius + 16;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        const ipWidth = ctx.measureText(host.ip).width;
        ctx.fillRect(host.x - ipWidth / 2 - 2, ipY - 10, ipWidth + 4, 12);
        
        ctx.fillStyle = hasSent ? '#fff' : '#aaa';
        ctx.fillText(host.ip, host.x, ipY);
        
        if (host.hostname) {
            const hostname = host.hostname.length > 16 ? host.hostname.substring(0, 13) + '...' : host.hostname;
            const hostnameWidth = ctx.measureText(hostname).width;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(host.x - hostnameWidth / 2 - 2, hostnameY - 10, hostnameWidth + 4, 12);
            ctx.fillStyle = hasSent ? '#fff' : '#aaa';
            ctx.fillText(hostname, host.x, hostnameY);
        }
    }
    
    requestAnimationFrame(animate);
}

animate();
