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

// Camera maps world coordinates (host positions) to screen coordinates.
// screen = world * scale + offset
const camera = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    minScale: 0.1,
    maxScale: 5
};

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function screenToWorld(pos) {
    return {
        x: (pos.x - camera.offsetX) / camera.scale,
        y: (pos.y - camera.offsetY) / camera.scale
    };
}

function zoomAt(screenX, screenY, factor) {
    const scale = clamp(camera.scale * factor, camera.minScale, camera.maxScale);
    if (scale === camera.scale) {
        return;
    }
    const worldX = (screenX - camera.offsetX) / camera.scale;
    const worldY = (screenY - camera.offsetY) / camera.scale;
    camera.scale = scale;
    camera.offsetX = screenX - worldX * scale;
    camera.offsetY = screenY - worldY * scale;
}

function zoomBy(factor) {
    zoomAt(canvas.width / 2, canvas.height / 2, factor);
}

function fitToView() {
    const hostArray = Array.from(hosts.values());
    if (hostArray.length === 0) {
        camera.scale = 1;
        camera.offsetX = 0;
        camera.offsetY = 0;
        return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const host of hostArray) {
        const bounds = hostLabelBounds(host);
        minX = Math.min(minX, host.x - bounds.halfWidth);
        maxX = Math.max(maxX, host.x + bounds.halfWidth);
        minY = Math.min(minY, host.y - bounds.top);
        maxY = Math.max(maxY, host.y + bounds.bottom);
    }

    const padding = 40;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    // Don't over-magnify a nearly empty graph; just centre it.
    const scale = clamp(
        Math.min((canvas.width - padding * 2) / spanX, (canvas.height - padding * 2) / spanY),
        camera.minScale,
        Math.min(camera.maxScale, 2)
    );

    camera.scale = scale;
    camera.offsetX = canvas.width / 2 - ((minX + maxX) / 2) * scale;
    camera.offsetY = canvas.height / 2 - ((minY + maxY) / 2) * scale;
}

let pressedHost = null;
let pressX = 0;
let pressY = 0;
let dragMoved = false;

function hostAtPosition(pos) {
    ctx.font = '11px monospace';
    for (const host of hosts.values()) {
        const dx = pos.x - host.x;
        const dy = pos.y - host.y;
        if (Math.sqrt(dx * dx + dy * dy) <= host.radius) {
            return host;
        }
        // IP label above the blob
        const ipY = host.y - host.radius - 6;
        const ipWidth = ctx.measureText(displayIP(host)).width;
        if (pos.x >= host.x - ipWidth / 2 - 2 && pos.x <= host.x + ipWidth / 2 + 2 &&
            pos.y >= ipY - 10 && pos.y <= ipY + 2) {
            return host;
        }
        // Hostname label below the blob
        const hostname = displayHostname(host);
        if (hostname) {
            const hostnameY = host.y + host.radius + 16;
            const hostnameWidth = ctx.measureText(hostname).width;
            if (pos.x >= host.x - hostnameWidth / 2 - 2 && pos.x <= host.x + hostnameWidth / 2 + 2 &&
                pos.y >= hostnameY - 10 && pos.y <= hostnameY + 2) {
                return host;
            }
        }
    }
    return null;
}

let toastTimeout = null;

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimeout) {
        clearTimeout(toastTimeout);
    }
    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 1800);
}

function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast(`Copied ${text}`)).catch(() => {
            fallbackCopy(text);
            showToast(`Copied ${text}`);
        });
    } else {
        fallbackCopy(text);
        showToast(`Copied ${text}`);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
    } catch (err) {
        // ignore
    }
    document.body.removeChild(textarea);
}

canvas.addEventListener('mousedown', (e) => {
    const screen = getMousePos(e);
    const pos = screenToWorld(screen);
    const host = hostAtPosition(pos);
    if (host) {
        draggedHost = host;
        pressedHost = host;
        dragMoved = false;
        pressX = screen.x;
        pressY = screen.y;
        dragOffsetX = pos.x - host.x;
        dragOffsetY = pos.y - host.y;
        host.vx = 0;
        host.vy = 0;
    }
});

canvas.addEventListener('mousemove', (e) => {
    const screen = getMousePos(e);
    const pos = screenToWorld(screen);
    if (!draggedHost) {
        canvas.style.cursor = hostAtPosition(pos) ? 'grab' : 'default';
        return;
    }
    if (Math.sqrt((screen.x - pressX) ** 2 + (screen.y - pressY) ** 2) > 4) {
        dragMoved = true;
    }
    canvas.style.cursor = 'grabbing';
    draggedHost.x = clamp(pos.x - dragOffsetX, draggedHost.radius, canvas.width - draggedHost.radius);
    draggedHost.y = clamp(pos.y - dragOffsetY, draggedHost.radius, canvas.height - draggedHost.radius);
});

