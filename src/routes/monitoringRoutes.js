/**
 * @module monitoringRoutes
 * @description HTTP routes for health checks, metrics, alerts, and the monitoring dashboard.
 *
 * Routes:
 *   GET /health                   - Simple health check (for load balancers)
 *   GET /health/detailed          - Detailed health with all metrics
 *   GET /api/v1/monitoring/metrics - Current metrics snapshot
 *   GET /api/v1/monitoring/history - Time-series metrics history
 *   GET /api/v1/monitoring/alerts  - Active alerts and history
 *   GET /api/v1/monitoring/ecg-quality - ECG signal quality metrics
 *   GET /monitoring               - Monitoring dashboard (HTML)
 */

'use strict';

const os = require('os');
const mongoose = require('mongoose');
const metricsCollector = require('../services/metricsCollector');
const alertManager = require('../services/alertManager');
const { getActiveSessions } = require('../services/sessionManager');
const logger = require('../utils/logger');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseQuery(reqUrl) {
  const url = new URL(reqUrl, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

// ─── Route Handler ───────────────────────────────────────────────────────────

/**
 * Main route dispatcher for monitoring endpoints.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {boolean} true if handled
 */
function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method !== 'GET') return false;

  try {
    // ── Health checks ───────────────────────────────────────────────────
    if (pathname === '/health') {
      return handleHealthCheck(req, res);
    }
    if (pathname === '/health/detailed') {
      return handleDetailedHealthCheck(req, res);
    }

    // ── Monitoring API ──────────────────────────────────────────────────
    if (pathname === '/api/v1/monitoring/metrics') {
      return handleMetrics(req, res);
    }
    if (pathname === '/api/v1/monitoring/history') {
      return handleHistory(req, res);
    }
    if (pathname === '/api/v1/monitoring/alerts') {
      return handleAlerts(req, res);
    }
    if (pathname === '/api/v1/monitoring/ecg-quality') {
      return handleECGQuality(req, res);
    }

    // ── Dashboard ───────────────────────────────────────────────────────
    if (pathname === '/monitoring') {
      return handleDashboard(req, res);
    }

    return false;
  } catch (err) {
    logger.error('Monitoring route error', { pathname, error: err.message });
    sendJSON(res, 500, { error: 'Internal server error' });
    return true;
  }
}

// ─── Health Check Handlers ───────────────────────────────────────────────────

