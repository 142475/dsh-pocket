// dsh-pocket 静态资源缓存测试。
//
// 背景：DSH 核心的 SPA 静态服务（@deepseek-ai/dsh-host-frontend-static/lib/index.js）
// 对 dist 资源只回 content-type + Vary —— 没有 cache-control、没有 etag、
// 没有 last-modified ⇒ 浏览器每次打开页面都要把 /assets/*.js|css（首屏数 MB）、
// favicon、manifest 重新下载一遍。代理必须替它补上缓存头，同时不能覆盖上游
// 自己声明过的策略（插件 bundle 的 immutable、API 的 no-store）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { createPocketProxy, withStaticCacheHeaders } from '../lib/proxy.mjs';

/** 假上游：按路径回不同 content-type / 状态码 / 自带缓存头。 */
async function fakeUpstream() {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/assets/broken.js') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
      return;
    }
    if (path === '/assets/own-cache.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=60' });
      res.end('a{}');
      return;
    }
    const type = path.endsWith('.js') ? 'text/javascript; charset=utf-8'
      : path.endsWith('.css') ? 'text/css; charset=utf-8'
        : path.endsWith('.svg') ? 'image/svg+xml'
          : path.endsWith('.webmanifest') ? 'application/manifest+json'
            : path.endsWith('.json') ? 'application/json'
              : /\.html?$/.test(path) ? 'text/html; charset=utf-8'
                : 'application/octet-stream';
    // .js 给足 2KB，好走代理的压缩分支（阈值 1024）；其余给 64B。
    const body = Buffer.alloc(path.endsWith('.js') ? 2048 : 64, 0x61);
    res.writeHead(200, { 'content-type': type, vary: 'Accept-Encoding', 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, server };
}

/** 原始 http.request：fetch 会自动解压、自动加 accept-encoding，这里要精确控制。 */
function get(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 起一对「假上游 + 代理」，跑完自动收摊。injectHtml 默认注入（测 HTML 分支）。 */
async function withProxy(run, { injectHtml = '' } = {}) {
  const up = await fakeUpstream();
  const proxy = await createPocketProxy({ port: 0, host: '127.0.0.1', upstream: { host: '127.0.0.1', port: up.port }, injectHtml });
  try {
    await run(proxy.port);
  } finally {
    await proxy.close();
    await new Promise((r) => up.server.close(r));
  }
}

const IMMUTABLE = 'private, max-age=31536000, immutable';
const DAY = 'private, max-age=86400';

test('内容哈希命名的构建产物补 immutable 缓存头（透传分支）', async () => {
  await withProxy(async (port) => {
    const res = await get(port, '/assets/index-5SrrfWpU.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], IMMUTABLE, 'hashed 产物应可长期缓存');
    assert.match(res.headers['content-type'] ?? '', /text\/javascript/);
    assert.equal(res.body.length, 2048, '字节原样透传');
  });
});

test('大 js 走压缩分支时同样补缓存头，且仍被压缩', async () => {
  await withProxy(async (port) => {
    const res = await get(port, '/assets/vendor-CCJJTK99.js', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'gzip', '压缩分支仍然生效');
    assert.equal(res.headers['cache-control'], IMMUTABLE, '压缩分支也要补缓存头');
    assert.equal(gunzipSync(res.body).length, 2048, '压缩后解出来还是原字节');
  });
});

test('未哈希的资源给一天缓存（favicon / manifest）', async () => {
  await withProxy(async (port) => {
    const favicon = await get(port, '/favicon.svg');
    assert.equal(favicon.headers['cache-control'], DAY);
    const manifest = await get(port, '/manifest.webmanifest');
    assert.equal(manifest.headers['cache-control'], DAY);
  });
});

test('带 rev 查询的插件 bundle 视为不可变', async () => {
  await withProxy(async (port) => {
    const res = await get(port, '/plugins/dsh-pocket/client.js?rev=f8cb550f4268');
    assert.equal(res.headers['cache-control'], IMMUTABLE);
  });
});

test('HEAD 请求也补缓存头', async () => {
  await withProxy(async (port) => {
    const res = await get(port, '/assets/index-BPHePDI_.css', { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], IMMUTABLE);
  });
});

test('上游自己声明了缓存策略时不覆盖', async () => {
  await withProxy(async (port) => {
    const res = await get(port, '/assets/own-cache.css');
    assert.equal(res.headers['cache-control'], 'public, max-age=60', '上游的 cache-control 优先');
  });
});

test('API / 非静态路径 / 非 200 / 非 GET 一律不加缓存头', async () => {
  await withProxy(async (port) => {
    const api = await get(port, '/api/sessions', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(api.headers['cache-control'], undefined, 'API 不能缓存');

    const workspace = await get(port, '/workspace/notes.js');
    assert.equal(workspace.headers['cache-control'], undefined, '工作区文件不能当静态资源缓存');

    const missing = await get(port, '/assets/broken.js');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cache-control'], undefined, '404 不加缓存头');

    const posted = await get(port, '/assets/index-5SrrfWpU.js', { method: 'POST' });
    assert.equal(posted.headers['cache-control'], undefined, '非 GET/HEAD 不加缓存头');
  });
});

test('HTML 注入分支仍强制 no-store（不能被缓存头覆盖）', async () => {
  await withProxy(async (port) => {
    const res = await get(port, '/index.html', { headers: { accept: 'text/html' } });
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.equal(res.headers['cache-control'], 'no-store', '注入过的文档必须不缓存');
  }, { injectHtml: '<script data-test-inject="1"></script>' });
});

test('withStaticCacheHeaders 直测：expires 也算已有策略', () => {
  const headers = { 'content-type': 'text/css', expires: 'Wed, 21 Oct 2099 07:28:00 GMT' };
  withStaticCacheHeaders(headers, { method: 'GET', status: 200, url: '/assets/x-12345678.css' });
  assert.equal(headers['cache-control'], undefined, '有 expires 就不插手');
});
