// =============================================================================
//  Auction Overlay Server  (cloud-deployable, single unit)
//
//  Serves:   /                control page ("Connect eBay" + status + OBS URL)
//            /overlay/...      the overlay itself (static)
//            ws(s)://host      live bid feed the overlay connects to
//            /ebay/connect     one-click eBay authorization (seller consent)
//            /ebay/accepted    eBay redirects here -> we fetch + save the token
//            /ebay/webhook     eBay posts BidReceived notifications here
//            /bid /end         manual/test feed
//
//  Flow:  eBay --(BidReceived)--> this server --(WebSocket)--> overlay in OBS
// =============================================================================

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { XMLParser } from "fast-xml-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = path.join(__dirname, "..", "overlay");
const TOKEN_FILE = path.join(__dirname, "token.json");

const PORT = process.env.PORT || 8787;
const SIMULATE = process.argv.includes("--simulate") || process.env.SIMULATE === "1";
const ENV = (process.env.EBAY_ENV || "production").toLowerCase();
const EBAY_API_URL = ENV === "sandbox" ? "https://api.sandbox.ebay.com/ws/api.dll" : "https://api.ebay.com/ws/api.dll";
const SIGNIN_BASE  = ENV === "sandbox" ? "https://signin.sandbox.ebay.com/ws/eBayISAPI.dll" : "https://signin.ebay.com/ws/eBayISAPI.dll";

const EBAY_DEV_ID  = process.env.EBAY_DEV_ID  || "";
const EBAY_APP_ID  = process.env.EBAY_APP_ID  || "";
const EBAY_CERT_ID = process.env.EBAY_CERT_ID || "";
const EBAY_RUNAME  = process.env.EBAY_RUNAME  || "";
const EBAY_VERIFICATION_TOKEN = process.env.EBAY_VERIFICATION_TOKEN || "set-a-32-80-char-token-here";
// Public base URL of THIS server once deployed (e.g. https://xyz.onrender.com).
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: true });

// token persistence (single seller) -------------------------------------------
let authToken = process.env.EBAY_AUTH_TOKEN || "";
let subscribed = false;
(function loadToken() {
  if (authToken) return;
  try { authToken = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).token || ""; } catch {}
})();
function saveToken(token, expires) {
  authToken = token;
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, expires }, null, 2)); } catch (e) { console.warn("token save failed", e.message); }
}

// -----------------------------------------------------------------------------
// WebSocket hub
// -----------------------------------------------------------------------------
const clients = new Set();
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  console.log(`-> overlay (${clients.size}):`, msg);
}
function sendBid(username, amount) {
  if (!username) return;
  broadcast({ type: "bid", username: String(username), amount: amount == null ? null : Number(amount) });
}

// -----------------------------------------------------------------------------
// eBay Trading API helpers
// -----------------------------------------------------------------------------
function tradingHeaders(callName) {
  return {
    "X-EBAY-API-SITEID": "0",
    "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
    "X-EBAY-API-CALL-NAME": callName,
    "X-EBAY-API-APP-NAME": EBAY_APP_ID,
    "X-EBAY-API-DEV-NAME": EBAY_DEV_ID,
    "X-EBAY-API-CERT-NAME": EBAY_CERT_ID,
    "Content-Type": "text/xml",
  };
}
async function tradingCall(callName, inner) {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">${inner}</${callName}Request>`;
  const resp = await fetch(EBAY_API_URL, { method: "POST", headers: tradingHeaders(callName), body });
  return xml.parse(await resp.text());
}
const deepGet = (o, k) => {
  if (o == null || typeof o !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(o, k)) return o[k];
  for (const kk of Object.keys(o)) { const v = deepGet(o[kk], k); if (v !== undefined) return v; }
  return undefined;
};
const asText = (v) => (v && typeof v === "object" ? v["#text"] ?? "" : v);

