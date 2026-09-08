import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
http.createServer((req,res) => {
  const file = path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  if (!file.startsWith(root+path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file,(error,body) => {
    if (error) {res.writeHead(404);res.end();return;}
    const types = {'.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.html':'text/html; charset=utf-8'};
    res.setHeader('Content-Type',types[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
}).listen(4173,'127.0.0.1');
