const API_CACHE_KEY = "btc-dashboard-cache-v1";
const $ = (id) => document.getElementById(id);

let dashboard = null;

function usd(value, digits = 0) {
  if (!Number.isFinite(value)) return "Sin datos";
  return "$" + value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function saveCache(data) {
  localStorage.setItem(API_CACHE_KEY, JSON.stringify({ updatedAt: Date.now(), data }));
}

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(API_CACHE_KEY)).data;
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getHistory() {
  try {
    const json = await fetchJson("https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=1500");
    const rows = json.Data.Data.map((row) => ({
      date: new Date(row.time * 1000).toISOString().slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close)
    })).filter((row) => row.close > 0);
    if (rows.length) return rows;
  } catch {}

  const json = await fetchJson("https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=max");
  return json.slice(-1500).map((row) => ({
    date: new Date(row[0]).toISOString().slice(0, 10),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4])
  })).filter((row) => row.close > 0);
}

async function getPrice(history) {
  const sources = [
    async () => {
      const json = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", 5000);
      return Number(json.bitcoin.usd);
    },
    async () => {
      const json = await fetchJson("https://api.coinbase.com/v2/prices/BTC-USD/spot", 5000);
      return Number(json.data.amount);
    }
  ];

  for (const source of sources) {
    try {
      const price = await source();
      if (Number.isFinite(price) && price > 0) return price;
    } catch {}
  }
  return history.length ? history[history.length - 1].close : null;
}

async function getCoinMetrics() {
  const metrics = [
    "CapMVRVCur",
    "CapMrktCurUSD",
    "PriceUSD",
    "FlowInExUSD",
    "FlowOutExUSD",
    "HashRate",
    "FeeTotNtv",
    "TxCnt",
    "TxTfrCnt",
    "AdrActCnt",
    "ROI30d",
    "ROI1yr",
    "IssTotUSD"
  ];
  const start = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics"
    + "?assets=btc"
    + "&metrics=" + encodeURIComponent(metrics.join(","))
    + "&frequency=1d"
    + "&start_time=" + start
    + "&page_size=100"
    + "&sort=time"
    + "&ignore_forbidden_errors=true"
    + "&ignore_unsupported_errors=true";

  try {
    const json = await fetchJson(url, 6000);
    const latest = {};
    const series = [];
    for (const row of json.data || []) {
      const cleanRow = { time: row.time };
      for (const key of metrics) {
        const value = Number(row[key]);
        if (Number.isFinite(value)) {
          latest[key] = value;
          cleanRow[key] = value;
        }
      }
      series.push(cleanRow);
    }
    return { latest, series };
  } catch {
    return { latest: {}, series: [] };
  }
}

function avg(rows, count) {
  const slice = rows.slice(Math.max(0, rows.length - count));
  if (!slice.length) return null;
  return slice.reduce((sum, row) => sum + row.close, 0) / slice.length;
}

