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
    updateHostArrayCache();
    if (hostArrayCache.length === 0) {
        camera.scale = 1;
        camera.offsetX = 0;
        camera.offsetY = 0;
        needRedraw = true;
        return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < hostArrayCache.length; i++) {
        const host = hostArrayCache[i];
        const bounds = hostLabelBounds(host);
        minX = Math.min(minX, host.x - bounds.halfWidth);
        maxX = Math.max(maxX, host.x + bounds.halfWidth);
        minY = Math.min(minY, host.y - bounds.top);
        maxY = Math.max(maxY, host.y + bounds.bottom);
    }

    const padding = 40 * worldAreaScale;
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
    needRedraw = true;
}

function expandWorldBounds() {
    worldAreaScale *= WORLD_AREA_SCALE_STEP;
    if (worldAreaScale > WORLD_AREA_SCALE_MAX) {
        worldAreaScale = WORLD_AREA_SCALE_MAX;
    }
    worldBounds.enabled = true;
    needRedraw = true;
}

function checkScreenFullAndAdjust() {
    updateHostArrayCache();
    const hostArray = hostArrayCache;
    if (hostArray.length === 0) {
        return;
    }

    const margin = 60;
    // Check against fixed world area walls, not viewport edges
    const worldLeftWall = margin;
    const worldRightWall = 20000 - margin;
    const worldTopWall = 80;
    const worldBottomWall = 20000 - 80;

    // Check if any hosts are touching/hitting the fixed world walls
    let touchingLeft = false;
    let touchingRight = false;
    let touchingTop = false;
    let touchingBottom = false;

    for (let i = 0; i < hostArray.length; i++) {
        const host = hostArray[i];
        const bounds = hostLabelBounds(host);
        // Consider host touching wall if it's very close to wall boundary
        if (host.x - bounds.halfWidth <= worldLeftWall + 2) {
            touchingLeft = true;
        }
        if (host.x + bounds.halfWidth >= worldRightWall - 2) {
            touchingRight = true;
        }
        if (host.y - bounds.top <= worldTopWall + 2) {
            touchingTop = true;
        }
        if (host.y + bounds.bottom >= worldBottomWall - 2) {
            touchingBottom = true;
        }
    }

    // If hosts are touching opposite fixed walls at the same time
    const fullHorizontally = touchingLeft && touchingRight;
    const fullVertically = touchingTop && touchingBottom;
    
    if (fullHorizontally || fullVertically) {
        if (worldAreaScale < WORLD_AREA_SCALE_MAX) {
            expandWorldBounds();
            fitToView();
        }
    }
}

function fitToViewExpanded() {
    updateHostArrayCache();
    if (hostArrayCache.length === 0) {
        camera.scale = 1;
        camera.offsetX = 0;
        camera.offsetY = 0;
        needRedraw = true;
        return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < hostArrayCache.length; i++) {
        const host = hostArrayCache[i];
        const bounds = hostLabelBounds(host);
        minX = Math.min(minX, host.x - bounds.halfWidth);
        maxX = Math.max(maxX, host.x + bounds.halfWidth);
        minY = Math.min(minY, host.y - bounds.top);
        maxY = Math.max(maxY, host.y + bounds.bottom);
    }

    // More padding when expanded
    const padding = 40 * worldAreaScale;
    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    // Don't over-magnify a nearly empty graph; just centre it.
    const scale = clamp(
        Math.min((canvas.width - padding * 2) / spanX, (canvas.height - padding * 2) / spanY),
        camera.minScale,
        Math.min(camera.maxScale, 2) / Math.sqrt(worldAreaScale)
    );

    camera.scale = scale;
    camera.offsetX = canvas.width / 2 - ((minX + maxX) / 2) * scale;
    camera.offsetY = canvas.height / 2 - ((minY + maxY) / 2) * scale;
    needRedraw = true;
}

let pressedHost = null;
let pressX = 0;
let pressY = 0;
let dragMoved = false;
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartOffsetX = 0;
let panStartOffsetY = 0;

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
        needRedraw = true;
        return;
    }
    // Start panning if clicking empty space
    isPanning = true;
    dragMoved = false;
    pressX = screen.x;
    pressY = screen.y;
    panStartX = screen.x;
    panStartY = screen.y;
    panStartOffsetX = camera.offsetX;
    panStartOffsetY = camera.offsetY;
    canvas.style.cursor = 'move';
    needRedraw = true;
});

canvas.addEventListener('mousemove', (e) => {
    const screen = getMousePos(e);
    const pos = screenToWorld(screen);
    if (isPanning && !draggedHost) {
        if (Math.sqrt((screen.x - panStartX) ** 2 + (screen.y - panStartY) ** 2) > 4) {
            dragMoved = true;
        }
        camera.offsetX = panStartOffsetX + (screen.x - panStartX);
        camera.offsetY = panStartOffsetY + (screen.y - panStartY);
        canvas.style.cursor = 'move';
        needRedraw = true;
        return;
    }
    if (!draggedHost) {
        canvas.style.cursor = hostAtPosition(pos) ? 'grab' : 'default';
        return;
    }
    if (Math.sqrt((screen.x - pressX) ** 2 + (screen.y - pressY) ** 2) > 4) {
        dragMoved = true;
    }
    canvas.style.cursor = 'grabbing';
    // Clamp in world space to fixed world bounds (walls independent of camera)
    const worldMinX = 60 + draggedHost.radius;
    const worldMaxX = 20000 - 60 - draggedHost.radius;
    const worldMinY = 80 + draggedHost.radius;
    const worldMaxY = 20000 - 80 - draggedHost.radius;
    draggedHost.x = clamp(pos.x - dragOffsetX, worldMinX, worldMaxX);
    draggedHost.y = clamp(pos.y - dragOffsetY, worldMinY, worldMaxY);
    needRedraw = true;
});

