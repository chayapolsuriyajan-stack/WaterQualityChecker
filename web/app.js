// --- MINI MAP ---
// Coordinates from OpenStreetMap Nominatim for Chiang Mai University Demonstration School (Satit CMU).
const satitCmuCoords = [18.7951937, 98.9550936];
const siteMap = L.map('siteMap', {
    scrollWheelZoom: false
}).setView(satitCmuCoords, 16);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19
}).addTo(siteMap);

L.marker(satitCmuCoords).addTo(siteMap)
    .bindPopup('Satit CMU<br>Chiang Mai, Thailand')
    .openPopup();

// Leaflet measures its container at init time; if the page layout shifts after
// that (e.g. Tailwind's CDN build finishing its async style injection), the map
// can be left sized wrong until something tells it to re-measure.
window.addEventListener('load', () => siteMap.invalidateSize());

// --- WEBSOCKET PIPELINE ---
const espWebSocketUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:8080/ws/app`;
let socket;

function connectWebSocket() {
    socket = new WebSocket(espWebSocketUrl);

    socket.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            // Support broadcast format: { type: 'sensor_update', payload: { temperature, turbidity, tds, stats } }
            const p = (data && data.type === 'sensor_update' && data.payload) ? data.payload : data;
            if (!p || typeof p !== 'object') {
                console.warn('Unknown sensor message format', data);
                return;
            }
            // Running min/max lives on the backend (since server start) and rides along on
            // every reading, plus a stats-only snapshot when the dashboard first connects.
            if (p.stats) {
                updateRanges(p.stats);
            }
            // A stats-only snapshot carries no live reading -- don't zero out the values.
            if (p.temperature !== undefined && p.turbidity !== undefined) {
                updateDashboard(Number(p.temperature), Number(p.turbidity), Number(p.tds || 0));
            }
        } catch (e) {
            console.error("Payload processing error", e, event.data);
        }
    };

    socket.onclose = () => {
        startSimulation();
    };
}

// --- UI RENDERING ---
// Dissolved Oxygen, pH, the WQI score/trend, map, and pollutant source chart stay
// static placeholders here -- there's no sensor feeding those yet.
function updateDashboard(temp, turb, tds) {
    document.getElementById('paramTemp').innerText = `${temp.toFixed(1)} °C`;
    document.getElementById('paramTurb').innerText = `${Math.round(turb)} NTU`;
    document.getElementById('paramTds').innerText = `${Math.round(tds)} ppm`;

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    document.getElementById('lastUpdated').innerText = `Last updated: ${timeNow}`;
}

// Renders the backend's running min/max (since server start) under each parameter.
function updateRanges(stats) {
    const render = (elementId, stat, digits, unit) => {
        if (!stat) return;
        const el = document.getElementById(elementId);
        if (!el) return;
        el.innerText = `min ${Number(stat.min).toFixed(digits)} / max ${Number(stat.max).toFixed(digits)}${unit}`;
    };
    render('rangeTemp', stats.temperature, 1, ' °C');
    render('rangeTurb', stats.turbidity, 0, ' NTU');
    render('rangeTds', stats.tds, 0, ' ppm');
}

// --- DATA GENERATOR FALLBACK ---
let simInterval;
function startSimulation() {
    if (simInterval) clearInterval(simInterval);
    // No backend while simulating, so track min/max client-side from the mock values
    // to keep the range display coherent instead of frozen at "--".
    const simStats = {};
    const track = (key, value) => {
        const s = simStats[key] || (simStats[key] = { min: value, max: value });
        s.min = Math.min(s.min, value);
        s.max = Math.max(s.max, value);
    };
    simInterval = setInterval(() => {
        const mockTemp = 23 + Math.random() * 2;
        const mockTurb = 120 + Math.random() * 40;
        const mockTds = 300 + Math.random() * 100;
        updateDashboard(mockTemp, mockTurb, mockTds);
        track('temperature', mockTemp);
        track('turbidity', mockTurb);
        track('tds', mockTds);
        updateRanges(simStats);
    }, 2000);
}

// Initialize connection on dashboard launch
connectWebSocket();
