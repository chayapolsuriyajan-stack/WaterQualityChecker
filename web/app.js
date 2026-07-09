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
            // Support broadcast format: { type: 'sensor_update', payload: { temperature, turbidity, tds } }
            if (data && data.type === 'sensor_update' && data.payload) {
                const p = data.payload;
                updateDashboard(Number(p.temperature || 0), Number(p.turbidity || 0), Number(p.tds || 0));
            } else if (data && data.temperature !== undefined && data.turbidity !== undefined) {
                updateDashboard(Number(data.temperature), Number(data.turbidity), Number(data.tds || 0));
            } else {
                console.warn('Unknown sensor message format', data);
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

// --- DATA GENERATOR FALLBACK ---
let simInterval;
function startSimulation() {
    if (simInterval) clearInterval(simInterval);
    simInterval = setInterval(() => {
        const mockTemp = 23 + Math.random() * 2;
        const mockTurb = 120 + Math.random() * 40;
        const mockTds = 300 + Math.random() * 100;
        updateDashboard(mockTemp, mockTurb, mockTds);
    }, 2000);
}

// Initialize connection on dashboard launch
connectWebSocket();
