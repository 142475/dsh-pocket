// issue #78 回归：cloudflared 2026.x 把 `tunnel run` 子命令层级的 `--no-autoupdate` 删了，
// 但该 flag 在全局位置（子命令之前）仍有效。这里用假 cloudflared 记录 argv，断言顺序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startQuickTunnel, startNamedTunnel, firstMeaningfulErrorLine } from '../lib/tunnel.mjs';

async function makeFakeCloudflared() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pocket-fake-cf-'));
  const bin = join(dir, 'cloudflared');
  const record = join(dir, 'argv.json');
  // 假二进制：把 argv 写盘，再按模式打印让隧道"就绪"的行后退出
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
const argv = process.argv.slice(2);
if (argv.includes('--url')) {
  process.stdout.write('https://abc123.trycloudflare.com\\n');
} else {
  process.stdout.write('INF Registered tunnel connection\\n');
}
`;
  await writeFile(bin, script, { mode: 0o755 });
  return { bin, record, dir };
}

function withFakeBin(bin, fn) {
  const prev = process.env.DSH_POCKET_CLOUDFLARED;
  process.env.DSH_POCKET_CLOUDFLARED = bin;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.DSH_POCKET_CLOUDFLARED;
    else process.env.DSH_POCKET_CLOUDFLARED = prev;
  });
}

// 假 cloudflared 是一段带 shebang 的 JS，靠 `cloudflared`（无扩展名）直接执行——
// 这是 POSIX 行为：Windows 的 CreateProcess 不会补 PATHEXT，spawn 无扩展名文件必 ENOENT。
// 所以两个 spawn 用例在 Windows 上跳过，同一回归由下面的源码契约用例跨平台兜住。
const SPAWN_UNSUPPORTED = process.platform === 'win32'
  ? 'Windows 无法 spawn 无扩展名的假 cloudflared；同回归由源码契约用例覆盖'
  : false;

test('issue #78: 快速隧道 --no-autoupdate 在全局位置（argv[0]）', { skip: SPAWN_UNSUPPORTED }, async () => {
  const { bin, record, dir } = await makeFakeCloudflared();
  try {
    await withFakeBin(bin, async () => {
      const ac = new AbortController();
      const { url, kill } = await startQuickTunnel({ port: 3081, signal: ac.signal });
      kill();
      const argv = JSON.parse(await readFile(record, 'utf8'));
      assert.ok(url.includes('trycloudflare.com'), '应解析到快速隧道 URL');
      assert.equal(argv[0], '--no-autoupdate', '--no-autoupdate 必须是 argv 第一个（全局位置）');
      assert.ok(argv.indexOf('tunnel') > argv.indexOf('--no-autoupdate'), '--no-autoupdate 必须在 tunnel 子命令之前');
      assert.ok(argv.includes('--url'), '快速隧道应含 --url');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('issue #78: 命名隧道 --no-autoupdate 在全局位置（argv[0]，含 run）', { skip: SPAWN_UNSUPPORTED }, async () => {
  const { bin, record, dir } = await makeFakeCloudflared();
  try {
    await withFakeBin(bin, async () => {
      const ac = new AbortController();
      const res = await startNamedTunnel({ token: 'faketoken', signal: ac.signal });
      res.kill();
      const argv = JSON.parse(await readFile(record, 'utf8'));
      assert.equal(res.url, null, '命名隧道 url 应为 null（由调用方拼固定域名）');
      assert.equal(argv[0], '--no-autoupdate', '--no-autoupdate 必须是 argv 第一个（全局位置）');
      assert.ok(argv.indexOf('tunnel') > argv.indexOf('--no-autoupdate'), '--no-autoupdate 必须在 tunnel 子命令之前');
      assert.ok(argv.includes('run'), '命名隧道应含 run 子命令');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('firstMeaningfulErrorLine: 参数错误取开头首行', () => {
  const buf = 'Incorrect Usage: flag provided but not defined: -no-autoupdate\n\nNAME:\n  cloudflared tunnel run - Proxy a local web server\n--bastion Runs as jump host ...';
  assert.equal(firstMeaningfulErrorLine(buf), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
});

test('firstMeaningfulErrorLine: 版本横幅在前后仍能取到参数错误行', () => {
  const buf = 'cloudflared version 2026.4.0\nIncorrect Usage: flag provided but not defined: -no-autoupdate\n\nNAME:\n  cloudflared tunnel run ...';
  assert.equal(firstMeaningfulErrorLine(buf), 'Incorrect Usage: flag provided but not defined: -no-autoupdate');
});

test('firstMeaningfulErrorLine: 运行期错误（403）仍取尾部', () => {
  const buf = 'INF Starting tunnel\nERR Failed to connect to origin: 403 Forbidden\nERR retrying';
  const r = firstMeaningfulErrorLine(buf);
  assert.ok(r.includes('403'), '应保留尾部含 403 的报错信息');
});

// ---------- 自建 frp（TCP 转发）：配置生成是纯函数，可跨平台断言 ----------

test('frpConfigToml：生成 frpc.toml（服务器/端口/token/TLS/tcp 代理）', async () => {
  const { frpConfigToml } = await import('../lib/tunnel.mjs');
  const toml = frpConfigToml({
    server: '158.101.29.160', serverPort: 7000, token: 's3cret', remotePort: 60012, localPort: 3081, tls: true,
  });
  assert.match(toml, /serverAddr = "158\.101\.29\.160"/, '服务器地址');
  assert.match(toml, /serverPort = 7000/, 'frps 端口');
  assert.match(toml, /auth\.token = "s3cret"/, 'token 写进配置文件（不进 argv）');
  assert.match(toml, /transport\.tls\.enable = true/, 'TLS 开启');
  assert.match(toml, /\[\[proxies\]\]/, '一个 tcp 代理');
  assert.match(toml, /type = "tcp"/, 'TCP 转发');
  assert.match(toml, /localIP = "127\.0\.0\.1"/, '只转发本机回环');
  assert.match(toml, /localPort = 3081/, '本地端口 = 代理端口');
  assert.match(toml, /remotePort = 60012/, '远程端口');
  assert.match(toml, /transport\.useCompression = true/, '默认开隧道压缩（WS 里的会话 JSON/图片 base64 只能在这里压）');
  assert.ok(toml.indexOf('transport.useCompression') > toml.indexOf('[[proxies]]'), '压缩是每代理选项，必须写在 [[proxies]] 表内（写到顶层 frpc 会 unknown field 启动失败）');
});

test('frpConfigToml：compress=false 不写 useCompression（frpc 0.71 实测该字段名合法，见 tunnel.mjs 注释）', async () => {
  const { frpConfigToml } = await import('../lib/tunnel.mjs');
  const toml = frpConfigToml({ server: 's', remotePort: 60012, localPort: 3081, compress: false });
  assert.ok(!toml.includes('useCompression'), '关掉压缩不写该字段');
});

test('frpConfigToml：无 token 不写 auth 段；TLS 关闭不写 transport 段', async () => {
  const { frpConfigToml } = await import('../lib/tunnel.mjs');
  const toml = frpConfigToml({ server: 'frp.example.com', serverPort: 7000, remotePort: 60012, localPort: 3081, tls: false });
  assert.ok(!toml.includes('auth.'), '无 token 不写 auth');
  assert.ok(!toml.includes('transport.tls'), 'TLS 关闭不写 transport.tls');
});

test('frpConfigToml：protocol=quic 写 transport.protocol，且必须在 [[proxies]] 之前', async () => {
  const { frpConfigToml } = await import('../lib/tunnel.mjs');
  for (const proto of ['quic']) {
    const toml = frpConfigToml({ server: '158.101.29.160', serverPort: 7000, remotePort: 60012, localPort: 3081, tls: true, protocol: proto });
    assert.match(toml, new RegExp(`transport\\.protocol = "${proto}"`), `${proto} 协议`);
    assert.ok(!toml.includes('transport.tls'), `${proto} 自带加密，不再写 transport.tls`);
    // 实测坑：transport.* 排在 [[proxies]] 之后会被 TOML 归进 proxy 表，
    // frpc 报 `unmarshal ProxyConfig error: json: unknown field "protocol"`。
    assert.ok(toml.indexOf('transport.protocol') < toml.indexOf('[[proxies]]'), 'transport 段必须在 [[proxies]] 之前');
  }
  // 默认（tcp）不受影响：仍然只写 TLS
  const def = frpConfigToml({ server: 's', remotePort: 60012, localPort: 3081, tls: true });
  assert.ok(!def.includes('transport.protocol'), '默认 tcp 不写 protocol');
  assert.match(def, /transport\.tls\.enable = true/, '默认 tcp 仍写 TLS');
});

test('frpAssets：按平台给出官方发布资产名（windows 是 zip，其余 tar.gz）', async () => {
  const { frpAssets } = await import('../lib/tunnel.mjs');
  const assets = frpAssets('v0.71.0');
  assert.equal(assets.length, 1, '每个平台一个候选资产');
  const name = assets[0];
  assert.match(name, /^frp_0\.71\.0_(windows|darwin|linux)_(amd64|arm64|386|arm)\.(zip|tar\.gz)$/, `资产名合法：${name}`);
  if (process.platform === 'win32') assert.ok(name.endsWith('.zip'), 'Windows 资产是 zip');
  else assert.ok(name.endsWith('.tar.gz'), '类 Unix 资产是 tar.gz');
});

// 跨平台兜底（issue #78）：Windows 上跑不了上面两个 spawn 用例，
// 但「--no-autoupdate 必须紧邻并位于 tunnel 子命令之前」与平台无关，直接锁源码契约。
test('issue #78: --no-autoupdate 位置契约（跨平台源码断言）', async () => {
  const src = await readFile(new URL('../lib/tunnel.mjs', import.meta.url), 'utf8');
  const calls = (src.match(/spawn\(bin, \[[^\]]*\]/g) ?? []).filter((c) => c.includes("'tunnel'"));
  assert.equal(calls.length, 2, `tunnel.mjs 应有快速/命名两处隧道 spawn，实得 ${calls.length} 处`);
  for (const call of calls) {
    assert.match(call, /\['--no-autoupdate', 'tunnel'/, `--no-autoupdate 必须排在最前：${call}`);
  }
});
