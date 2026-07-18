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
// Unit the backend is currently sending for turbidity ('NTU' once calibrated, else 'ADC').
let turbidityUnit = 'ADC';

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
            // Turbidity now arrives as calibrated NTU once a backend calibration exists,
            // else raw ADC. `turbidityUnit` says which; remember it for the range labels too.
            if (p.turbidityUnit) turbidityUnit = p.turbidityUnit;
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
    // Turbidity shows calibrated NTU when the backend has a calibration, else raw ADC.
    document.getElementById('paramTurb').innerText =
        turbidityUnit === 'NTU' ? `${turb.toFixed(1)} NTU` : `${Math.round(turb)} ADC`;
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
    render('rangeTurb', stats.turbidity, turbidityUnit === 'NTU' ? 1 : 0, turbidityUnit === 'NTU' ? ' NTU' : ' ADC');
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

// --- 15-MINUTE HISTORY GRAPH ---
// Data source is the Google Sheet, read back through the backend's /history endpoint
// (which filters to the last 15 minutes). Kept separate from the live WebSocket feed.
let historyChart;

function numOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function ensureHistoryChart() {
    if (historyChart) return historyChart;
    const canvas = document.getElementById('historyChart');
    if (!canvas || typeof Chart === 'undefined') return null;
    historyChart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Temp (°C)', data: [], borderColor: '#0d9488', yAxisID: 'yTemp', tension: 0.3, pointRadius: 0, borderWidth: 2 },
                { label: 'Turbidity (ADC)', data: [], borderColor: '#f59e0b', yAxisID: 'yTurb', tension: 0.3, pointRadius: 0, borderWidth: 2 },
                { label: 'TDS (ppm)', data: [], borderColor: '#6366f1', yAxisID: 'yTds', tension: 0.3, pointRadius: 0, borderWidth: 2 },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 } },
                yTemp: { position: 'left', title: { display: true, text: '°C' } },
                yTurb: { position: 'right', title: { display: true, text: 'ADC' }, grid: { drawOnChartArea: false } },
                yTds: { display: false },
            },
        },
    });
    return historyChart;
}

async function loadHistory() {
    try {
        const resp = await fetch('/history');
        if (!resp.ok) return;
        const data = await resp.json();
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const chart = ensureHistoryChart();
        if (!chart) return;
        chart.data.labels = rows.map(r =>
            new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        chart.data.datasets[0].data = rows.map(r => numOrNull(r.temperature));
        chart.data.datasets[1].data = rows.map(r => numOrNull(r.turbidity));
        chart.data.datasets[2].data = rows.map(r => numOrNull(r.tds));
        chart.update();
    } catch (e) {
        console.error('Failed to load 15-min history', e);
    }
}

// Initialize connection on dashboard launch
connectWebSocket();

// Pull the last 15 minutes from the sheet now, then refresh periodically.
loadHistory();
setInterval(loadHistory, 30000);