window.addEventListener('mouseup', () => {
    // Clicking (without dragging) a host copies its IP address
    if (pressedHost && !dragMoved) {
        copyToClipboard(pressedHost.ip);
    }
    pressedHost = null;
    draggedHost = null;
    canvas.style.cursor = 'default';
});

// Wheel zoom keeps the point under the cursor fixed.
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
}, { passive: false });

// Touch: one finger drags a host, two fingers pinch to zoom and pan.
let pinchState = null;
let touchDragging = false;

function touchPoints(e) {
    const rect = canvas.getBoundingClientRect();
    return Array.from(e.touches).map((touch) => ({
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top
    }));
}

canvas.addEventListener('touchstart', (e) => {
    const points = touchPoints(e);
    if (points.length >= 2) {
        e.preventDefault();
        // A pinch supersedes any single-finger drag.
        draggedHost = null;
        pressedHost = null;
        touchDragging = false;
        dragMoved = false;

        const mid = {
            x: (points[0].x + points[1].x) / 2,
            y: (points[0].y + points[1].y) / 2
        };
        const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1;
        pinchState = {
            startDist: dist,
            startScale: camera.scale,
            worldMid: screenToWorld(mid)
        };
        return;
    }

    if (points.length === 1) {
        e.preventDefault();
        const pos = screenToWorld(points[0]);
        const host = hostAtPosition(pos);
        if (host) {
            touchDragging = true;
            draggedHost = host;
            pressedHost = host;
            dragMoved = false;
            pressX = points[0].x;
            pressY = points[0].y;
            dragOffsetX = pos.x - host.x;
            dragOffsetY = pos.y - host.y;
            host.vx = 0;
            host.vy = 0;
        }
    }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    const points = touchPoints(e);

    if (pinchState && points.length >= 2) {
        e.preventDefault();
        const mid = {
            x: (points[0].x + points[1].x) / 2,
            y: (points[0].y + points[1].y) / 2
        };
        const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) || 1;
        const scale = clamp(
            pinchState.startScale * (dist / pinchState.startDist),
            camera.minScale,
            camera.maxScale
        );
        camera.scale = scale;
        camera.offsetX = mid.x - pinchState.worldMid.x * scale;
        camera.offsetY = mid.y - pinchState.worldMid.y * scale;
        return;
    }

    if (touchDragging && draggedHost && points.length === 1) {
        e.preventDefault();
        if (Math.hypot(points[0].x - pressX, points[0].y - pressY) > 6) {
            dragMoved = true;
        }
        const pos = screenToWorld(points[0]);
        draggedHost.x = clamp(pos.x - dragOffsetX, draggedHost.radius, canvas.width - draggedHost.radius);
        draggedHost.y = clamp(pos.y - dragOffsetY, draggedHost.radius, canvas.height - draggedHost.radius);
    }
}, { passive: false });

function endTouch() {
    if (touchDragging) {
        if (pressedHost && !dragMoved) {
            copyToClipboard(pressedHost.ip);
        }
    }
    pinchState = null;
    touchDragging = false;
    pressedHost = null;
    draggedHost = null;
}

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
        endTouch();
    } else if (e.touches.length === 1 && pinchState) {
        // Dropped to one finger; wait for a fresh gesture.
        pinchState = null;
    }
}, { passive: false });

canvas.addEventListener('touchcancel', endTouch, { passive: false });

document.getElementById('zoomIn').addEventListener('click', () => zoomBy(1.25));
document.getElementById('zoomOut').addEventListener('click', () => zoomBy(1 / 1.25));
document.getElementById('fitView').addEventListener('click', fitToView);

const hosts = new Map();
const edges = new Map();
const particles = [];
const serverIPs = new Set();

// Traffic to or from the NetVis server itself is drawn as a special edge
// instead of individual packets.
function isServerEdge(srcIP, dstIP) {
    return serverIPs.has(srcIP) || serverIPs.has(dstIP);
}

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
    attractLocalLocal: 0.100,
    attractLocalExternal: 0.660,
    attractExternalExternal: 0.020,
    packetSpeed: 0.005,
    packetSizeScale: 0.3,
    minHostSize: 5,
    maxHostSize: 44,
    glowDuration: 10,
    passiveTimeout: 120,
    autoRemovePassive: false
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
bindSlider('glowDuration', 'glowDuration', (v) => v.toFixed(0));
bindSlider('passiveTimeout', 'passiveTimeout', (v) => v.toFixed(0));