window.addEventListener('mouseup', () => {
    // Clicking (without dragging) a host copies its IP address
    if (pressedHost && !dragMoved) {
        copyToClipboard(pressedHost.ip);
    }
    pressedHost = null;
    draggedHost = null;
    isPanning = false;
    canvas.style.cursor = 'default';
    needRedraw = true;
});

// Wheel zoom keeps the point under the cursor fixed.
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
    needRedraw = true;
}, { passive: false });

// Touch: one finger drags a host or pans, two fingers pinch to zoom and pan.
let pinchState = null;
let touchDragging = false;
let touchPanning = false;
let touchPanStart = { x: 0, y: 0 };
let touchPanStartOffset = { x: 0, y: 0 };

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
        // A pinch supersedes any single-finger drag/pan.
        draggedHost = null;
        pressedHost = null;
        touchDragging = false;
        touchPanning = false;
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
            touchPanning = false;
            draggedHost = host;
            pressedHost = host;
            dragMoved = false;
            pressX = points[0].x;
            pressY = points[0].y;
            dragOffsetX = pos.x - host.x;
            dragOffsetY = pos.y - host.y;
            host.vx = 0;
            host.vy = 0;
            needRedraw = true;
            return;
        }
        // Pan with one finger on empty space
        touchPanning = true;
        touchDragging = false;
        draggedHost = null;
        pressedHost = null;
        dragMoved = false;
        touchPanStart = { x: points[0].x, y: points[0].y };
        touchPanStartOffset = { x: camera.offsetX, y: camera.offsetY };
        needRedraw = true;
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
        needRedraw = true;
        return;
    }

    if (touchPanning && points.length === 1) {
        e.preventDefault();
        if (Math.hypot(points[0].x - touchPanStart.x, points[0].y - touchPanStart.y) > 4) {
            dragMoved = true;
        }
        camera.offsetX = touchPanStartOffset.x + (points[0].x - touchPanStart.x);
        camera.offsetY = touchPanStartOffset.y + (points[0].y - touchPanStart.y);
        needRedraw = true;
        return;
    }

    if (touchDragging && draggedHost && points.length === 1) {
        e.preventDefault();
        if (Math.hypot(points[0].x - pressX, points[0].y - pressY) > 6) {
            dragMoved = true;
        }
        const pos = screenToWorld(points[0]);
        const worldMinX = 60 + draggedHost.radius;
        const worldMaxX = 20000 - 60 - draggedHost.radius;
        const worldMinY = 80 + draggedHost.radius;
        const worldMaxY = 20000 - 80 - draggedHost.radius;
        draggedHost.x = clamp(pos.x - dragOffsetX, worldMinX, worldMaxX);
        draggedHost.y = clamp(pos.y - dragOffsetY, worldMinY, worldMaxY);
        needRedraw = true;
    }
}, { passive: false });

function endTouch() {
    if (touchDragging) {
        if (pressedHost && !dragMoved) {
            copyToClipboard(pressedHost.ip);
        }
    }
    if (touchPanning && pressedHost && !dragMoved) {
        // no host, just pan
    }
    pinchState = null;
    touchDragging = false;
    touchPanning = false;
    pressedHost = null;
    draggedHost = null;
    needRedraw = true;
}

canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
        endTouch();
    } else if (e.touches.length === 1 && pinchState) {
        // Dropped to one finger; wait for a fresh gesture.
        pinchState = null;
        needRedraw = true;
    }
}, { passive: false });

canvas.addEventListener('touchcancel', endTouch, { passive: false });

document.getElementById('zoomIn').addEventListener('click', () => { zoomBy(1.25); needRedraw = true; });
document.getElementById('zoomOut').addEventListener('click', () => { zoomBy(1 / 1.25); needRedraw = true; });
document.getElementById('fitView').addEventListener('click', fitToView);

const hosts = new Map();
const edges = new Map();
const particles = [];
const serverIPs = new Set();

// Cached host array - rebuilt only when hosts change
let hostArrayCache = [];
let hostArrayDirty = true;

// Cached label bounds
const hostLabelBoundsCache = new Map();

// Spatial indexing for collision detection. Keep this at least as large as
// the biggest possible collision distance (2 * max host radius + 2 * halo)
// so the 3x3 neighbour search cannot miss an overlapping pair.
const SPATIAL_CELL_SIZE = 500;
const spatialGrid = new Map();

function spatialKey(cx, cy) {
    return cx * 131542391 + cy;
}

function rebuildSpatialGrid() {
    spatialGrid.clear();
    for (let i = 0; i < hostArrayCache.length; i++) {
        const host = hostArrayCache[i];
        const cx = Math.floor(host.x / SPATIAL_CELL_SIZE);
        const cy = Math.floor(host.y / SPATIAL_CELL_SIZE);
        const key = spatialKey(cx, cy);
        if (!spatialGrid.has(key)) {
            spatialGrid.set(key, []);
        }
        spatialGrid.get(key).push(host);
    }
}