async function ebayGetSessionID() { return asText(deepGet(await tradingCall("GetSessionID", `<RuName>${EBAY_RUNAME}</RuName>`), "SessionID")); }
async function ebayFetchToken(sid) {
  const r = await tradingCall("FetchToken", `<SessionID>${sid}</SessionID>`);
  return { token: asText(deepGet(r, "eBayAuthToken")), ack: asText(deepGet(r, "Ack")), error: asText(deepGet(r, "LongMessage")), expires: asText(deepGet(r, "HardExpirationTime")) };
}
async function ebaySubscribe(token) {
  const events = ["BidReceived", "AuctionCheckoutComplete", "ItemSold", "EndOfAuction"];
  const inner =
    `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>` +
    `<ApplicationDeliveryPreferences><ApplicationEnable>Enable</ApplicationEnable>` +
    `<ApplicationURL>${webhookUrl()}</ApplicationURL><DeviceType>Platform</DeviceType></ApplicationDeliveryPreferences>` +
    `<UserDeliveryPreferenceArray>${events.map(e => `<NotificationEnable><EventType>${e}</EventType><EventEnable>Enable</EventEnable></NotificationEnable>`).join("")}</UserDeliveryPreferenceArray>`;
  const r = await tradingCall("SetNotificationPreferences", inner);
  const ack = asText(deepGet(r, "Ack"));
  subscribed = ack === "Success" || ack === "Warning";
  return { ack, error: asText(deepGet(r, "LongMessage")) };
}

// -----------------------------------------------------------------------------
// eBay notification parsing (BidReceived)
// -----------------------------------------------------------------------------
function signatureState(obj) {
  const sig = asText(deepGet(obj, "NotificationSignature")), ts = asText(deepGet(obj, "Timestamp"));
  if (!sig || !ts) return "no-signature";
  if (!EBAY_DEV_ID || !EBAY_APP_ID || !EBAY_CERT_ID) return "creds-missing";
  const calc = crypto.createHash("md5").update(String(ts) + EBAY_DEV_ID + EBAY_APP_ID + EBAY_CERT_ID).digest("base64");
  return calc === String(sig) ? "valid" : "invalid";
}
function extractBidFromEbay(obj) {
  const hb = deepGet(obj, "HighBidder") || deepGet(obj, "Bidder");
  let username = hb ? asText(deepGet(hb, "UserID")) : asText(deepGet(obj, "HighBidderUserID"));
  const amount = asText(deepGet(obj, "ConvertedCurrentPrice")) ?? asText(deepGet(obj, "CurrentPrice")) ?? asText(deepGet(obj, "MaxBid"));
  return username ? { username, amount } : null;
}
function handleEbayPayload(raw) {
  const text = raw.trim();
  if (text.startsWith("<")) {
    let obj; try { obj = xml.parse(text); } catch (e) { console.warn("eBay XML parse failed:", e.message); return; }
    const evt = asText(deepGet(obj, "NotificationEventName")) || "(unknown)";
    const sig = signatureState(obj);
    if (sig === "invalid") console.warn("⚠ eBay signature INVALID — check DevID/AppID/CertID");
    const bid = extractBidFromEbay(obj);
    console.log(`eBay notification: ${evt} · signature=${sig} · bid=${bid ? JSON.stringify(bid) : "none"}`);
    if (bid) sendBid(bid.username, bid.amount); else console.log(text.slice(0, 500));
  } else {
    try { const j = JSON.parse(text); const b = extractBidFromEbay(j) || (j.username ? { username: j.username, amount: j.amount } : null); if (b) sendBid(b.username, b.amount); } catch {}
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
const readRaw = (req) => new Promise((r) => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); });
function baseUrl(req) { return PUBLIC_URL || `http://${req.headers.host}`; }
function webhookUrl() { return (PUBLIC_URL || `http://localhost:${PORT}`) + "/ebay/webhook"; }
const CT = { ".html":"text/html", ".js":"application/javascript", ".css":"text/css", ".png":"image/png", ".gif":"image/gif", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".json":"application/json" };
function serveStatic(res, rel) {
  const fp = path.join(OVERLAY_DIR, path.normalize("/" + rel));
  if (!fp.startsWith(OVERLAY_DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "content-type": CT[path.extname(fp)] || "application/octet-stream" }); res.end(data);
  });
}