document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('menuPanel').classList.toggle('hidden');
});

document.getElementById('legendToggle').addEventListener('click', () => {
    const info = document.getElementById('info');
    const collapsed = info.classList.toggle('collapsed');
    document.getElementById('legendToggle').innerHTML = collapsed ? '&plus;' : '&minus;';
});

document.getElementById('removeSilent').addEventListener('click', () => {
    removeHosts((host) => !(host.sentCount > 0));
});

document.getElementById('removePassive').addEventListener('click', removePassiveHosts);

document.getElementById('autoRemovePassive').addEventListener('change', (e) => {
    settings.autoRemovePassive = e.target.checked;
    if (settings.autoRemovePassive) {
        removePassiveHosts();
    }
});

function removePassiveHosts() {
    const now = Date.now();
    removeHosts((host) => now - (host.lastActivityAt || now) > settings.passiveTimeout * 1000);
}

setInterval(() => {
    if (settings.autoRemovePassive) {
        removePassiveHosts();
    }
}, 1000);

function removeHosts(predicate) {
    const removed = [];
    for (const [ip, host] of hosts) {
        if (predicate(host)) {
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

function displayHostname(host) {
    if (!host.hostname) {
        return '';
    }
    return host.hostname.length > 16 ? host.hostname.substring(0, 13) + '...' : host.hostname;
}

// Long IPv6 addresses are truncated for display; the full address is still
// used when copying to the clipboard.
function displayIP(host) {
    const ip = host.ip;
    if (ip.indexOf(':') !== -1 && ip.length > 18) {
        return ip.substring(0, 15) + '...';
    }
    return ip;
}

// Bounds of the blob plus its IP/hostname labels, relative to the blob center.
// The label collision area grows with the rendered label content.
function hostLabelBounds(host) {
    ctx.font = '11px monospace';
    const ipWidth = ctx.measureText(displayIP(host)).width + 4;
    const hostname = displayHostname(host);
    const hostnameWidth = hostname ? ctx.measureText(hostname).width + 4 : 0;

    const labelWidth = Math.max(ipWidth, hostnameWidth);
    const width = Math.max(host.radius * 2, labelWidth);
    const padding = Math.max(4, labelWidth * 0.1);
    // Extra vertical breathing room keeps the IP label of one host from
    // touching the hostname label of another.
    const verticalMargin = 12;

    return {
        halfWidth: width / 2 + padding,
        top: host.radius + 16 + padding * 0.5 + verticalMargin,
        bottom: host.radius + 18 + padding * 0.5 + verticalMargin
    };
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
            bytesReceived: 0,
            lastSentAt: 0,
            lastActivityAt: Date.now(),
            glowLevel: 0
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
        serverIPs.clear();
        if (data.serverIPs) {
            for (const ip of data.serverIPs) {
                serverIPs.add(ip);
            }
        }
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
                        bytesReceived: 0,
                        lastSentAt: 0,
                        lastActivityAt: Date.now(),
                        glowLevel: 0
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
    } else if (msg.type === 'host') {
        const info = msg.data;
        const host = hosts.get(info.ip);
        if (host) {
            host.hostname = info.hostname;
        }
        updateStats();
    } else if (msg.type === 'packet') {
        const ev = msg.data;
        const srcHost = getHostPosition(ev.srcIP);
        const dstHost = getHostPosition(ev.dstIP);
        const now = Date.now();
        srcHost.sentCount = (srcHost.sentCount || 0) + 1;
        dstHost.receivedCount = (dstHost.receivedCount || 0) + 1;
        srcHost.bytesSent = (srcHost.bytesSent || 0) + ev.bytes;
        dstHost.bytesReceived = (dstHost.bytesReceived || 0) + ev.bytes;
        srcHost.lastSentAt = now;
        srcHost.lastActivityAt = now;
        dstHost.lastActivityAt = now;
        updateHostSizes();
        
        const key = edgeKey(ev.srcIP, ev.dstIP);
        if (!edges.has(key)) {
            edges.set(key, { srcIP: ev.srcIP, dstIP: ev.dstIP, count: 1, bytes: ev.bytes });
        } else {
            const e = edges.get(key);
            e.count++;
            e.bytes += ev.bytes;
        }
        
        // Packets to/from the NetVis server are represented by a glowing
        // edge, so don't animate individual particles for them.
        if (!isServerEdge(ev.srcIP, ev.dstIP)) {
            particles.push({
                srcIP: ev.srcIP,
                dstIP: ev.dstIP,
                progress: 0,
                speed: settings.packetSpeed,
                size: Math.max(2, Math.min(8, Math.log10(ev.bytes + 1) * 3)) * settings.packetSizeScale,
                color: protocolColors[ev.proto] || protocolColors.OTHER,
                life: 1.0
            });
        }
        
        updateStats();
    }
};

function updateStats() {
    hostCountEl.textContent = hosts.size;
    edgeCountEl.textContent = edges.size;
}

let lastFrameTime = performance.now();

function animate() {
    const frameTime = performance.now();
    const dt = Math.min((frameTime - lastFrameTime) / 1000, 0.1);
    lastFrameTime = frameTime;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw the world through the camera transform.
    ctx.setTransform(camera.scale, 0, 0, camera.scale, camera.offsetX, camera.offsetY);

    const hostArray = Array.from(hosts.values());
    
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
        
        // Mass is proportional to blob size: heavier hosts move less.
        const totalMass = src.radius + dst.radius;
        if (src !== draggedHost) {
            src.x += fx * (dst.radius / totalMass) * 2;
            src.y += fy * (dst.radius / totalMass) * 2;
        }
        if (dst !== draggedHost) {
            dst.x -= fx * (src.radius / totalMass) * 2;
            dst.y -= fy * (src.radius / totalMass) * 2;
        }
    }
    
    // Update host positions (gentle drift) with collision avoidance.
    // Drag (friction) bleeds off velocity so blobs settle instead of
    // creeping forward forever.
    const dragFactor = Math.exp(-dt / 0.45);
    for (let i = 0; i < hostArray.length; i++) {
        const host = hostArray[i];
        if (host === draggedHost) continue;

        host.vx = (host.vx || 0) * dragFactor;
        host.vy = (host.vy || 0) * dragFactor;
        if (Math.abs(host.vx) < 0.001) host.vx = 0;
        if (Math.abs(host.vy) < 0.001) host.vy = 0;

        host.x += host.vx * dt * 60;
        host.y += host.vy * dt * 60;
        
        if (host.x < host.radius + 60 || host.x > canvas.width - host.radius - 60) {
            host.vx = -(host.vx || 0);
        }
        if (host.y < host.radius + 80 || host.y > canvas.height - host.radius - 80) {
            host.vy = -(host.vy || 0);
        }
        
        host.x = Math.max(host.radius + 60, Math.min(canvas.width - host.radius - 60, host.x));
        host.y = Math.max(host.radius + 80, Math.min(canvas.height - host.radius - 80, host.y));
    }
    
    // Soft label-aware repulsion: push apart blob+label bounding boxes so IPs
    // and hostnames stay separated without acting as a hard collision.
    const hostBounds = new Map();
    for (const host of hostArray) {
        hostBounds.set(host, hostLabelBounds(host));
    }

    for (let i = 0; i < hostArray.length; i++) {
        for (let j = i + 1; j < hostArray.length; j++) {
            const h1 = hostArray[i];
            const h2 = hostArray[j];
            const b1 = hostBounds.get(h1);
            const b2 = hostBounds.get(h2);

            const overlapX = Math.min(h1.x + b1.halfWidth, h2.x + b2.halfWidth) -
                Math.max(h1.x - b1.halfWidth, h2.x - b2.halfWidth);
            const overlapY = Math.min(h1.y + b1.bottom, h2.y + b2.bottom) -
                Math.max(h1.y - b1.top, h2.y - b2.top);

            if (overlapX <= 0 || overlapY <= 0) {
                continue;
            }

            // Soft repulsion: resolve only part of the overlap per frame so
            // labels separate gently instead of hard-colliding.
            const totalMass = h1.radius + h2.radius;
            const horizontal = overlapX < overlapY;
            const overlap = horizontal ? overlapX : overlapY;
            const push = (overlap + 2) * 0.2;

            const moveH1 = (fraction) => {
                if (horizontal) {
                    h1.x -= Math.sign(h2.x - h1.x || 1) * push * fraction;
                } else {
                    h1.y -= Math.sign(h2.y - h1.y || 1) * push * fraction;
                }
            };
            const moveH2 = (fraction) => {
                if (horizontal) {
                    h2.x += Math.sign(h2.x - h1.x || 1) * push * fraction;
                } else {
                    h2.y += Math.sign(h2.y - h1.y || 1) * push * fraction;
                }
            };

            if (h1 === draggedHost) {
                if (h2 !== draggedHost) {
                    moveH2(1);
                }
            } else if (h2 === draggedHost) {
                moveH1(1);
            } else {
                moveH1(h2.radius / totalMass);
                moveH2(h1.radius / totalMass);
            }
        }
    }
    
    // Draw edges. Regular connections are thin gray lines; traffic to or
    // from the NetVis server itself is a thin glowing yellow line.
    ctx.strokeStyle = 'rgba(55, 55, 55, 0.9)';
    ctx.lineWidth = 1 / camera.scale;
    for (const edge of edges.values()) {
        if (isServerEdge(edge.srcIP, edge.dstIP)) {
            continue;
        }
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (src && dst) {
            ctx.beginPath();
            ctx.moveTo(src.x, src.y);
            ctx.lineTo(dst.x, dst.y);
            ctx.stroke();
        }
    }

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 220, 80, 0.95)';
    ctx.lineWidth = 1.2 / camera.scale;
    ctx.shadowBlur = 10 / camera.scale;
    ctx.shadowColor = 'rgba(255, 220, 80, 0.9)';
    for (const edge of edges.values()) {
        if (!isServerEdge(edge.srcIP, edge.dstIP)) {
            continue;
        }
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (src && dst) {
            ctx.beginPath();
            ctx.moveTo(src.x, src.y);
            ctx.lineTo(dst.x, dst.y);
            ctx.stroke();
        }
    }
    ctx.restore();
    
    // Draw particles
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.progress += p.speed;
        
        if (p.progress >= 1) {
            particles.splice(i, 1);
            continue;
        }
        
        // Follow the live host positions so packets don't miss moving hosts.
        const src = hosts.get(p.srcIP);
        const dst = hosts.get(p.dstIP);
        if (!src || !dst) {
            particles.splice(i, 1);
            continue;
        }

        // Never animate packets to/from the NetVis server itself.
        if (isServerEdge(p.srcIP, p.dstIP)) {
            particles.splice(i, 1);
            continue;
        }
        const x = src.x + (dst.x - src.x) * p.progress;
        const y = src.y + (dst.y - src.y) * p.progress;
        
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
        let fillColor, strokeColor;
        if (!hasSent) {
            fillColor = 'rgba(100, 100, 100, 0.25)';
            strokeColor = '#666';
        } else if (local) {
            fillColor = 'rgba(80, 200, 120, 0.35)';
            strokeColor = '#50c878';
        } else {
            fillColor = 'rgba(74, 144, 226, 0.3)';
            strokeColor = '#4a90e2';
        }
        // Opaque backdrop so edges/particles never show through the blob
        ctx.beginPath();
        ctx.arc(host.x, host.y, host.radius, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();

        const now = Date.now();
        const passive = now - (host.lastActivityAt || now) > settings.passiveTimeout * 1000;

        // Smoothly fade the glow in on activity and out once the glow window
        // expires (instead of switching it on/off abruptly).
        let glowTarget = 0;
        if (host.lastSentAt > 0 && settings.glowDuration > 0) {
            glowTarget = Math.max(0, 1 - (now - host.lastSentAt) / (settings.glowDuration * 1000));
        }
        const glowSmoothing = 1 - Math.exp(-dt / 0.35);
        host.glowLevel = (host.glowLevel || 0) + (glowTarget - (host.glowLevel || 0)) * glowSmoothing;
        if (host.glowLevel < 0.01) {
            host.glowLevel = 0;
        }

        ctx.save();
        if (passive) {
            ctx.globalAlpha = 0.3;
        }
        if (host.glowLevel > 0) {
            ctx.shadowBlur = 20 * host.glowLevel;
            ctx.shadowColor = strokeColor;
        }

        ctx.beginPath();
        ctx.arc(host.x, host.y, host.radius, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
        
        // Labels: IP above the blob, hostname below (empty if unavailable)
        ctx.textAlign = 'center';
        ctx.font = '11px monospace';
        
        const ipY = host.y - host.radius - 6;
        const hostnameY = host.y + host.radius + 16;
        
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        const ipText = displayIP(host);
        const ipWidth = ctx.measureText(ipText).width;
        ctx.fillRect(host.x - ipWidth / 2 - 2, ipY - 10, ipWidth + 4, 12);
        
        ctx.fillStyle = hasSent ? '#fff' : '#aaa';
        ctx.fillText(ipText, host.x, ipY);
        
        const hostnameText = displayHostname(host);
        if (hostnameText) {
            const hostnameWidth = ctx.measureText(hostnameText).width;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(host.x - hostnameWidth / 2 - 2, hostnameY - 10, hostnameWidth + 4, 12);
            ctx.fillStyle = hasSent ? '#fff' : '#aaa';
            ctx.fillText(hostnameText, host.x, hostnameY);
        }
    }
    
    requestAnimationFrame(animate);
}

animate();