function getNearbyHosts(host) {
    const cx = Math.floor(host.x / SPATIAL_CELL_SIZE);
    const cy = Math.floor(host.y / SPATIAL_CELL_SIZE);
    const nearby = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const key = spatialKey(cx + dx, cy + dy);
            const cell = spatialGrid.get(key);
            if (cell) {
                for (let i = 0; i < cell.length; i++) {
                    nearby.push(cell[i]);
                }
            }
        }
    }
    return nearby;
}

function updateHostArrayCache() {
    if (hostArrayDirty) {
        hostArrayCache = Array.from(hosts.values());
        hostArrayDirty = false;
        rebuildSpatialGrid();
    }
}

// Detect the web port from the current page location (no hardcoding).
function getWebPort() {
    if (window.location.port) {
        const p = parseInt(window.location.port, 10);
        if (!isNaN(p) && p > 0) {
            return p;
        }
    }
    if (window.location.protocol === 'https:') {
        return 443;
    }
    return 80;
}

let webPort = getWebPort();

// Only TCP connections to/from the NetVis frontend (HTTP/WebSocket) on the
// web port are treated as frontend traffic - drawn as a glowing edge with
// no particles.
const frontendConnections = new Set();

function frontendKey(srcIP, dstIP) {
    return srcIP + '|' + dstIP;
}

function isFrontendTraffic(srcIP, dstIP) {
    if (!webPort || webPort <= 0) {
        return false;
    }
    if (!serverIPs.has(srcIP) && !serverIPs.has(dstIP)) {
        return false;
    }
    return frontendConnections.has(frontendKey(srcIP, dstIP)) ||
           frontendConnections.has(frontendKey(dstIP, srcIP));
}

const hostCountEl = document.getElementById('hostCount');
const edgeCountEl = document.getElementById('edgeCount');

let draggedHost = null;
let dragOffsetX = 0;
let dragOffsetY = 0;

// Visualization area/world bounds - expands when screen is full
// World bounds define the allowed area hosts can move in (independent of camera view)
let worldBounds = {
    minX: -Infinity,
    maxX: Infinity,
    minY: -Infinity,
    maxY: Infinity,
    enabled: false
};
let baseWorldMargin = { left: 60, right: 60, top: 80, bottom: 80 };
let worldAreaScale = 1.0;
const WORLD_AREA_SCALE_STEP = 1.3;
const WORLD_AREA_SCALE_MAX = 8.0;

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
    angleDistribution: 0.1,
    dampening: 2.0,
    constantDrag: 1.0,
    centeringForce: 0.001,
    packetSpeed: 0.005,
    packetSizeScale: 0.3,
    minHostSize: 5,
    maxHostSize: 44,
    collisionHalo: 20,
    glowDuration: 10,
    passiveTimeout: 120,
    autoRemovePassive: false,
    velocitySleepThreshold: 0.1,
    forceSleepThreshold: 0.01,
    positionSleepThreshold: 0.05
};

function bindSlider(id, key, format, onChange) {
    const input = document.getElementById(id);
    // Optional controls (e.g. sleep thresholds) may not exist in the UI.
    if (!input) return;
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
bindSlider('angleDistribution', 'angleDistribution', (v) => v.toFixed(3));
bindSlider('dampening', 'dampening', (v) => v.toFixed(2));
bindSlider('constantDrag', 'constantDrag', (v) => v.toFixed(3));
bindSlider('packetSpeed', 'packetSpeed', (v) => v.toFixed(3));
bindSlider('packetSize', 'packetSizeScale', (v) => v.toFixed(1));
bindSlider('minHostSize', 'minHostSize', (v) => v.toFixed(0), () => updateHostSizes());
bindSlider('maxHostSize', 'maxHostSize', (v) => v.toFixed(0), () => updateHostSizes());
bindSlider('collisionHalo', 'collisionHalo', (v) => v.toFixed(0));
bindSlider('glowDuration', 'glowDuration', (v) => v.toFixed(0));
bindSlider('passiveTimeout', 'passiveTimeout', (v) => v.toFixed(0));
bindSlider('velocitySleepThreshold', 'velocitySleepThreshold', (v) => v.toFixed(3));
bindSlider('forceSleepThreshold', 'forceSleepThreshold', (v) => v.toFixed(3));
bindSlider('positionSleepThreshold', 'positionSleepThreshold', (v) => v.toFixed(3));

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
    hostLabelBoundsCache.clear();
    for (const [key, edge] of edges) {
        if (!hosts.has(edge.srcIP) || !hosts.has(edge.dstIP)) {
            edges.delete(key);
        }
    }
    if (draggedHost && removed.includes(draggedHost.ip)) {
        draggedHost = null;
    }
    hostArrayDirty = true;
    needRedraw = true;
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
    const key = host.ip + '|' + displayIP(host) + '|' + displayHostname(host) + '|' + Math.round(host.radius);
    const cached = hostLabelBoundsCache.get(key);
    if (cached) {
        return cached;
    }
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

    const bounds = {
        halfWidth: width / 2 + padding,
        top: host.radius + 16 + padding * 0.5 + verticalMargin,
        bottom: host.radius + 18 + padding * 0.5 + verticalMargin
    };
    hostLabelBoundsCache.set(key, bounds);
    return bounds;
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
            const old = host.radius;
            host.radius = (minRadius + maxRadius) / 2;
            if (old !== host.radius) {
                hostLabelBoundsCache.clear();
            }
        }
        return;
    }
    for (const host of hostArray) {
        const t = getHostTraffic(host.ip);
        let newRadius;
        if (t === maxTraffic) {
            newRadius = maxRadius;
        } else if (t === minTraffic) {
            newRadius = minRadius;
        } else {
            const ratio = (t - minTraffic) / (maxTraffic - minTraffic);
            newRadius = minRadius + ratio * (maxRadius - minRadius);
        }
        if (host.radius !== newRadius) {
            host.radius = newRadius;
            hostLabelBoundsCache.clear();
        }
    }
}