function controlPage(req) {
  const base = baseUrl(req);
  const overlayUrl = `${base}/overlay/index.html?bg=0&demo=0`;
  const keysOk = Boolean(EBAY_APP_ID && EBAY_DEV_ID && EBAY_CERT_ID && EBAY_RUNAME);
  const step = (ok, text) => `<li style="color:${ok ? "#4dff9e" : "#ff6a7a"}">${ok ? "✓" : "○"} ${text}</li>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Auction Overlay — Control</title>
  <style>body{font-family:system-ui,Segoe UI,Arial;background:#0c0c16;color:#dfeaff;margin:0;padding:40px;max-width:760px}
  a.btn{display:inline-block;background:#ff2d7e;color:#fff;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:600}
  a.btn.off{background:#444;pointer-events:none;opacity:.5}
  code{background:#1a1a2e;padding:3px 7px;border-radius:5px;color:#9fe0ff;word-break:break-all}
  h1{margin-top:0} ul{line-height:1.9;list-style:none;padding-left:0} .card{background:#141424;padding:20px 24px;border-radius:12px;margin:18px 0}</style></head>
  <body>
  <h1>⚔ Auction Overlay — Control</h1>
  <div class="card">
    <h3>1. Connect eBay</h3>
    <ul>
      ${step(keysOk, "App keys + RuName configured")}
      ${step(Boolean(authToken), "Seller account connected")}
      ${step(subscribed, "Subscribed to bid notifications")}
    </ul>
    <a class="btn ${keysOk ? "" : "off"}" href="/ebay/connect">${authToken ? "Reconnect eBay" : "Connect eBay"}</a>
    ${keysOk ? "" : "<p style='color:#ff9'>Set EBAY_APP_ID / EBAY_DEV_ID / EBAY_CERT_ID / EBAY_RUNAME first.</p>"}
  </div>
  <div class="card">
    <h3>2. Add to OBS</h3>
    <p>OBS → Sources → + → Browser → paste this URL (1280×720):</p>
    <p><code>${overlayUrl}</code></p>
    <p><a href="${overlayUrl}" target="_blank">open overlay ↗</a> · <a href="/overlay/index.html" target="_blank">open with demo panel ↗</a></p>
  </div>
  <div class="card"><h3>Status</h3><ul>
    <li>overlays connected: <b>${clients.size}</b></li>
    <li>webhook URL eBay posts to: <code>${webhookUrl()}</code></li>
    <li>environment: <b>${ENV}</b></li>
  </ul></div>
  </body></html>`;
}

