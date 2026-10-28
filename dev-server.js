// Serves the renderer in a normal browser for development: node dev-server.js
const http = require('http');
const fs = require('fs');
const { resolveAppPath, mimeFor } = require('./paths');

const PORT = Number(process.env.PORT) || 5178;

http.createServer((req, res) => {
  const file = resolveAppPath(new URL(req.url, 'http://x').pathname);
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': mimeFor(file), 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Lumen dev: http://localhost:${PORT}`));
