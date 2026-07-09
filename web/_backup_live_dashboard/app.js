// --- 1. SET UP THE GRAPH ---
const ctx = document.getElementById('telemetryChart').getContext('2d');
const maxDataPoints = 25; 

const chart = new Chart(ctx, {
    type: 'line',
    data: {
        labels: [], 
        datasets: [
            {
                label: 'Temperature (°C)',
                borderColor: '#0ea5e9',
                backgroundColor: 'rgba(14, 165, 233, 0.04)',
                borderWidth: 3,
                pointRadius: 2,
                data: [],
                yAxisID: 'y-temp',
                tension: 0.35,
                fill: true
            },
            {
                label: 'Turbidity (NTU)',
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.04)',
                borderWidth: 3,
                pointRadius: 2,
                data: [],
                yAxisID: 'y-turb',
                tension: 0.35,
                fill: true
            },
            {
                label: 'TDS (ppm)',
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.04)',
                borderWidth: 3,
                pointRadius: 2,
                data: [],
                yAxisID: 'y-tds',
                tension: 0.35,
                fill: true
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                grid: { display: false },
                ticks: { color: '#64748b', font: { family: 'Inter' } }
            },
            'y-temp': {
                type: 'linear',
                position: 'left',
                grid: { color: '#f1f5f9' },
                ticks: { color: '#64748b' },
                title: { display: true, text: 'Temperature (°C)', color: '#0ea5e9', font: { weight: 'bold' } }
            },
            'y-turb': {
                type: 'linear',
                position: 'right',
                grid: { display: false },
                ticks: { color: '#64748b' },
                title: { display: true, text: 'Turbidity (NTU)', color: '#f59e0b', font: { weight: 'bold' } }
            },
            'y-tds': {
                type: 'linear',
                position: 'right',
                display: false
            }
        },
        plugins: {
            legend: {
                position: 'top',
                labels: { boxWidth: 12, font: { family: 'Inter', weight: 500 }, color: '#334155' }
            }
        }
    }
});

// --- 2. WEBSOCKET PIPELINE ---

const espWebSocketUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:8080/ws/app`;
let socket;

function connectWebSocket() {
    socket = new WebSocket(espWebSocketUrl);

    socket.onopen = () => {
        document.getElementById('statusDot').style.backgroundColor = '#10b981';
        document.getElementById('statusDot').style.boxShadow = '0 0 0 3px rgba(16, 185, 129, 0.15)';
        document.getElementById('statusText').innerText = "Live Connected";
    };

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
        document.getElementById('statusDot').style.backgroundColor = '#ef4444';
        document.getElementById('statusDot').style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.15)';
        document.getElementById('statusText').innerText = "Disconnected (Simulating)";
        startSimulation(); 
    };
}

// --- 3. UI RENDERING AND SHIFTING ---
function updateDashboard(temp, turb, tds) {
    const timeNow = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    document.getElementById('tempValue').innerText = `${temp.toFixed(1)} °C`;
    document.getElementById('turbValue').innerText = `${Math.round(turb)} NTU`;
    document.getElementById('tdsValue').innerText = `${Math.round(tds)} ppm`;

    chart.data.labels.push(timeNow);
    chart.data.datasets[0].data.push(temp);
    chart.data.datasets[1].data.push(turb);
    chart.data.datasets[2].data.push(tds);

    if (chart.data.labels.length > maxDataPoints) {
        chart.data.labels.shift();
        chart.data.datasets[0].data.shift();
        chart.data.datasets[1].data.shift();
        chart.data.datasets[2].data.shift();
    }
    chart.update();
}

// --- 4. DATA GENERATOR FALLBACK ---
let simInterval;
function startSimulation() {
    if(simInterval) clearInterval(simInterval);
    simInterval = setInterval(() => {
        const mockTemp = 23 + Math.random() * 2;
        const mockTurb = 120 + Math.random() * 40;
        const mockTds = 300 + Math.random() * 100;
        updateDashboard(mockTemp, mockTurb, mockTds);
    }, 2000);
}

// Initialize connection on dashboard launch
connectWebSocket();