// -----------------------------------------------------------------------------
// HTTP server
// -----------------------------------------------------------------------------
let pendingSessionID = "";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const sendJSON = (c, o) => { res.writeHead(c, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  const sendHTML = (c, h) => { res.writeHead(c, { "content-type": "text/html" }); res.end(h); };

  // control page + overlay static
  if (req.method === "GET" && p === "/") return sendHTML(200, controlPage(req));
  if (req.method === "GET" && (p === "/overlay" || p === "/overlay/")) return serveStatic(res, "index.html");
  if (req.method === "GET" && p.startsWith("/overlay/")) return serveStatic(res, p.slice("/overlay/".length));

  // --- eBay connect flow ---
  if (req.method === "GET" && p === "/ebay/connect") {
    if (!EBAY_APP_ID || !EBAY_RUNAME) return sendHTML(400, "<p>Set EBAY_APP_ID/DEV/CERT + EBAY_RUNAME first.</p>");
    try {
      pendingSessionID = await ebayGetSessionID();
      const signin = `${SIGNIN_BASE}?SignIn&runame=${encodeURIComponent(EBAY_RUNAME)}&SessID=${encodeURIComponent(pendingSessionID)}`;
      res.writeHead(302, { Location: signin }); return res.end();
    } catch (e) { return sendHTML(500, "<p>GetSessionID failed: " + e.message + "</p>"); }
  }
  if (req.method === "GET" && (p === "/ebay/accepted" || p === "/ebay/callback")) {
    try {
      const r = await ebayFetchToken(pendingSessionID);
      if (!r.token) return sendHTML(400, "<p>Could not fetch token. " + (r.error || "") + "</p><p><a href='/'>back</a></p>");
      saveToken(r.token, r.expires);
      // printed to server logs only (e.g. Render logs) so you can set it as the
      // EBAY_AUTH_TOKEN env var to persist across restarts/redeploys.
      console.log("eBay seller token acquired. To persist, set env EBAY_AUTH_TOKEN=\n" + r.token);
      const sub = await ebaySubscribe(r.token);
      return sendHTML(200, `<body style="font-family:system-ui;background:#0c0c16;color:#dfeaff;padding:40px">
        <h2>✅ eBay connected${sub.ack === "Success" || sub.ack === "Warning" ? " & subscribed to bids" : ""}.</h2>
        <p>Token expires: ${r.expires || "n/a"}. ${sub.ack && sub.ack !== "Success" ? "Subscribe: " + sub.ack + " " + (sub.error || "") : ""}</p>
        <p><a style="color:#49e0ff" href="/">← back to control panel</a></p></body>`);
    } catch (e) { return sendHTML(500, "<p>FetchToken failed: " + e.message + "</p>"); }
  }
  if (req.method === "GET" && p === "/ebay/declined") return sendHTML(200, "<p>eBay connection was declined. <a href='/'>back</a></p>");

  // --- eBay notification endpoint ---
  if (req.method === "GET" && p === "/ebay/webhook" && url.searchParams.has("challenge_code")) {
    const challenge = url.searchParams.get("challenge_code");
    const h = crypto.createHash("sha256"); h.update(challenge); h.update(EBAY_VERIFICATION_TOKEN); h.update(webhookUrl());
    return sendJSON(200, { challengeResponse: h.digest("hex") });
  }
  if (req.method === "POST" && p === "/ebay/webhook") { handleEbayPayload(await readRaw(req)); res.writeHead(200); return res.end("OK"); }

  // --- manual / test ---
  if (req.method === "POST" && p === "/bid") { let b = {}; try { b = JSON.parse(await readRaw(req)); } catch {} sendBid(b.username, b.amount); return sendJSON(200, { ok: true }); }
  if (req.method === "POST" && p === "/end") { broadcast({ type: "end" }); return sendJSON(200, { ok: true }); }
  if (req.method === "GET" && p === "/status") return sendJSON(200, { overlays: clients.size, ebayConnected: Boolean(authToken), subscribed, env: ENV });

  sendJSON(404, { error: "not found" });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws); console.log(`overlay connected (${clients.size})`);
  ws.on("close", () => { clients.delete(ws); console.log(`overlay disconnected (${clients.size})`); });
  ws.on("error", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`\nAuction overlay server on ${PUBLIC_URL || `http://localhost:${PORT}`}`);
  console.log(`Control panel:  ${PUBLIC_URL || `http://localhost:${PORT}`}/`);
  console.log(`Overlay (OBS):  ${PUBLIC_URL || `http://localhost:${PORT}`}/overlay/index.html?bg=0&demo=0\n`);
  if (SIMULATE) startSimulator();
});

// -----------------------------------------------------------------------------
// Simulator
// -----------------------------------------------------------------------------
function startSimulator() {
  const names = ["hardworker706","sneaky_sora","ghost_bidder","NeonSamurai","dragon_yen","retro_ronin","pixelpunk99"];
  let top = 5, leader = null;
  console.log("SIMULATE mode: fake bids every ~2s\n");
  const tick = () => { const hold = leader && Math.random() < 0.4; leader = hold ? leader : names[(Math.random()*names.length)|0]; top += Math.ceil(5+Math.random()*40); sendBid(leader, top); setTimeout(tick, 1500+Math.random()*1500); };
  setTimeout(tick, 1500);
  setInterval(() => { broadcast({ type: "end" }); setTimeout(() => { top = 5; leader = null; }, 6000); }, 45000);
}