function segmentsIntersect(x1,y1,x2,y2,x3,y3,x4,y4) {
    const denom = (y4-y3)*(x2-x1) - (x4-x3)*(y2-y1);
    if (Math.abs(denom) < 1e-10) return false;
    const ua = ((x4-x3)*(y1-y3) - (y4-y3)*(x1-x3)) / denom;
    const ub = ((x2-x1)*(y1-y3) - (y2-y1)*(x1-x3)) / denom;
    if (ua > 1e-9 && ua < 1-1e-9 && ub > 1e-9 && ub < 1-1e-9) {
        return true;
    }
    return false;
}

function countEdgeCrossingsAtPoint(px, py) {
    let crossings = 0;
    // A point at edge doesn't create crossings; we check if connecting through
    // this point would intersect other edges - but easier: count how many
    // existing edges would be intersected by lines from this point to potential
    // connection points? Or more directly, count edge crossings near this point
    // by checking intersections between edges and rays - but the requirement says
    // "where the connection edges cross as few other edges as possible"
    // So place so that new connections don't cross many existing edges.
    // Count crossings between a hypothetical edge from this point to anywhere
    // and existing edges - or just count existing edge crossings in the area.
    // Try to minimize total crossings involving edges to/from this new host.
    for (const edge of edges.values()) {
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (!src || !dst) continue;
        // Check if a line from (px,py) to src crosses any other edge, 
        // or just count general edge crossings in vicinity
        // Count how many existing edges this potential position would intersect
        // with connections to other hosts - approximate by checking intersection
        // with all existing edges (excluding edges incident to this hypothetical host)
        if (segmentsIntersect(px, py, src.x, src.y, dst.x, dst.y, src.x, src.y)) continue;
    }
    // Better approach: count how many existing edges are intersected by
    // the shortest path/line to place it - alternatively count total number
    // of edge-edge intersections in the neighborhood weighted toward edges
    for (const edge of edges.values()) {
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (!src || !dst) continue;
        // Check intersection of edges that might connect to this point
        // Count if placing here would create crossings with existing edges
        // A simple heuristic: count how many existing edges pass near and intersect
        for (const edge2 of edges.values()) {
            if (edge === edge2) continue;
            const s2 = hosts.get(edge2.srcIP);
            const t2 = hosts.get(edge2.dstIP);
            if (!s2 || !t2) continue;
            if (segmentsIntersect(src.x, src.y, dst.x, dst.y, s2.x, s2.y, t2.x, t2.y)) {
                crossings++;
            }
        }
    }
    // Actually want to minimize crossings of connections FROM this new host
    // to its neighbors. But at placement time, we don't know neighbors yet.
    // Or look up - maybe place near edge and minimize crossings of edges in general area?
    // The requirement says "prefer locations near the edge, where the connection edges cross as few other edges as possible"
    // So overall minimize edge crossings in the graph layout? Or for the new host's connections?
    // Try to place the new host so that its edges (when added) cross few others.
    // So find position (near edge) that has fewest intersections between
    // potential edges from this point to existing hosts and other existing edges.
    return crossings;
}

function countCrossingsForPoint(px, py) {
    let crossings = 0;
    // Check intersections between hypothetical edges from (px,py) to every existing host
    // and all existing edges
    for (const other of hosts.values()) {
        for (const edge of edges.values()) {
            const src = hosts.get(edge.srcIP);
            const dst = hosts.get(edge.dstIP);
            if (!src || !dst) continue;
            // Don't count if the existing edge involves 'other'? 
            if ((edge.srcIP === other.ip && edge.dstIP === other.ip)) continue;
            if (edge.srcIP === other.ip || edge.dstIP === other.ip) {
                // Connecting to other means this would be a parallel-ish connection to an endpoint of existing edge?
                // Skip counting as crossing if it shares endpoint
                continue;
            }
            if (segmentsIntersect(px, py, other.x, other.y, src.x, src.y, dst.x, dst.y)) {
                crossings++;
            }
        }
    }
    return crossings;
}