function handleHealthCheck(req, res) {
  const mongoReady = mongoose.connection.readyState === 1;
  const status = mongoReady ? 200 : 503;

  sendJSON(res, status, {
    status: mongoReady ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
  return true;
}

function handleDetailedHealthCheck(req, res) {
  const mongoState = mongoose.connection.readyState;
  const mongoReady = mongoState === 1;
  const snapshot = metricsCollector.getSnapshot();
  const activeAlerts = alertManager.getActiveAlerts();
  const activeSessions = getActiveSessions();

  // Evaluate alerts on each detailed health check
  alertManager.evaluate(snapshot, { mongoState });

  // Determine overall status
  let overallStatus = 'healthy';
  if (!mongoReady) {
    overallStatus = 'critical';
  } else if (activeAlerts.some(a => a.level === 'CRITICAL')) {
    overallStatus = 'critical';
  } else if (activeAlerts.some(a => a.level === 'WARNING')) {
    overallStatus = 'degraded';
  }

  const statusCode = overallStatus === 'critical' ? 503 : 200;

  sendJSON(res, statusCode, {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: '2.1.0',

    // Component health
    components: {
      mongodb: {
        status: mongoReady ? 'healthy' : 'disconnected',
        readyState: mongoState,
        readyStateText: ['disconnected', 'connected', 'connecting', 'disconnecting'][mongoState] || 'unknown',
      },
      websocket: {
        status: 'healthy',
        connections: snapshot.connections.current,
        peakConnections: snapshot.connections.peak,
      },
      ecgPipeline: {
        status: snapshot.ecgQuality.packetLossRate < 5 ? 'healthy' : 'degraded',
        packetLossRate: snapshot.ecgQuality.packetLossRate,
        totalPackets: snapshot.ecgQuality.totalPackets,
        activeDevices: Object.keys(snapshot.ecgQuality.devices).length,
      },
    },

    // Summary metrics
    metrics: {
      uptime: Math.round(process.uptime()),
      connections: snapshot.connections,
      messages: {
        received: snapshot.messages.received,
        processed: snapshot.messages.processed,
        errors: snapshot.messages.errors,
      },
      latency: snapshot.latency,
      system: snapshot.system,
    },

    // Active alerts
    alerts: {
      active: activeAlerts,
      count: activeAlerts.length,
      criticalCount: activeAlerts.filter(a => a.level === 'CRITICAL').length,
    },

    // ECG sessions
    sessions: {
      active: activeSessions.length,
      details: activeSessions.map(s => ({
        sessionId: s.sessionId,
        deviceId: s.deviceId,
        channels: s.channelsRecorded,
        totalSamples: s.totalSamples,
      })),
    },

    // Server info
    server: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      startedAt: snapshot.timestamp,
    },
  });
  return true;
}

// ─── Metrics API Handlers ────────────────────────────────────────────────────

function handleMetrics(req, res) {
  const snapshot = metricsCollector.getSnapshot();
  sendJSON(res, 200, { data: snapshot });
  return true;
}

function handleHistory(req, res) {
  const query = parseQuery(req.url);
  const count = parseInt(query.count, 10) || 60;
  const history = metricsCollector.getHistory(count);
  sendJSON(res, 200, {
    data: history,
    count: history.length,
    intervalMs: parseInt(process.env.METRICS_SNAPSHOT_INTERVAL_MS, 10) || 10000,
  });
  return true;
}

function handleAlerts(req, res) {
  const query = parseQuery(req.url);
  const historyCount = parseInt(query.history, 10) || 50;

  sendJSON(res, 200, {
    active: alertManager.getActiveAlerts(),
    history: alertManager.getAlertHistory(historyCount),
    thresholds: alertManager.getThresholds(),
  });
  return true;
}

function handleECGQuality(req, res) {
  const snapshot = metricsCollector.getSnapshot();
  sendJSON(res, 200, {
    data: {
      summary: {
        totalPackets: snapshot.ecgQuality.totalPackets,
        droppedPackets: snapshot.ecgQuality.droppedPackets,
        outOfOrderPackets: snapshot.ecgQuality.outOfOrderPackets,
        duplicatePackets: snapshot.ecgQuality.duplicatePackets,
        packetLossRate: snapshot.ecgQuality.packetLossRate,
        avgSamplesPerPacket: snapshot.ecgQuality.avgSamplesPerPacket,
      },
      devices: snapshot.ecgQuality.devices,
    },
  });
  return true;
}

// ─── Dashboard HTML ──────────────────────────────────────────────────────────

function handleDashboard(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getDashboardHTML());
  return true;
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Horizon Medical — Monitoring Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
    .header { background: linear-gradient(135deg, #1e3a5f, #0f172a); padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #1e40af; }
    .header h1 { font-size: 1.4em; color: #60a5fa; }
    .header .status-badge { padding: 6px 16px; border-radius: 20px; font-weight: 600; font-size: 0.85em; }
    .status-healthy { background: #065f46; color: #34d399; }
    .status-degraded { background: #78350f; color: #fbbf24; }
    .status-critical { background: #7f1d1d; color: #f87171; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; }
    .card h3 { color: #94a3b8; font-size: 0.8em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
    .metric-value { font-size: 2em; font-weight: 700; color: #f8fafc; }
    .metric-unit { font-size: 0.5em; color: #64748b; margin-left: 4px; }
    .metric-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #334155; }
    .metric-row:last-child { border: none; }
    .metric-label { color: #94a3b8; font-size: 0.9em; }
    .metric-val { color: #e2e8f0; font-weight: 500; }
    .chart-container { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; margin-bottom: 20px; }
    .chart-container h3 { color: #94a3b8; font-size: 0.8em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    canvas { width: 100% !important; height: 200px !important; }
    .alerts-panel { background: #1e293b; border-radius: 12px; padding: 20px; border: 1px solid #334155; margin-bottom: 20px; }
    .alerts-panel h3 { color: #94a3b8; font-size: 0.8em; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
    .alert-item { padding: 10px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
    .alert-critical { background: rgba(239, 68, 68, 0.15); border-left: 3px solid #ef4444; }
    .alert-warning { background: rgba(245, 158, 11, 0.15); border-left: 3px solid #f59e0b; }
    .alert-resolved { background: rgba(52, 211, 153, 0.12); border-left: 3px solid #34d399; }
    .alert-info { background: rgba(96, 165, 250, 0.12); border-left: 3px solid #60a5fa; }
    .device-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    .device-table th { text-align: left; padding: 8px; color: #94a3b8; font-size: 0.8em; text-transform: uppercase; border-bottom: 1px solid #334155; }
    .device-table td { padding: 8px; font-size: 0.9em; border-bottom: 1px solid #1e293b; }
    .snr-good { color: #34d399; }
    .snr-warn { color: #fbbf24; }
    .snr-bad { color: #f87171; }
    .footer { text-align: center; padding: 20px; color: #475569; font-size: 0.8em; }
    .refresh-info { color: #475569; font-size: 0.8em; }
    .no-alerts { color: #64748b; font-style: italic; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>🏥 Horizon Medical — System Monitor</h1>
      <span class="refresh-info">Auto-refresh: 5s | <span id="lastUpdate">—</span></span>
    </div>
    <span id="statusBadge" class="status-badge status-healthy">HEALTHY</span>
  </div>

  <div class="container">
    <!-- KPI Cards -->
    <div class="grid" id="kpiGrid">
      <div class="card">
        <h3>Conexiones Activas</h3>
        <div class="metric-value"><span id="connActive">0</span></div>
        <div class="metric-row"><span class="metric-label">Pico</span><span class="metric-val" id="connPeak">0</span></div>
        <div class="metric-row"><span class="metric-label">Total histórico</span><span class="metric-val" id="connTotal">0</span></div>
        <div class="metric-row"><span class="metric-label">Rechazadas</span><span class="metric-val" id="connRejected">0</span></div>
      </div>
      <div class="card">
        <h3>Mensajes</h3>
        <div class="metric-value"><span id="msgReceived">0</span></div>
        <div class="metric-row"><span class="metric-label">Procesados</span><span class="metric-val" id="msgProcessed">0</span></div>
        <div class="metric-row"><span class="metric-label">Errores</span><span class="metric-val" id="msgErrors">0</span></div>
        <div class="metric-row"><span class="metric-label">Rate-limited</span><span class="metric-val" id="msgRateLimited">0</span></div>
      </div>
      <div class="card">
        <h3>Latencia (ms)</h3>
        <div class="metric-value"><span id="latAvg">0</span><span class="metric-unit">ms avg</span></div>
        <div class="metric-row"><span class="metric-label">Mínima</span><span class="metric-val" id="latMin">0ms</span></div>
        <div class="metric-row"><span class="metric-label">P95</span><span class="metric-val" id="latP95">0ms</span></div>
        <div class="metric-row"><span class="metric-label">P99</span><span class="metric-val" id="latP99">0ms</span></div>
      </div>
      <div class="card">
        <h3>Sistema</h3>
        <div class="metric-value"><span id="cpuUsage">0</span><span class="metric-unit">% CPU</span></div>
        <div class="metric-row"><span class="metric-label">Memoria</span><span class="metric-val" id="memUsage">0%</span></div>
        <div class="metric-row"><span class="metric-label">Heap</span><span class="metric-val" id="heapUsed">0 MB</span></div>
        <div class="metric-row"><span class="metric-label">Event Loop Lag</span><span class="metric-val" id="evLoopLag">0ms</span></div>
      </div>
      <div class="card">
        <h3>Calidad ECG</h3>
        <div class="metric-value"><span id="ecgPackets">0</span><span class="metric-unit">paquetes</span></div>
        <div class="metric-row"><span class="metric-label">Pérdida paquetes</span><span class="metric-val" id="ecgLoss">0%</span></div>
        <div class="metric-row"><span class="metric-label">Fuera de orden</span><span class="metric-val" id="ecgOOO">0</span></div>
        <div class="metric-row"><span class="metric-label">Dispositivos activos</span><span class="metric-val" id="ecgDevices">0</span></div>
      </div>
      <div class="card">
        <h3>Uptime</h3>
        <div class="metric-value"><span id="uptime">0s</span></div>
        <div class="metric-row"><span class="metric-label">MongoDB</span><span class="metric-val" id="mongoStatus">—</span></div>
        <div class="metric-row"><span class="metric-label">Sesiones activas</span><span class="metric-val" id="activeSessions">0</span></div>
        <div class="metric-row"><span class="metric-label">Errores totales</span><span class="metric-val" id="totalErrors">0</span></div>
      </div>
    </div>

    <!-- Charts -->
    <div class="chart-container">
      <h3>📈 Conexiones y Mensajes (últimos 60 snapshots)</h3>
      <canvas id="chartConnMsg"></canvas>
    </div>
    <div class="chart-container">
      <h3>📊 CPU, Memoria & Event Loop Lag</h3>
      <canvas id="chartSystem"></canvas>
    </div>

    <!-- Alerts -->
    <div class="alerts-panel">
      <h3>🚨 Alertas Activas</h3>
      <div id="alertsActive"><p class="no-alerts">No hay alertas activas</p></div>
    </div>
    <div class="alerts-panel">
      <h3>📋 Historial de Alertas (últimas 20)</h3>
      <div id="alertsHistory"><p class="no-alerts">Sin historial</p></div>
    </div>

    <!-- ECG Device Table -->
    <div class="alerts-panel">
      <h3>📡 Dispositivos ECG</h3>
      <table class="device-table">
        <thead>
          <tr><th>Dispositivo</th><th>Canal</th><th>Paquetes</th><th>Perdidos</th><th>SNR (dB)</th><th>Última actividad</th></tr>
        </thead>
        <tbody id="deviceTableBody">
          <tr><td colspan="6" style="color: #64748b; font-style: italic;">Sin dispositivos conectados</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="footer">Horizon Medical WSS v2.1.0 — Monitoring Dashboard</div>

  <script>
    // Minimal chart drawing using canvas
    function drawChart(canvasId, datasets, labels) {
      const canvas = document.getElementById(canvasId);
      const ctx = canvas.getContext('2d');
      const w = canvas.width = canvas.offsetWidth;
      const h = canvas.height = 200;
      ctx.clearRect(0, 0, w, h);

      if (!labels || labels.length < 2) { ctx.fillStyle='#475569'; ctx.fillText('Esperando datos...', w/2-50, h/2); return; }

      const padL=50, padR=10, padT=10, padB=25;
      const chartW = w-padL-padR, chartH = h-padT-padB;

      // Find global max
      let maxVal = 1;
      datasets.forEach(ds => { ds.data.forEach(v => { if(v>maxVal) maxVal=v; }); });
      maxVal = maxVal * 1.1;

      // Grid
      ctx.strokeStyle='#334155'; ctx.lineWidth=0.5;
      for(let i=0;i<=4;i++){
        const y=padT+chartH*(i/4);
        ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(w-padR,y); ctx.stroke();
        ctx.fillStyle='#64748b'; ctx.font='10px sans-serif'; ctx.textAlign='right';
        ctx.fillText(Math.round(maxVal*(1-i/4)),padL-5,y+4);
      }

      // Draw lines
      datasets.forEach(ds => {
        ctx.strokeStyle=ds.color; ctx.lineWidth=2; ctx.beginPath();
        ds.data.forEach((v,i) => {
          const x = padL + (i/(labels.length-1))*chartW;
          const y = padT + chartH*(1-v/maxVal);
          i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
        });
        ctx.stroke();
      });

      // Legend
      let lx = padL;
      datasets.forEach(ds => {
        ctx.fillStyle=ds.color; ctx.fillRect(lx,h-12,10,10);
        ctx.fillStyle='#94a3b8'; ctx.font='10px sans-serif'; ctx.textAlign='left';
        ctx.fillText(ds.label,lx+14,h-3); lx+=ctx.measureText(ds.label).width+30;
      });
    }

    function formatUptime(secs) {
      const d=Math.floor(secs/86400), h=Math.floor((secs%86400)/3600), m=Math.floor((secs%3600)/60), s=Math.floor(secs%60);
      if(d>0) return d+'d '+h+'h '+m+'m';
      if(h>0) return h+'h '+m+'m '+s+'s';
      if(m>0) return m+'m '+s+'s';
      return s+'s';
    }

    function formatBytes(b) { if(b>1073741824) return (b/1073741824).toFixed(1)+' GB'; if(b>1048576) return (b/1048576).toFixed(1)+' MB'; return (b/1024).toFixed(0)+' KB'; }

    function snrClass(v) { if(v===null) return ''; if(v>=20) return 'snr-good'; if(v>=10) return 'snr-warn'; return 'snr-bad'; }

    async function fetchData(url) { try { const r=await fetch(url); return await r.json(); } catch(e) { return null; } }

    let historyData = [];

    async function refresh() {
      const [detailed, history, alerts] = await Promise.all([
        fetchData('/health/detailed'),
        fetchData('/api/v1/monitoring/history?count=60'),
        fetchData('/api/v1/monitoring/alerts?history=20'),
      ]);

      if(!detailed) return;

      // Status badge
      const badge = document.getElementById('statusBadge');
      badge.textContent = detailed.status.toUpperCase();
      badge.className = 'status-badge status-' + detailed.status;

      // KPIs
      const m = detailed.metrics;
      document.getElementById('connActive').textContent = m.connections.current;
      document.getElementById('connPeak').textContent = m.connections.peak;
      document.getElementById('connTotal').textContent = m.connections.total;
      document.getElementById('connRejected').textContent = m.connections.rejected;
      document.getElementById('msgReceived').textContent = m.messages.received;
      document.getElementById('msgProcessed').textContent = m.messages.processed;
      document.getElementById('msgErrors').textContent = m.messages.errors;
      document.getElementById('msgRateLimited').textContent = m.messages?.rateLimited || 0;
      document.getElementById('latAvg').textContent = m.latency.avg;
      document.getElementById('latMin').textContent = m.latency.min+'ms';
      document.getElementById('latP95').textContent = m.latency.p95+'ms';
      document.getElementById('latP99').textContent = m.latency.p99+'ms';
      document.getElementById('cpuUsage').textContent = m.system.cpuUsage;
      document.getElementById('memUsage').textContent = m.system.memoryUsage+'%';
      document.getElementById('heapUsed').textContent = formatBytes(m.system.heapUsed);
      document.getElementById('evLoopLag').textContent = m.system.eventLoopLag+'ms';
      document.getElementById('uptime').textContent = formatUptime(m.uptime);
      document.getElementById('mongoStatus').textContent = detailed.components.mongodb.readyStateText;
      document.getElementById('mongoStatus').style.color = detailed.components.mongodb.status==='healthy' ? '#34d399' : '#f87171';
      document.getElementById('activeSessions').textContent = detailed.sessions.active;
      document.getElementById('totalErrors').textContent = detailed.alerts.count>0 ? detailed.alerts.count+' alertas' : '0';

      // ECG Quality
      const ecg = detailed.components.ecgPipeline;
      document.getElementById('ecgPackets').textContent = ecg.totalPackets;
      document.getElementById('ecgLoss').textContent = ecg.packetLossRate+'%';
      document.getElementById('ecgOOO').textContent = '—';
      document.getElementById('ecgDevices').textContent = ecg.activeDevices;

      document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

      // Charts
      if(history && history.data && history.data.length>1) {
        historyData = history.data;
        const labels = historyData.map(h => new Date(h.timestamp).toLocaleTimeString());
        drawChart('chartConnMsg', [
          { label:'Conexiones', color:'#60a5fa', data:historyData.map(h=>h.connections||0) },
          { label:'Mensajes', color:'#34d399', data:historyData.map(h=>h.messagesReceived||0) },
          { label:'Errores', color:'#f87171', data:historyData.map(h=>h.errors||0) },
        ], labels);
        drawChart('chartSystem', [
          { label:'CPU %', color:'#fbbf24', data:historyData.map(h=>h.cpuUsage||0) },
          { label:'Memoria %', color:'#a78bfa', data:historyData.map(h=>h.memoryUsage||0) },
          { label:'EL Lag ms', color:'#f87171', data:historyData.map(h=>h.eventLoopLag||0) },
        ], labels);
      }

      // Alerts
      if(alerts) {
        const activeDiv = document.getElementById('alertsActive');
        if(alerts.active && alerts.active.length > 0) {
          activeDiv.innerHTML = alerts.active.map(a => \`
            <div class="alert-item alert-\${a.level.toLowerCase()}">
              <div><strong>\${a.ruleId}</strong> — \${a.message}</div>
              <div style="font-size:0.8em;color:#94a3b8">x\${a.count}</div>
            </div>\`).join('');
        } else {
          activeDiv.innerHTML = '<p class="no-alerts">✅ No hay alertas activas</p>';
        }

        const histDiv = document.getElementById('alertsHistory');
        if(alerts.history && alerts.history.length > 0) {
          histDiv.innerHTML = alerts.history.slice(-20).reverse().map(a => \`
            <div class="alert-item alert-\${(a.level||'info').toLowerCase()}">
              <div><strong>\${a.ruleId}</strong> — \${a.message}</div>
              <div style="font-size:0.8em;color:#94a3b8">\${new Date(a.timestamp).toLocaleTimeString()} [\${a.action}]</div>
            </div>\`).join('');
        } else {
          histDiv.innerHTML = '<p class="no-alerts">Sin historial</p>';
        }
      }

      // ECG Devices table
      const ecqRes = await fetchData('/api/v1/monitoring/ecg-quality');
      if(ecqRes && ecqRes.data && ecqRes.data.devices) {
        const devs = Object.values(ecqRes.data.devices);
        const tbody = document.getElementById('deviceTableBody');
        if(devs.length > 0) {
          tbody.innerHTML = devs.map(d => \`
            <tr>
              <td>\${d.deviceId||'—'}</td>
              <td>\${d.channelId||'—'}</td>
              <td>\${d.totalPackets}</td>
              <td>\${d.droppedPackets}</td>
              <td class="\${snrClass(d.snrEstimateDb)}">\${d.snrEstimateDb !== null ? d.snrEstimateDb : '—'}</td>
              <td>\${d.lastActivityAt ? new Date(d.lastActivityAt).toLocaleTimeString() : '—'}</td>
            </tr>\`).join('');
        } else {
          tbody.innerHTML = '<tr><td colspan="6" style="color:#64748b;font-style:italic;">Sin dispositivos</td></tr>';
        }
      }
    }

    refresh();
    setInterval(refresh, 5000);
    window.addEventListener('resize', () => { if(historyData.length>1) refresh(); });
  </script>
</body>
</html>`;
}

module.exports = { handleRequest };
