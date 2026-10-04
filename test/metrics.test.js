// 外网带宽体检：流量计量（/dsh-pocket-metrics）+ 强制 brotli 透传。
//
// 公网隧道按流量算，出问题时要能回答「带宽被谁吃了」：这里覆盖计量的四个维度
// （HTTP 出/入、WS 出/入、按路径分类、连接数）与 brotli 收窄的判据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createUp } from 'node:http';
import { createHash } from 'node:crypto';
import { createPocketProxy, preferBrotli, metricsBucket, METRICS_PATH } from '../lib/proxy.mjs';

function wsAccept(key) {
  return createHash('sha1').update(String(key) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

test('流量计量：按方向/分类累计，metrics 端点可读可清零', async () => {
  const up = createUp((req, res) => {
    if (req.url.startsWith('/api')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ bodyLen: body.length }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('x'.repeat(4096));
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    heartbeat: false,
  });
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    // 静态资源：4096B 出口（identity 避免代理自己再压一遍，字节数才好断言）
    const js = await fetch(`${base}/assets/a.js`, { headers: { 'accept-encoding': 'identity' } });
    assert.equal(js.status, 200);
    assert.equal((await js.arrayBuffer()).byteLength, 4096);

    // API：上行 100B + 下行 JSON
    const api = await fetch(`${base}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' },
      body: JSON.stringify({ pad: 'y'.repeat(90) }),
    });
    assert.equal(api.status, 200);
    assert.equal((await api.json()).bodyLen > 90, true, '上行请求体完整透传');

    const snap = JSON.parse(await (await fetch(`${base}${METRICS_PATH}`)).text());
    assert.equal(typeof snap.uptimeSec, 'number');
    assert.equal(snap.http.out >= 4096, true, `出口字节累计（实测 ${snap.http.out}）`);
    assert.equal(snap.http.in > 90, true, `上行字节累计（实测 ${snap.http.in}）`);
    assert.equal(snap.byClass.static.out >= 4096, true, '静态资源归类到 static');
    assert.equal(snap.byClass.api.requests >= 1, true, 'API 请求计数');
    assert.equal(snap.byClass.static.requests, 1);
    assert.equal(snap.ws.connections, 0, '没有 WS 连接时计数为 0');
    assert.equal(typeof snap.rssBytes, 'number');

    // ?reset=1 清零（本次请求自身会重新计入 other）
    const cleared = JSON.parse(await (await fetch(`${base}${METRICS_PATH}?reset=1`)).text());
    assert.equal(cleared.http.out, 0, 'reset 后出口字节归零');
    assert.equal(cleared.http.in, 0, 'reset 后上行字节归零');
    assert.equal(cleared.byClass.static, undefined, 'reset 后分类计数清空');

    // 只读端点：非 GET/HEAD 拒绝
    const bad = await fetch(`${base}${METRICS_PATH}`, { method: 'POST', body: '{}' });
    assert.equal(bad.status, 405);
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});

test('强制 brotli：客户端支持 br 时收窄请求头，不支持则原样透传', async () => {
  const seen = [];
  const up = createUp((req, res) => {
    seen.push(req.headers['accept-encoding']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    heartbeat: false,
  });
  const base = `http://127.0.0.1:${proxy.port}`;
  try {
    await (await fetch(`${base}/api/a`, { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } })).arrayBuffer();
    await (await fetch(`${base}/api/b`, { headers: { 'accept-encoding': 'gzip' } })).arrayBuffer();
    assert.equal(seen[0], 'br', '支持 br 时上游只看到 br（实测省 ~9%）');
    assert.equal(seen[1], 'gzip', '不支持 br 时不改写，gzip 兜底');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }

  // 纯函数：无头/不支持时不得凭空加头
  assert.deepEqual(preferBrotli({}), {});
  assert.equal(preferBrotli({ 'accept-encoding': 'gzip' })['accept-encoding'], 'gzip');
  assert.equal(preferBrotli({ 'accept-encoding': 'br' })['accept-encoding'], 'br');
  // RFC 9110：Accept-Encoding 的 token 大小写不敏感，但必须整词匹配（'bRoTLi' 不是 'br'）
  assert.equal(preferBrotli({ 'accept-encoding': 'deflate, BR' })['accept-encoding'], 'br');
  assert.equal(preferBrotli({ 'accept-encoding': 'bRoTLi' })['accept-encoding'], 'bRoTLi');
  assert.equal(metricsBucket('/assets/index.js'), 'static');
  assert.equal(metricsBucket('/plugins/??a/client.js'), 'static');
  assert.equal(metricsBucket('/api/rpc'), 'api');
  assert.equal(metricsBucket('/'), 'html');
  assert.equal(metricsBucket('/pocket-login'), 'other');
});

test('流量计量：WS 帧双向计数与连接数（会话数据、图片 base64 走这条链路）', async () => {
  const up = createUp((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  up.on('upgrade', (req, socket) => {
    // 上游 socket 必须自己兜 error：客户端断开时代理侧走 resetAndDestroy（RST），
    // 这里会收到 ECONNRESET —— 不兜就是一个 uncaughtException，把测试进程带崩。
    socket.on('error', () => {});
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    // 回程必须发「合法的未掩码文本帧」：把客户端带掩码的帧原样 echo 回去会被
    // 浏览器/undici 判为协议错误并立刻断链（实测 5ms 内 RST 上游，测试挂死）。
    // 收到 close 帧（opcode 0x8）要回 close 帧，否则客户端一直等对端确认，
    // 连接不关、live 计数不回落。
    socket.on('data', (c) => {
      if ((c[0] & 0x0f) === 0x8) { socket.write(Buffer.from([0x88, 0x00])); socket.end(); return; }
      socket.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    });
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const proxy = await createPocketProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: up.address().port },
    heartbeat: false,
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/events.host`);
    const closed = new Promise((_, reject) => ws.addEventListener('close', (e) => reject(new Error(`WS 提前关闭 code=${e.code}`))));
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
    const echoed = new Promise((resolve) => ws.addEventListener('message', (e) => resolve(e.data)));
    ws.send('hello');
    assert.equal(await Promise.race([echoed, closed]), 'hello', 'WS 透传正常');

    const snap = proxy.metrics.snapshot();
    assert.equal(snap.ws.connections, 1);
    assert.equal(snap.ws.live, 1);
    assert.equal(snap.ws.in >= 5, true, `上行帧字节计数（实测 ${snap.ws.in}）`);
    assert.equal(snap.ws.out >= 5, true, `下行帧字节计数（实测 ${snap.ws.out}）`);

    ws.close();
    for (let i = 0; i < 60 && proxy.metrics.snapshot().ws.live !== 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(proxy.metrics.snapshot().ws.live, 0, '断开后活跃连接数回落');
  } finally {
    await proxy.close();
    await new Promise((r) => up.close(r));
  }
});
