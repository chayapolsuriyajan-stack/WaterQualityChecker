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
// Matches the React SPA's backoff so both dashboards recover at the same rate.
const RECONNECT_DELAY_MS = 3000;
let reconnectTimer = null;

// The dashboard never fabricates readings. When the socket is down the last real
// values stay on screen (or the empty state, if nothing ever arrived) and this
// indicator is the only thing that changes -- so "stale" is always visible.
function setConnectionStatus(state) {
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    if (!dot || !text) return;
    const styles = {
        connected: ['bg-emerald-500', 'Connected'],
        connecting: ['bg-amber-400', 'Connecting…'],
        disconnected: ['bg-red-500', 'Disconnected'],
    };
    const [color, label] = styles[state] || styles.connecting;
    dot.className = `w-2.5 h-2.5 rounded-full ${color}`;
    text.innerText = label;
}

function scheduleReconnect() {
    if (reconnectTimer) return; // a retry is already pending
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
    }, RECONNECT_DELAY_MS);
}

function connectWebSocket() {
    setConnectionStatus('connecting');
    socket = new WebSocket(espWebSocketUrl);

    socket.onopen = () => {
        setConnectionStatus('connected');
    };

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
        setConnectionStatus('disconnected');
        scheduleReconnect();
    };

    socket.onerror = () => {
        setConnectionStatus('disconnected');
        // onerror is normally followed by onclose, which schedules the retry; this
        // covers the case where it isn't (and scheduleReconnect de-dupes anyway).
        scheduleReconnect();
    };
}

// --- UI RENDERING ---
// Only three values are real: temperature, turbidity, TDS. Everything else that used
// to sit on this dashboard (WQI score, dissolved oxygen, pH, pollutant sources) was
// hardcoded with no sensor behind it and has been removed rather than faked.

// Swaps a value element out of its muted "No record yet" empty state.
function setValue(elementId, text) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerText = text;
    el.classList.remove('text-gray-300');
    el.classList.add('text-teal-700');
}

function updateDashboard(temp, turb, tds) {
    setValue('paramTemp', `${temp.toFixed(1)} °C`);
    // Turbidity shows calibrated NTU when the backend has a calibration, else raw ADC.
    setValue('paramTurb', turbidityUnit === 'NTU' ? `${turb.toFixed(1)} NTU` : `${Math.round(turb)} ADC`);
    setValue('paramTds', `${Math.round(tds)} ppm`);

    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const stamp = document.getElementById('lastUpdated');
    if (stamp) {
        stamp.innerText = `Last updated: ${timeNow}`;
        stamp.classList.remove('text-gray-400');
        stamp.classList.add('text-gray-500');
    }
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

// Covers the canvas with an explicit message instead of leaving an empty axis frame
// (which reads as a broken chart). Passing null hides the overlay.
function setHistoryMessage(message) {
    const overlay = document.getElementById('historyEmpty');
    if (!overlay) return;
    if (message) {
        overlay.innerText = message;
        overlay.classList.remove('hidden');
    } else {
        overlay.classList.add('hidden');
    }
}

async function loadHistory() {
    const win = currentHistoryWindow();
    try {
        const resp = await fetch('/history?window=' + encodeURIComponent(win));
        if (!resp.ok) {
            setHistoryMessage(`History unavailable (HTTP ${resp.status})`);
            return;
        }
        const data = await resp.json();
        const rows = Array.isArray(data.rows) ? data.rows : [];
        const chart = ensureHistoryChart();
        if (!chart) return;
        chart.data.labels = rows.map(r => historyLabel(r.timestamp, win));
        chart.data.datasets[0].data = rows.map(r => numOrNull(r.temperature));
        chart.data.datasets[1].data = rows.map(r => numOrNull(r.turbidity));
        chart.data.datasets[2].data = rows.map(r => numOrNull(r.tds));
        chart.update();
        // /history answers 200 with {"rows": []} when there is nothing to show, and may
        // add an "error" field (e.g. the Google Sheets webhook is unreachable). Both used
        // to be swallowed silently, leaving a blank chart with no explanation.
        if (rows.length === 0) {
            setHistoryMessage(data.error ? `History unavailable: ${data.error}` : 'No record yet');
        } else {
            setHistoryMessage(null);
        }
    } catch (e) {
        console.error('Failed to load history', e);
        setHistoryMessage('History unavailable (network error)');
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