function avgMetric(rows, key, count) {
  const values = rows
    .slice(Math.max(0, rows.length - count))
    .map((row) => Number(row[key]))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metric(name, value, display, signal, description) {
  return { name, value, display, signal, description };
}

function noData(name) {
  return metric(name, null, "Sin datos", "NEUTRAL", "Dato no disponible");
}

function buildDashboard(price, history, cmData) {
  const cm = cmData.latest || cmData || {};
  const cmSeries = cmData.series || [];
  const ma200 = avg(history, 200);
  const yesterday = history.length > 1 ? history[history.length - 2].close : null;
  const change24h = yesterday ? ((price - yesterday) / yesterday) * 100 : 0;
  const max52w = history.slice(-365).reduce((max, row) => Math.max(max, row.high), price);
  const ratio = ma200 ? price / ma200 : null;
  const realized = cm.CapMVRVCur && price ? price / cm.CapMVRVCur : null;
  const base = realized || (ma200 ? ma200 * 0.75 : null);

  const entryMetrics = [
    mvrv(cm.CapMVRVCur),
    exchangeNetflow(cm),
    activeAddresses(cm, cmSeries),
    mayer(price, ma200),
    drawdown(price, history),
    hashRate(cm, cmSeries)
  ];

  const contextMetrics = [
    feePressure(cm, price),
    txActivity(cm, cmSeries),
    roiMetric("ROI 30D", cm.ROI30d),
    roiMetric("ROI 1Y", cm.ROI1yr),
    maMetric(price, ma200),
    piMetric(history),
    rsiMetric(history)
  ];

  return {
    updatedAt: new Date().toISOString(),
    price,
    ma200,
    ratio,
    change24h,
    max52w,
    zones: zones(price, base, realized),
    halving: halving(),
    entryMetrics,
    contextMetrics,
    signals: evaluate(entryMetrics),
    chart: chart(history)
  };
}

function mvrv(v) {
  if (!Number.isFinite(v)) return noData("MVRV real");
  if (v <= 1.2) return metric("MVRV real", v, v.toFixed(2), "BUY", "Valoracion baja frente al costo realizado");
  if (v <= 1.8) return metric("MVRV real", v, v.toFixed(2), "HOLD", "Zona saludable de acumulacion");
  if (v >= 3.5) return metric("MVRV real", v, v.toFixed(2), "SELL", "Valoracion elevada");
  return metric("MVRV real", v, v.toFixed(2), "NEUTRAL", "Zona neutral");
}

function exchangeNetflow(cm) {
  const inflow = Number(cm.FlowInExUSD);
  const outflow = Number(cm.FlowOutExUSD);
  if (!Number.isFinite(inflow) || !Number.isFinite(outflow)) return noData("Flujo neto exchanges");
  const net = inflow - outflow;
  const display = net >= 0 ? "+" + usd(net) : "-" + usd(Math.abs(net));
  if (net <= -250000000) return metric("Flujo neto exchanges", net, display, "BUY", "Salen fondos de exchanges: sesgo de acumulacion");
  if (net >= 250000000) return metric("Flujo neto exchanges", net, display, "SELL", "Entran fondos a exchanges: posible presion de venta");
  return metric("Flujo neto exchanges", net, display, "NEUTRAL", "Flujo equilibrado");
}

function activeAddresses(cm, series) {
  const value = Number(cm.AdrActCnt);
  const avg30 = avgMetric(series, "AdrActCnt", 30);
  if (!Number.isFinite(value) || !avg30) return noData("Direcciones activas");
  const change = ((value - avg30) / avg30) * 100;
  if (change >= 10) return metric("Direcciones activas", value, value.toLocaleString("en-US"), "BUY", "Actividad on-chain sobre media 30D");
  if (change <= -15) return metric("Direcciones activas", value, value.toLocaleString("en-US"), "SELL", "Actividad on-chain debilitada");
  return metric("Direcciones activas", value, value.toLocaleString("en-US"), "NEUTRAL", "Actividad cerca de media 30D");
}

function hashRate(cm, series) {
  const value = Number(cm.HashRate);
  const avg30 = avgMetric(series, "HashRate", 30);
  if (!Number.isFinite(value) || !avg30) return noData("Hash rate");
  const change = ((value - avg30) / avg30) * 100;
  if (change <= -12) return metric("Hash rate", value, change.toFixed(1) + "% vs 30D", "BUY", "Estres minero: posible capitulacion");
  if (change >= 12) return metric("Hash rate", value, change.toFixed(1) + "% vs 30D", "HOLD", "Seguridad minera fuerte");
  return metric("Hash rate", value, change.toFixed(1) + "% vs 30D", "NEUTRAL", "Hash rate estable");
}

function feePressure(cm, price) {
  const feeBtc = Number(cm.FeeTotNtv);
  if (!Number.isFinite(feeBtc) || !price) return noData("Fees pagadas");
  const feeUsd = feeBtc * price;
  if (feeBtc <= 3) return metric("Fees pagadas", feeBtc, usd(feeUsd), "HOLD", "Baja competencia por bloque");
  if (feeBtc >= 25) return metric("Fees pagadas", feeBtc, usd(feeUsd), "SELL", "Actividad especulativa elevada");
  return metric("Fees pagadas", feeBtc, usd(feeUsd), "NEUTRAL", "Uso de red normal");
}

function txActivity(cm, series) {
  const value = Number(cm.TxCnt);
  const avg30 = avgMetric(series, "TxCnt", 30);
  if (!Number.isFinite(value) || !avg30) return noData("Transacciones");
  const change = ((value - avg30) / avg30) * 100;
  if (change >= 15) return metric("Transacciones", value, value.toLocaleString("en-US"), "BUY", "Uso de red creciendo sobre media 30D");
  if (change <= -20) return metric("Transacciones", value, value.toLocaleString("en-US"), "SELL", "Uso de red debilitado");
  return metric("Transacciones", value, value.toLocaleString("en-US"), "NEUTRAL", "Uso de red estable");
}

function roiMetric(name, value) {
  if (!Number.isFinite(value)) return noData(name);
  if (name === "ROI 30D") {
    if (value <= -20) return metric(name, value, value.toFixed(1) + "%", "BUY", "Caida mensual fuerte");
    if (value >= 30) return metric(name, value, value.toFixed(1) + "%", "SELL", "Subida mensual extendida");
  }
  if (name === "ROI 1Y") {
    if (value <= -35) return metric(name, value, value.toFixed(1) + "%", "BUY", "Retorno anual deprimido");
    if (value >= 120) return metric(name, value, value.toFixed(1) + "%", "SELL", "Retorno anual extendido");
  }
  return metric(name, value, value.toFixed(1) + "%", "NEUTRAL", "Retorno en zona intermedia");
}

function mayer(price, ma200) {
  if (!price || !ma200) return noData("Mayer Multiple");
  const v = price / ma200;
  if (v <= 0.8) return metric("Mayer Multiple", v, v.toFixed(2), "BUY", "Precio muy bajo frente a MA200D");
  if (v <= 1) return metric("Mayer Multiple", v, v.toFixed(2), "HOLD", "Precio cerca o bajo MA200D");
  if (v >= 2.4) return metric("Mayer Multiple", v, v.toFixed(2), "SELL", "Extension riesgosa");
  return metric("Mayer Multiple", v, v.toFixed(2), "NEUTRAL", "Zona neutral");
}

function drawdown(price, rows) {
  if (!price || !rows.length) return noData("Drawdown ATH");
  const ath = rows.reduce((max, row) => Math.max(max, row.high), price);
  const v = ((price - ath) / ath) * 100;
  if (v <= -55) return metric("Drawdown ATH", v, v.toFixed(1) + "%", "BUY", "Caida profunda");
  if (v <= -30) return metric("Drawdown ATH", v, v.toFixed(1) + "%", "HOLD", "Correccion relevante");
  if (v > -10) return metric("Drawdown ATH", v, v.toFixed(1) + "%", "SELL", "Cerca de maximos");
  return metric("Drawdown ATH", v, v.toFixed(1) + "%", "NEUTRAL", "Zona neutral");
}

function maMetric(price, ma200) {
  if (!price || !ma200) return noData("MA 200D");
  const v = price / ma200;
  if (v <= 0.85) return metric("MA 200D", ma200, usd(ma200), "BUY", "Precio bajo MA200D");
  if (v <= 1) return metric("MA 200D", ma200, usd(ma200), "HOLD", "Precio cerca o bajo MA200D");
  if (v >= 1.3) return metric("MA 200D", ma200, usd(ma200), "SELL", "Precio extendido");
  return metric("MA 200D", ma200, usd(ma200), "NEUTRAL", "Zona neutral");
}

function piMetric(rows) {
  if (rows.length < 350) return noData("Pi Cycle Top");
  const ma111 = avg(rows, 111);
  const ma350x2 = avg(rows, 350) * 2;
  const v = ((ma111 - ma350x2) / ma350x2) * 100;
  if (v >= 5) return metric("Pi Cycle Top", v, v.toFixed(1) + "%", "SELL", "Cerca de techo historico");
  if (v >= 0) return metric("Pi Cycle Top", v, v.toFixed(1) + "%", "HOLD", "Zona de precaucion");
  return metric("Pi Cycle Top", v, v.toFixed(1) + "%", "BUY", "Sin cruce de techo");
}

function rsiMetric(rows) {
  if (rows.length < 15) return noData("RSI 14D");
  const slice = rows.slice(-15);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const change = slice[i].close - slice[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  const v = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  if (v <= 30) return metric("RSI 14D", v, v.toFixed(1), "BUY", "Sobreventa");
  if (v >= 70) return metric("RSI 14D", v, v.toFixed(1), "SELL", "Sobrecompra");
  return metric("RSI 14D", v, v.toFixed(1), "NEUTRAL", "Zona neutral");
}

function zones(price, base, realized) {
  if (!base) return { state: "Faltan datos", description: "No hay base suficiente", source: "sin datos", realizedPrice: null, levels: [] };
  const levels = [
    { name: "Compra extrema", price: base, tag: "MVRV ~1.0", type: "extreme", detail: "Capitulacion historica" },
    { name: "Compra fuerte", price: base * 1.25, tag: "MVRV ~1.25", type: "high", detail: "Acumulacion agresiva" },
    { name: "Buena entrada", price: base * 1.5, tag: "MVRV ~1.50", type: "medium", detail: "Compras escalonadas" },
    { name: "Compra parcial", price: base * 1.8, tag: "MVRV ~1.80", type: "low", detail: "DCA con confirmacion" }
  ];
  let state = "Esperar";
  let description = "Precio por encima de la zona principal de acumulacion";
  if (price <= levels[1].price) {
    state = "Compra fuerte";
    description = "Precio dentro de zona on-chain fuerte";
  } else if (price <= levels[2].price) {
    state = "Buena entrada";
    description = "Precio dentro de zona historicamente atractiva";
  } else if (price <= levels[3].price) {
    state = "Compra parcial";
    description = "Zona aceptable para compras escalonadas";
  }
  return { state, description, source: realized ? "MVRV real" : "MA200D local", realizedPrice: realized, levels };
}

function halving() {
  const next = new Date("2028-04-20T00:00:00Z");
  const last = new Date("2024-04-20T00:00:00Z");
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((next - now) / 86400000));
  const progress = Math.min(100, Math.max(0, ((now - last) / (next - last)) * 100));
  return { nextDate: next.toLocaleDateString("es-ES"), daysLeft, blocksLeft: daysLeft * 144, progress };
}

function evaluate(metrics) {
  const valid = metrics.filter((item) => item.display !== "Sin datos");
  const buys = valid.filter((item) => item.signal === "BUY").length;
  const sells = valid.filter((item) => item.signal === "SELL").length;
  let recommendation = "Precaucion";
  let color = "#FFA500";
  if (valid.length < 3) {
    recommendation = "Faltan datos";
    color = "#FFD700";
  } else if (buys >= 4) {
    recommendation = "Compra fuerte";
    color = "#00ff00";
  } else if (buys >= 3) {
    recommendation = "Compra moderada";
    color = "#90EE90";
  } else if (sells >= 3) {
    recommendation = "No comprar";
    color = "#FF6347";
  } else if (buys >= 2) {
    recommendation = "Neutral";
    color = "#FFD700";
  }
  return { buys, sells, total: valid.length, recommendation, color, strength: valid.length ? Math.round((buys / valid.length) * 100) : 0, message: buys + " de " + valid.length + " senales alcistas validas" };
}

function chart(rows) {
  return rows.slice(-365).map((row, index, list) => {
    const source = rows.slice(0, rows.length - list.length + index + 1);
    const ma = avg(source, 200);
    return { date: row.date, close: row.close, ma200: ma, upper: ma ? ma * 1.3 : null, lower: ma ? ma * 0.7 : null };
  });
}

async function loadDashboard() {
  $("statusLine").textContent = "Cargando datos...";
  $("refreshBtn").disabled = true;
  try {
    const history = await getHistory();
    const price = await getPrice(history);
    const cm = await getCoinMetrics();
    dashboard = buildDashboard(price, history, cm);
    saveCache(dashboard);
    render(dashboard);
  } catch (error) {
    const cached = readCache();
    if (cached) {
      dashboard = cached;
      render(cached);
      $("statusLine").textContent = "Mostrando cache local. Sin conexion o API limitada.";
    } else {
      $("statusLine").textContent = "Error: " + error.message;
    }
  } finally {
    $("refreshBtn").disabled = false;
  }
}

function render(data) {
  $("statusLine").textContent = "Actualizado " + new Date(data.updatedAt).toLocaleString();
  $("price").textContent = usd(data.price, 2);
  $("ma200").textContent = usd(data.ma200);
  $("max52w").textContent = usd(data.max52w);
  $("change24h").textContent = (data.change24h >= 0 ? "+" : "") + data.change24h.toFixed(2) + "% (24h)";
  $("change24h").className = data.change24h >= 0 ? "change-positive" : "change-negative";

  if (Number.isFinite(data.ratio)) {
    const color = data.ratio < 0.85 ? "#00ff00" : data.ratio < 1 ? "#FFD700" : data.ratio < 1.3 ? "#FFA500" : "#f44336";
    $("ratio").innerHTML = '<span style="color:' + color + '">Ratio: ' + data.ratio.toFixed(2) + "</span>";
    $("ratioDesc").textContent = data.ratio < 0.85 ? "Muy por debajo de MA200D" : data.ratio < 1 ? "Por debajo de MA200D" : data.ratio < 1.3 ? "Por encima de MA200D" : "Muy por encima de MA200D";
  }

  $("halvingDate").textContent = data.halving.nextDate;
  $("daysLeft").textContent = data.halving.daysLeft.toLocaleString();
  $("blocksLeft").textContent = data.halving.blocksLeft.toLocaleString();
  $("halvingBar").style.width = data.halving.progress.toFixed(1) + "%";
  $("halvingBar").textContent = data.halving.progress.toFixed(1) + "%";

  renderZones(data.zones);
  renderMetrics(data.entryMetrics, data.contextMetrics);
  renderSignal(data.signals);
  renderChart("valueChart", data.chart, ["close", "upper", "ma200", "lower"]);
  renderChart("trendChart", data.chart.slice(-90), ["close"]);
  updateSimulator();
}

function renderZones(data) {
  if (!data.levels.length) {
    $("zones").innerHTML = '<div class="empty">Sin datos suficientes</div>';
    return;
  }
  let html = '<div class="zone-summary"><strong>' + data.state + '</strong><br>' + data.description + '<br>Fuente: ' + data.source + (data.realizedPrice ? '<br>Precio realizado: ' + usd(data.realizedPrice) : '') + '</div>';
  for (const item of data.levels) {
    html += '<div class="level ' + item.type + '"><div><strong>' + item.name + '</strong><small>' + item.tag + ' | ' + item.detail + '</small></div><strong>' + usd(item.price) + '</strong></div>';
  }
  $("zones").innerHTML = html;
}

function renderMetrics(entry, context) {
  $("metrics").innerHTML = metricGroup("Senales de entrada", entry) + metricGroup("Contexto", context);
}

function metricGroup(title, list) {
  let html = '<div class="metric-section">' + title + '</div>';
  for (const item of list) {
    const cls = item.signal === "BUY" ? "buy" : item.signal === "SELL" ? "sell" : item.signal === "HOLD" ? "hold" : "";
    html += '<div class="metric ' + cls + '"><div><b>' + item.name + '</b><span>' + item.description + '</span></div><strong>' + item.display + '</strong></div>';
  }
  return html;
}

function renderSignal(data) {
  $("recommendation").textContent = data.recommendation;
  $("recommendation").style.color = data.color;
  $("strength").textContent = "Fuerza de senal: " + data.strength + "%";
  $("signalMessage").textContent = data.message;
}

function updateSimulator() {
  if (!dashboard || !dashboard.zones.levels.length) {
    $("targetResult").textContent = "Sin zonas";
    return;
  }
  const value = Number($("targetPrice").value);
  const levels = dashboard.zones.levels;
  let result = "Esperar";
  if (value <= levels[1].price) result = "Compra fuerte";
  else if (value <= levels[2].price) result = "Buena entrada";
  else if (value <= levels[3].price) result = "Compra parcial";
  $("targetResult").textContent = usd(value) + ": " + result;
}

function renderChart(id, rows, keys) {
  const el = $(id);
  if (!rows || rows.length < 2) {
    el.innerHTML = '<div class="empty">Sin datos para graficar</div>';
    return;
  }
  const width = 760;
  const height = 260;
  const pad = { left: 52, right: 12, top: 12, bottom: 24 };
  const vals = [];
  for (const row of rows) for (const key of keys) if (Number.isFinite(row[key])) vals.push(row[key]);
  const min = Math.min(...vals) * 0.96;
  const max = Math.max(...vals) * 1.04;
  const x = (i) => pad.left + (i / (rows.length - 1)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + (1 - (v - min) / (max - min || 1)) * (height - pad.top - pad.bottom);
  const colors = { close: "#FFD700", ma200: "#4CAF50", upper: "#f44336", lower: "#00ff00" };
  let svg = '<svg viewBox="0 0 ' + width + ' ' + height + '">';
  for (let i = 0; i <= 4; i++) {
    const gy = pad.top + (i / 4) * (height - pad.top - pad.bottom);
    const val = max - (i / 4) * (max - min);
    svg += '<line class="grid-line" x1="' + pad.left + '" y1="' + gy + '" x2="' + (width - pad.right) + '" y2="' + gy + '"/>';
    svg += '<text class="axis-text" x="4" y="' + (gy + 4) + '">' + usd(val) + '</text>';
  }
  for (const key of keys) {
    const points = rows.map((row, i) => Number.isFinite(row[key]) ? x(i) + "," + y(row[key]) : null).filter(Boolean).join(" ");
    const dash = key === "upper" || key === "lower" ? ' stroke-dasharray="6 6"' : "";
    if (points) svg += '<polyline points="' + points + '" fill="none" stroke="' + colors[key] + '" stroke-width="' + (key === "close" ? 3 : 2) + '"' + dash + '/>';
  }
  svg += "</svg>";
  el.innerHTML = svg;
}

$("refreshBtn").addEventListener("click", loadDashboard);
$("targetPrice").addEventListener("input", updateSimulator);
loadDashboard();
