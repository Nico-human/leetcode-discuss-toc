import http from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/leetcode-discuss-toc.user.js', ['../leetcode-discuss-toc.user.js', 'application/javascript']],
  ['/demo/demo.js', ['../demo/demo.js', 'application/javascript']],
]);

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = files.get(pathname) || (pathname === '/' || /^\/discuss\/post\/\d+\/demo\/$/.test(pathname)
    ? ['../demo/index.html', 'text/html'] : null);
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  try {
    const body = await readFile(new URL(file[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(500);
    res.end('Unable to read demo file');
  }
});

server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => {
  console.log(`Demo: http://127.0.0.1:${server.address().port}/discuss/post/1001/demo/`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