function findBestHostPosition(connectedToIps) {
    const margin = 60;
    const candidates = [];
    
    // If we know which host this will connect to, prefer edge closest to it
    if (connectedToIps && connectedToIps.length > 0) {
        for (const cip of connectedToIps) {
            const ch = hosts.get(cip);
            if (!ch) continue;
            // Project from center toward ch, intersect with screen edge
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const dx = ch.x - cx;
            const dy = ch.y - cy;
            const len = Math.sqrt(dx*dx + dy*dy) || 1;
            // Try to place near the edge in the direction of the connected host
            // Find closest edge point
            const tLeft = (margin - cx) / (dx / len);
            const tRight = (canvas.width - margin - cx) / (dx / len);
            const tTop = (margin - cy) / (dy / len);
            const tBottom = (canvas.height - margin - cy) / (dy / len);
            // Pick the smallest positive t that intersects an edge
            const ts = [];
            if (tLeft > 0 && Math.abs(cy + (dy/len)*tLeft) <= canvas.height) ts.push({t:tLeft, x:margin, y: cy + (dy/len)*tLeft});
            if (tRight > 0 && Math.abs(cy + (dy/len)*tRight) <= canvas.height) ts.push({t:tRight, x:canvas.width-margin, y: cy + (dy/len)*tRight});
            if (tTop > 0 && Math.abs(cx + (dx/len)*tTop) <= canvas.width) ts.push({t:tTop, x: cx + (dx/len)*tTop, y: margin});
            if (tBottom > 0 && Math.abs(cx + (dx/len)*tBottom) <= canvas.width) ts.push({t:tBottom, x: cx + (dx/len)*tBottom, y: canvas.height-margin});
            if (ts.length > 0) {
                ts.sort((a,b) => a.t - b.t);
                const pt = ts[0];
                // Add candidates around this closest edge point
                for (let da = -30; da <= 30; da += 10) {
                    candidates.push({x: pt.x + da, y: pt.y});
                    candidates.push({x: pt.x, y: pt.y + da});
                }
            }
        }
    }
    
    // Edge positions around the whole screen as fallback
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
        candidates.push({x: (canvas.width * i) / steps, y: margin});
        candidates.push({x: (canvas.width * i) / steps, y: canvas.height - margin});
    }
    for (let i = 1; i < steps; i++) {
        candidates.push({x: margin, y: (canvas.height * i) / steps});
        candidates.push({x: canvas.width - margin, y: (canvas.height * i) / steps});
    }
    // Random edge-biased positions
    for (let i = 0; i < 40; i++) {
        const side = Math.floor(Math.random() * 4);
        if (side === 0) candidates.push({x: Math.random() * canvas.width, y: margin + Math.random() * 40});
        else if (side === 1) candidates.push({x: Math.random() * canvas.width, y: canvas.height - margin - Math.random() * 40});
        else if (side === 2) candidates.push({x: margin + Math.random() * 40, y: Math.random() * canvas.height});
        else candidates.push({x: canvas.width - margin - Math.random() * 40, y: Math.random() * canvas.height});
    }
    
    let best = candidates[0] || {x: margin, y: margin};
    let bestScore = Infinity;
    
    for (const c of candidates) {
        const crossings = countCrossingsForPoint(c.x, c.y);
        let score = crossings * 1000;
        if (connectedToIps && connectedToIps.length > 0) {
            for (const cip of connectedToIps) {
                const ch = hosts.get(cip);
                if (ch) {
                    const dx = ch.x - c.x;
                    const dy = ch.y - c.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    score += dist * 0.1; // prefer closer to connected host
                }
            }
        }
        for (const h of hosts.values()) {
            const dx = h.x - c.x;
            const dy = h.y - c.y;
            const dist = Math.sqrt(dx*dx + dy*dy);
            if (dist < 80) score += (80 - dist) * 10;
        }
        if (score < bestScore) {
            bestScore = score;
            best = c;
        }
    }
    return best;
}

