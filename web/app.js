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
                // Live short-window graph tracks the sensor in real time (served from the
                // backend's in-memory buffer, so this fetch is cheap and same-origin).
                if (LIVE_HISTORY_WINDOWS.has(currentHistoryWindow())) loadHistory();
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
            plugins: {
                // Legend names each colored line so the graph is readable at a glance.
                legend: { display: true, position: 'top', labels: { boxWidth: 12, usePointStyle: true, font: { size: 11 } } },
            },
            scales: {
                x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 } },
                // Left axis: numeric ticks WITH units + horizontal gridlines, colored to match
                // the temperature line so you can read values off the left side.
                yTemp: {
                    position: 'left',
                    title: { display: true, text: '°C', color: '#0d9488' },
                    ticks: { color: '#0d9488', callback: (v) => v + '°' },
                    grid: { display: true, color: '#e5e7eb' },
                },
                // Right axis: turbidity ADC numbers in the line's amber; no chart-area grid so
                // the two axes' gridlines don't overlap (Chart.js multi-axis guidance).
                yTurb: {
                    position: 'right',
                    title: { display: true, text: 'ADC', color: '#f59e0b' },
                    ticks: { color: '#f59e0b', callback: (v) => Math.round(v) },
                    grid: { drawOnChartArea: false },
                },
                // TDS stays on a hidden auto-scaling axis; its value is still in the legend + tooltip.
                yTds: { display: false },
            },
        },
    });
    return historyChart;
}

// Currently selected history window, driven by the click-to-open popover on the
// History card (see wireHistoryWindowMenu below) rather than a persistent control.
let historyWindow = '15m';
const HISTORY_WINDOW_LABELS = {
    '5m': 'Last 5 min', '15m': 'Last 15 min', '1h': 'Last 1 hour',
    '3h': 'Last 3 hours', '12h': 'Last 12 hours', '24h': 'Last 24 hours',
};
// Windows the backend serves live from its in-memory buffer -- refresh the graph on every
// reading for these so it tracks the sensor in real time (the rest poll the sheet on a timer).
const LIVE_HISTORY_WINDOWS = new Set(['5m', '15m', '1h']);

function currentHistoryWindow() {
    return historyWindow;
}

// X-axis label granularity adapts to the window: seconds for short windows, date+time for long.
function historyLabel(ts, win) {
    const d = new Date(ts);
    if (win === '12h' || win === '24h') {
        return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    if (win === '5m' || win === '15m') {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); // 1h, 3h
}

async function loadHistory() {
    const win = currentHistoryWindow();
    try {
        const resp = await fetch('/history?window=' + encodeURIComponent(win));
        if (!resp.ok) return;
        const data = await resp.json();
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const chart = ensureHistoryChart();
        if (!chart) return;
        chart.data.labels = rows.map(r => historyLabel(r.timestamp, win));
        chart.data.datasets[0].data = rows.map(r => numOrNull(r.temperature));
        chart.data.datasets[1].data = rows.map(r => numOrNull(r.turbidity));
        chart.data.datasets[2].data = rows.map(r => numOrNull(r.tds));
        chart.update();
    } catch (e) {
        console.error('Failed to load history', e);
    }
}

// Click the History card to reveal a popover of time-range options; picking one sets
// historyWindow, updates the label, closes the popover, and reloads the graph.
function wireHistoryWindowMenu() {
    const card = document.getElementById('historyCard');
    const menu = document.getElementById('historyWindowMenu');
    const label = document.getElementById('historyWindowLabel');
    if (!card || !menu || !label) return;

    const closeMenu = () => menu.classList.add('hidden');
    const openMenu = () => menu.classList.remove('hidden');

    card.addEventListener('click', (e) => {
        // Ignore clicks that originated inside the popover itself (handled below).
        if (menu.contains(e.target)) return;
        menu.classList.toggle('hidden');
    });

    menu.addEventListener('click', (e) => {
        e.stopPropagation(); // don't let this bubble to the card handler and re-toggle
        const btn = e.target.closest('button[data-window]');
        if (!btn) return;
        historyWindow = btn.dataset.window;
        label.textContent = (HISTORY_WINDOW_LABELS[historyWindow] || historyWindow) + ' ▾';
        closeMenu();
        loadHistory();
    });

    // Click anywhere outside the card closes the popover.
    document.addEventListener('click', (e) => {
        if (!card.contains(e.target)) closeMenu();
    });
}

// Initialize connection on dashboard launch
connectWebSocket();

// Pull history now, wire the click-to-open range picker, and refresh periodically.
wireHistoryWindowMenu();
loadHistory();
setInterval(loadHistory, 30000);
