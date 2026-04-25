// Tiny zero-dep static server for QA. Serves the repo root and stubs
// /api/proxy so Apps-Script-dependent flows don't hang in headless tests.
//
// Listens on PORT (default 4173). Used by playwright.config.ts via webServer.

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '4173', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js'  : 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css' : 'text/css; charset=utf-8',
  '.png' : 'image/png',
  '.jpg' : 'image/jpeg',
  '.svg' : 'image/svg+xml',
  '.ico' : 'image/x-icon',
  '.map' : 'application/json',
};

// Minimal floatation summary stub so Branch Today can render without a real
// Apps Script call. Shape mirrors what _btTransformFloatation expects.
function stubFloatation(){
  return {
    type: 'floatation',
    timestamp: new Date().toISOString(),
    summary: {
      header: ['', 'Walk-In', 'Conv', 'Basket', 'Sales', 'YTD WI', 'YTD Conv', 'YTD Basket', 'YTD Sales'],
      rows: [
        ['Malay',   42, 0.31, 145.0, 1890, 410, 0.30, 142.5, 17500],
        ['Chinese', 18, 0.40, 220.0, 1584,  175, 0.38, 215.0,  7100],
        ['Indian',   9, 0.29, 130.0,  339,   90, 0.31, 128.0,  3500],
        ['Total',   69, 0.33, 168.0, 3813,  675, 0.32, 164.0, 28100],
      ]
    },
    meta: { sheets:['Summary'], stub:true }
  };
}

// Per-type stubs: dashboard's fetchFromGoogleDrive() pulls financial / stock /
// customers separately. Each handler expects `{ok:true, data:{...}}` —
// returning empty {} in `data` is fine; the dashboard merges only fields
// that are present.
function stubByType(t){
  switch(t){
    case 'financial':
      return { ok:true, data: { current_period:{}, branch_monthly:{}, cashflow:{months:[],series:{}}, liability:{} } };
    case 'stock':
      return { ok:true, data: { by_branch:{} } };
    case 'customers':
      return { ok:true, data: { by_month:[], race:{} } };
    case 'sales':
      return { ok:true, data: {} };
    case 'floatation':
    case 'branch_today':
      return { ok:true, data: stubFloatation() };
    case 'all':
      return { ok:true, data: { financial:{}, stock:{}, customers:{}, floatation: stubFloatation(), meta:{ stub:true } } };
    default:
      return { ok:true, data: {} };
  }
}

function send(res, status, body, type){
  res.writeHead(status, {
    'Content-Type': type || 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

function serveStatic(req, res){
  // Strip query string
  const reqUrl = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(reqUrl.pathname);
  if (p === '/') p = '/index.html';

  // Prevent path traversal
  const abs = path.resolve(ROOT, '.' + p);
  if (!abs.startsWith(ROOT)) return send(res, 403, 'forbidden', 'text/plain');

  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'not found', 'text/plain');
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  // Stub the Vercel proxy so the dashboard runs offline.
  // Contract: respond with {ok:true, data:{...}} so the production
  // fetchFromGoogleDrive() flow accepts the response without falling
  // through to the error path.
  if (req.url && req.url.startsWith('/api/proxy')) {
    const u = new URL(req.url, 'http://localhost');
    const t = (u.searchParams.get('type') || '').toLowerCase();
    return send(res, 200, JSON.stringify(stubByType(t)));
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`QA server running at http://localhost:${PORT}`);
});