function getHostPosition(ip) {
    if (!hosts.has(ip)) {
        // Try to place near edge with fewest edge crossings
        const pos = findBestHostPosition([]);
        hosts.set(ip, {
            ip: ip,
            hostname: '',
            x: pos.x,
            y: pos.y,
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
        hostArrayDirty = true;
        needRedraw = true;
        updateHostSizes();
    }
    return hosts.get(ip);
}

const ws = new WebSocket(`ws://${window.location.host}/ws`);

ws.onmessage = (event) => {
    const raw = JSON.parse(event.data);
    if (raw.type === 'batch' && Array.isArray(raw.data)) {
        for (let i = 0; i < raw.data.length; i++) {
            handleMessage(raw.data[i]);
        }
        return;
    }
    handleMessage(raw);
};

function handleMessage(msg) {
    
    if (msg.type === 'snapshot') {
        const data = msg.data;
        serverIPs.clear();
        frontendConnections.clear();
        if (data.serverIPs) {
            for (const ip of data.serverIPs) {
                serverIPs.add(ip);
            }
        }
        // Prefer server-reported port if available, otherwise fall back to
        // browser location (works for custom ports).
        if (typeof data.webPort === 'number' && data.webPort > 0) {
            webPort = data.webPort;
        } else if (data.webPort) {
            const p = parseInt(data.webPort);
            if (!isNaN(p) && p > 0) {
                webPort = p;
            } else if (webPort === 0 || webPort === 80 || webPort === 443) {
                webPort = getWebPort();
            }
        } else {
            webPort = getWebPort();
        }
        if (data.hosts) {
            for (const h of data.hosts) {
                if (!hosts.has(h.ip)) {
                    const pos = findBestHostPosition([]);
                    hosts.set(h.ip, {
                        ip: h.ip,
                        hostname: h.hostname,
                        x: pos.x,
                        y: pos.y,
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
                    hostLabelBoundsCache.clear();
                    hostArrayDirty = true;
                    needRedraw = true;
                } else {
                    const host = hosts.get(h.ip);
                    host.hostname = h.hostname;
                    hostLabelBoundsCache.clear();
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
                needRedraw = true;
            }
        }
        hostLabelBoundsCache.clear();
        updateHostSizes();
        updateStats();
    } else if (msg.type === 'host') {
        const info = msg.data;
        const host = hosts.get(info.ip);
        if (host) {
            if (host.hostname !== info.hostname) {
                host.hostname = info.hostname;
                hostLabelBoundsCache.clear();
                needRedraw = true;
            }
        }
        updateStats();
    } else if (msg.type === 'packet') {
        const ev = msg.data;
        const srcHost = hosts.has(ev.srcIP) ? hosts.get(ev.srcIP) : (function(){ const p = findBestHostPosition([ev.dstIP]); hosts.set(ev.srcIP,{ip:ev.srcIP,hostname:'',x:p.x,y:p.y,vx:(Math.random()-0.5)*0.3,vy:(Math.random()-0.5)*0.3,radius:22,sentCount:0,receivedCount:0,bytesSent:0,bytesReceived:0,lastSentAt:0,lastActivityAt:Date.now(),glowLevel:0}); hostArrayDirty=true; needRedraw=true; updateHostSizes(); return hosts.get(ev.srcIP); })();
        const dstHost = hosts.has(ev.dstIP) ? hosts.get(ev.dstIP) : (function(){ const p = findBestHostPosition([ev.srcIP]); hosts.set(ev.dstIP,{ip:ev.dstIP,hostname:'',x:p.x,y:p.y,vx:(Math.random()-0.5)*0.3,vy:(Math.random()-0.5)*0.3,radius:22,sentCount:0,receivedCount:0,bytesSent:0,bytesReceived:0,lastSentAt:0,lastActivityAt:Date.now(),glowLevel:0}); hostArrayDirty=true; needRedraw=true; updateHostSizes(); return hosts.get(ev.dstIP); })();
        const now = Date.now();
        srcHost.sentCount = (srcHost.sentCount || 0) + 1;
        dstHost.receivedCount = (dstHost.receivedCount || 0) + 1;
        srcHost.bytesSent = (srcHost.bytesSent || 0) + ev.bytes;
        dstHost.bytesReceived = (dstHost.bytesReceived || 0) + ev.bytes;
        srcHost.lastSentAt = now;
        srcHost.lastActivityAt = now;
        dstHost.lastActivityAt = now;
        needRedraw = true;
        updateHostSizes();
        
        const key = edgeKey(ev.srcIP, ev.dstIP);
        if (!edges.has(key)) {
            edges.set(key, { srcIP: ev.srcIP, dstIP: ev.dstIP, count: 1, bytes: ev.bytes });
        } else {
            const e = edges.get(key);
            e.count++;
            e.bytes += ev.bytes;
        }
        
        // Track connections to/from the NetVis web frontend (HTTP/WebSocket).
        if (webPort > 0 && ev.proto === 'TCP') {
            const srcIsServer = serverIPs.has(ev.srcIP);
            const dstIsServer = serverIPs.has(ev.dstIP);
            if (srcIsServer && ev.srcPort === webPort) {
                frontendConnections.add(frontendKey(ev.dstIP, ev.srcIP));
            } else if (dstIsServer && ev.dstPort === webPort) {
                frontendConnections.add(frontendKey(ev.srcIP, ev.dstIP));
            }
        }

        // Only connections that use the NetVis frontend are represented by a
        // glowing edge; don't animate individual particles for them.
        if (!isFrontendTraffic(ev.srcIP, ev.dstIP)) {
            particles.push({
                srcIP: ev.srcIP,
                dstIP: ev.dstIP,
                progress: 0,
                speed: settings.packetSpeed,
                size: Math.max(2, Math.min(8, Math.log10(ev.bytes + 1) * 3)) * settings.packetSizeScale,
                color: protocolColors[ev.proto] || protocolColors.OTHER,
                life: 1.0
            });
            if (particles.length > 500) {
                particles.shift();
            }
        }
        needRedraw = true;
        
        updateStats();
    }
}

function updateStats() {
    hostCountEl.textContent = hosts.size;
    edgeCountEl.textContent = edges.size;
}

let lastFrameTime = performance.now();
let needRedraw = true;
let physicsAccumulator = 0;
const PHYSICS_STEP = 1 / 30; // Throttle physics to 30Hz

function runPhysics(stepDt) {
    updateHostArrayCache();
    const hostArray = hostArrayCache;
    const dt = Math.max(1e-6, stepDt);
    if (hostArray.length === 0) return;

    const vSleep = typeof settings.velocitySleepThreshold === 'number' ? settings.velocitySleepThreshold : 0.05;
    const fSleep = typeof settings.forceSleepThreshold === 'number' ? settings.forceSleepThreshold : 0.01;
    const pSleep = typeof settings.positionSleepThreshold === 'number' ? settings.positionSleepThreshold : 0.05;

    // Attraction force along connections.
    for (const edge of edges.values()) {
        const src = hosts.get(edge.srcIP);
        const dst = hosts.get(edge.dstIP);
        if (!src || !dst || src === dst) continue;
        if (src === draggedHost && dst === draggedHost) continue;

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
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
        const targetDist = src.radius + dst.radius + 90;
        let force = (dist - targetDist) * strength * 0.02;
        if (Math.abs(force) < fSleep) {
            force = 0;
        }
        force = Math.max(-1.5, Math.min(1.5, force));
        if (force === 0) continue;

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        const totalMass = Math.max(1e-6, src.radius + dst.radius);
        if (src !== draggedHost) {
            src.vx = (src.vx || 0) + fx * (dst.radius / totalMass) * 2;
            src.vy = (src.vy || 0) + fy * (dst.radius / totalMass) * 2;
        }
        if (dst !== draggedHost) {
            dst.vx = (dst.vx || 0) - fx * (src.radius / totalMass) * 2;
            dst.vy = (dst.vy || 0) - fy * (src.radius / totalMass) * 2;
        }
    }

    // Spread edges evenly around each host. Equalising the angular gaps
    // between neighbours avoids the constant rotation caused by anchoring
    // them to a moving arithmetic mean, and keeps hubs stable.
    if (settings.angleDistribution > 0) {
        // Build an undirected adjacency map once per step. A Map also
        // de-duplicates bidirectional edges to the same neighbour.
        const adjacency = new Map();
        for (const edge of edges.values()) {
            const src = hosts.get(edge.srcIP);
            const dst = hosts.get(edge.dstIP);
            if (!src || !dst || src === dst) continue;
            let neighbors = adjacency.get(src);
            if (!neighbors) {
                neighbors = new Map();
                adjacency.set(src, neighbors);
            }
            neighbors.set(dst.ip, dst);
            neighbors = adjacency.get(dst);
            if (!neighbors) {
                neighbors = new Map();
                adjacency.set(dst, neighbors);
            }
            neighbors.set(src.ip, src);
        }

        const spread = Math.max(0, Math.min(1, settings.angleDistribution));
        const twoPi = Math.PI * 2;
        for (let i = 0; i < hostArray.length; i++) {
            const host = hostArray[i];
            if (host === draggedHost) continue;
            const neighborMap = adjacency.get(host);
            if (!neighborMap || neighborMap.size < 2) continue;

            const neighbors = [];
            for (const neighbor of neighborMap.values()) {
                const dx = neighbor.x - host.x;
                const dy = neighbor.y - host.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 1e-6) continue;
                neighbors.push({ host: neighbor, angle: Math.atan2(dy, dx), dx, dy, dist });
            }
            const n = neighbors.length;
            if (n < 2) continue;
            neighbors.sort((a, b) => a.angle - b.angle);
            const idealSep = twoPi / n;

            // Accumulate corrections first so every gap is measured from the
            // same positions rather than from already-shifted neighbours.
            const corrections = new Map();
            for (let ni = 0; ni < n; ni++) {
                const current = neighbors[ni];
                const next = neighbors[(ni + 1) % n];
                let gap = next.angle - current.angle;
                if (gap <= 0) gap += twoPi;
                const error = gap - idealSep;
                if (Math.abs(error) < fSleep) continue;

                // Close part of the gap error without rotating the whole ring.
                // Use a bounded tangential displacement so long edges don't
                // fling a shared neighbour across the canvas in one step.
                // A busier neighbour acts as an anchor and is not shoved
                // around by a node with fewer connections.
                const gapMove = error * spread * 5;
                const hostDegree = neighborMap.size;
                if (current.host !== draggedHost) {
                    const currentLinks = adjacency.get(current.host);
                    const currentDegree = currentLinks ? currentLinks.size : 1;
                    if (currentDegree <= hostDegree) {
                        let correction = corrections.get(current.host);
                        if (!correction) {
                            correction = { x: 0, y: 0 };
                            corrections.set(current.host, correction);
                        }
                        correction.x += (-current.dy / current.dist) * gapMove;
                        correction.y += (current.dx / current.dist) * gapMove;
                    }
                }
                if (next.host !== draggedHost) {
                    const nextLinks = adjacency.get(next.host);
                    const nextDegree = nextLinks ? nextLinks.size : 1;
                    if (nextDegree <= hostDegree) {
                        let correction = corrections.get(next.host);
                        if (!correction) {
                            correction = { x: 0, y: 0 };
                            corrections.set(next.host, correction);
                        }
                        correction.x -= (-next.dy / next.dist) * gapMove;
                        correction.y -= (next.dx / next.dist) * gapMove;
                    }
                }
            }
            for (const [neighbor, correction] of corrections) {
                neighbor.x += correction.x;
                neighbor.y += correction.y;
            }
        }
    }

    // Update host positions with drag
    const dragFactor = Math.exp(-dt / Math.max(0.01, settings.dampening || 0.25));
    const cDrag = Math.max(0, settings.constantDrag || 0);
    const cDragFactor = cDrag > 0 ? Math.exp(-cDrag * dt * 60) : 1;
    // Walls are fixed in world space (independent of camera zoom/pan)
    const wallLeft = 60;
    const wallRight = 60;
    const wallTop = 80;
    const wallBottom = 80;
    const worldMaxX = 20000;
    const worldMaxY = 20000;
    for (let i = 0; i < hostArray.length; i++) {
        const host = hostArray[i];
        if (host === draggedHost) continue;

        host.vx = (host.vx || 0) * dragFactor * cDragFactor;
        host.vy = (host.vy || 0) * dragFactor * cDragFactor;
        const sv = Math.hypot(host.vx || 0, host.vy || 0);
        if (sv < vSleep) {
            host.vx = 0;
            host.vy = 0;
        } else if (Math.abs(host.vx) < vSleep) {
            host.vx = 0;
        } else if (Math.abs(host.vy) < vSleep) {
            host.vy = 0;
        }

        host.x += host.vx * dt * 60;
        host.y += host.vy * dt * 60;

        const minX = wallLeft + host.radius;
        const maxX = worldMaxX - wallRight - host.radius;
        const minY = wallTop + host.radius;
        const maxY = worldMaxY - wallBottom - host.radius;
        if (host.x < minX) {
            host.x = minX;
            host.vx = -host.vx * 0.6;
        } else if (host.x > maxX) {
            host.x = maxX;
            host.vx = -host.vx * 0.6;
        }
        if (host.y < minY) {
            host.y = minY;
            host.vy = -host.vy * 0.6;
        } else if (host.y > maxY) {
            host.y = maxY;
            host.vy = -host.vy * 0.6;
        }
    }

    // Gently pull every blob toward the centre of the visible world so
    // weakly connected components cannot drift away indefinitely. This is a
    // positional spring, applied after the sleep check so a low centering
    // impulse is not discarded before it has a chance to act.
    const centering = typeof settings.centeringForce === 'number' ? settings.centeringForce : 0;
    if (centering > 0) {
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        for (let i = 0; i < hostArray.length; i++) {
            const host = hostArray[i];
            if (host === draggedHost) continue;
            const dx = centerX - host.x;
            const dy = centerY - host.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1e-3) continue;
            const move = Math.min(2, dist * centering * 2);
            host.x += (dx / dist) * move;
            host.y += (dy / dist) * move;
        }
    }

    // Soft circular repulsion using spatial indexing. Labels are rendered
    // separately and do not participate in collision handling; each blob
    // collides using its radius plus the configurable halo.
    const halo = Math.max(0, typeof settings.collisionHalo === 'number' ? settings.collisionHalo : 0);
    rebuildSpatialGrid();
    const processedPairs = new Set();
    for (let i = 0; i < hostArray.length; i++) {
        const h1 = hostArray[i];
        const nearby = getNearbyHosts(h1);
        for (let k = 0; k < nearby.length; k++) {
            const h2 = nearby[k];
            if (h1 === h2) continue;
            const pk = h1.ip < h2.ip ? h1.ip + '|' + h2.ip : h2.ip + '|' + h1.ip;
            if (processedPairs.has(pk)) continue;
            processedPairs.add(pk);

            const r1 = h1.radius + halo;
            const r2 = h2.radius + halo;
            const minDist = r1 + r2;
            const dx = h2.x - h1.x;
            const dy = h2.y - h1.y;
            const distSq = dx * dx + dy * dy;
            if (distSq >= minDist * minDist) {
                continue;
            }

            const dist = Math.sqrt(distSq);
            let nx = 1;
            let ny = 0;
            if (dist > 1e-6) {
                nx = dx / dist;
                ny = dy / dist;
            }
            const overlap = minDist - dist;
            const push = (overlap + 2) * 0.2;
            if (push < pSleep) {
                continue;
            }

            if (h1 === draggedHost) {
                h2.x += nx * push;
                h2.y += ny * push;
                const sv2 = Math.hypot(h2.vx || 0, h2.vy || 0);
                if (sv2 < vSleep) {
                    h2.vx = 0;
                    h2.vy = 0;
                }
            } else if (h2 === draggedHost) {
                h1.x -= nx * push;
                h1.y -= ny * push;
                const sv1 = Math.hypot(h1.vx || 0, h1.vy || 0);
                if (sv1 < vSleep) {
                    h1.vx = 0;
                    h1.vy = 0;
                }
            } else {
                const totalMass = Math.max(1e-6, r1 + r2);
                const push1 = push * (r2 / totalMass);
                const push2 = push * (r1 / totalMass);
                if (push1 >= pSleep) {
                    h1.x -= nx * push1;
                    h1.y -= ny * push1;
                    const sv1 = Math.hypot(h1.vx || 0, h1.vy || 0);
                    if (sv1 < vSleep) {
                        h1.vx = 0;
                        h1.vy = 0;
                    }
                }
                if (push2 >= pSleep) {
                    h2.x += nx * push2;
                    h2.y += ny * push2;
                    const sv2 = Math.hypot(h2.vx || 0, h2.vy || 0);
                    if (sv2 < vSleep) {
                        h2.vx = 0;
                        h2.vy = 0;
                    }
                }
            }
        }
    }
    hostArrayDirty = true;
}

function animate() {
    const frameTime = performance.now();
    const dt = Math.min((frameTime - lastFrameTime) / 1000, 0.1);
    lastFrameTime = frameTime;

    physicsAccumulator += dt;
    let didPhysics = false;
    while (physicsAccumulator >= PHYSICS_STEP) {
        physicsAccumulator -= PHYSICS_STEP;
        didPhysics = true;
        runPhysics(PHYSICS_STEP);
    }

    if (!needRedraw && !didPhysics && particles.length === 0 && hostArrayCache.length === 0) {
        requestAnimationFrame(animate);
        return;
    }

    if (didPhysics || needRedraw || particles.length > 0) {
        needRedraw = false;
    }

    // Check if screen is full and adjust visualization area (walls independent of camera)
    if (didPhysics) {
        checkScreenFullAndAdjust();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw the world through the camera transform.
    ctx.setTransform(camera.scale, 0, 0, camera.scale, camera.offsetX, camera.offsetY);

    updateHostArrayCache();
    const hostArray = hostArrayCache;
    
    // Draw edges. Regular connections are thin gray lines; only connections
    // that use the NetVis frontend are shown as a thin glowing yellow line.
    ctx.strokeStyle = 'rgba(55, 55, 55, 0.9)';
    ctx.lineWidth = 1 / camera.scale;
    for (const edge of edges.values()) {
        if (isFrontendTraffic(edge.srcIP, edge.dstIP)) {
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
        if (!isFrontendTraffic(edge.srcIP, edge.dstIP)) {
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

        // Never animate packets using the NetVis frontend.
        if (isFrontendTraffic(p.srcIP, p.dstIP)) {
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
