// cloudflared 隧道：把本机代理暴露成公网 https URL
//
// 两条路径（issue #66）：
//   - 快速隧道 startQuickTunnel：URL 由 cloudflared 随机分配（每次重启会变），零配置；
//   - 命名隧道 startNamedTunnel：用户自带 Cloudflare Tunnel Token + 固定域名，重启地址不变。
//
// 手机在任何网络都能访问。公网一律要求访问密码（dsh web 能执行代码，请勿泄露二维码/URL）。

import { spawn, execSync } from 'node:child_process';
import { mkdir, access, chmod, rm, stat, rename, cp, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';

// 快速隧道 URL：https://<随机子域>.trycloudflare.com
// (?!api\.) 负向前瞻排除保留子域 api（issue #32）：某些 cloudflared 版本/网络环境下
// 进程输出会先出现 https://api.trycloudflare.com（Cloudflare API 注册地址），原正则
// [a-z0-9-]+ 会把它误当隧道 URL → 设置页/二维码给出 api 地址 → 扫码打开返回
// {"code":10005,"message":"Method Not Allowed"}。api.trycloudflare.com 访问 GET 实测
// 正是该错误体，与 issue 完全一致。
export const QUICK_TUNNEL_URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * 从 cloudflared 输出里提取最有诊断价值的一段（issue #78）。
 *
 * cloudflared 参数错误（如 "Incorrect Usage: flag provided but not defined"）的
 * 关键信息在输出**开头**，尾部整段都是 usage 帮助文本（对用户没用）；而运行期错误
 * （403 / 协议 / 网络）的关键信息在**尾部**。所以：参数错误取该行，其它仍取尾部。
 * 最多 500 字符，与历史上限一致。
 */
export function firstMeaningfulErrorLine(buf) {
  const lines = String(buf ?? '').trim().split(/\r?\n/);
  // 命中哪行就返回哪行：cloudflared 先打版本横幅时，参数错误未必是首行
  const usageIdx = lines.findIndex((l) => /^(?:Incorrect Usage|flag provided but not defined|unknown flag|unknown command)/i.test(l.trim()));
  if (usageIdx >= 0) return lines[usageIdx].trim().slice(0, 500);
  return lines.slice(-4).join('\n').trim().slice(0, 500);
}

function platformBinary() {
  const archMap = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };
  const a = archMap[process.arch] ?? process.arch;
  const os = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux';
  return { os, a, ext: os === 'windows' ? '.exe' : '' };
}

/**
 * 候选发布资产名，按优先级排列（issue #45）。
 *
 * cloudflared 现在的发布布局是**按平台分**：
 * - linux：只有裸二进制 `cloudflared-linux-amd64`（没有 .tgz）
 * - darwin：只有 `cloudflared-darwin-<arch>.tgz`
 * - windows：只有 `cloudflared-windows-<arch>.exe`
 *
 * 我们以前给 linux 拼的是 `cloudflared-linux-amd64.tgz`，而它**根本不存在**
 * （GitHub 返回 404），五个镜像全指向同一个 404 地址，于是必然"所有源都不通"
 * —— 表现就是 Linux 服务器上开了公网访问一直报"无法安装"，而 macOS/Windows
 * 一切正常。Linux 下裸二进制还有个额外好处：不用解压，也就不再依赖系统装了
 * `tar`（Alpine / slim 镜像 / 容器里常常没有）。
 *
 * linux 仍把 .tgz 留在候选里作为回退，万一上游改回打包方式也不会直接躺平。
 *
 * @returns {string[]} 资产名列表，越靠前越优先。
 */
export function platformAssets() {
  const { os, a } = platformBinary();
  if (os === 'windows') return [`cloudflared-windows-${a}.exe`];
  if (os === 'darwin') return [`cloudflared-darwin-${a}.tgz`];
  return [`cloudflared-linux-${a}`, `cloudflared-linux-${a}.tgz`];
}

/**
 * cloudflared 下载源。
 * 平台策略：macOS 优先清华 TUNA 镜像的 Homebrew bottle（国内 CDN，实测 ~3MB/s），
 * 拿不到再回退；Linux / Windows 直接走官方源优先（见 downloadCloudflared 里的说明）。
 * 兜底：官方 GitHub + 国内加速源（ghproxy.net / gh.ddlc.top / gh-proxy.com，2026-08
 * 实测可达）。npmmirror（淘宝）没有 cloudflared 镜像（已实测 404）。
 */
const CLOUDFLARED_MIRRORS = [
  (asset) => `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://ghproxy.net/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh.ddlc.top/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
  (asset) => `https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`,
];

const TUNA_BOTTLES = 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/';

/** 多线程分块下载的并发段数（Windows 官方源单线程 ~200KB/s，8 并发 ≈ 1.6MB/s）。 */
const PARALLEL_SEGMENTS = 8;
/** 小于该字节数的文件不值得分块（直接用单线程）。 */
const MIN_PARALLEL_SIZE = 8 * 1024 * 1024;
/** 探针大小：单线程先下这么多测速。 */
const PROBE_SIZE = 2 * 1024 * 1024;
/** 探针测速阈值（bytes/ms）：低于它认为慢网络，切多线程。300KB/s = 0.3。 */
const SLOW_SPEED_THRESHOLD = 0.3;

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

/** 合并多个分段文件为一个目标文件（顺序拼接后统一结束）。 */
async function mergeParts(partFiles, dest) {
  const { createReadStream } = await import('node:fs');
  const out = createWriteStream(dest);
  try {
    for (const f of partFiles) {
      await new Promise((resolve, reject) => {
        const rs = createReadStream(f);
        rs.on('error', reject);
        rs.pipe(out, { end: false });
        rs.on('end', resolve);
      });
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
}

/**
 * 下载文件到 dest（自适应）：
 * 1. 服务器不支持 Range 或文件小 → 单线程；
 * 2. 单线程下载探针（PROBE_SIZE）测速——速度够快 → 继续单线程（多线程在部分网络/
 *    服务器上反而更慢，如 GitHub CDN 并发限速）；
 * 3. 探针速度低于阈值（典型慢网络，如 Windows 用户官方源 ~200KB/s）→ 丢弃探针，
 *    改 8 段并发分块（可把 200KB/s 拉到 1.6MB/s）。
 * 返回实际下载字节数。
 */
export async function downloadFile(url, dest, { signal, segments = PARALLEL_SEGMENTS } = {}) {
  // HEAD 探测：Content-Length + Accept-Ranges
  let head = null;
  try { head = await fetch(url, { method: 'HEAD', signal }); } catch { head = null; }
  const len = head ? Number(head.headers.get('content-length') || 0) : 0;
  const acceptsRanges = head ? String(head.headers.get('accept-ranges') || '').toLowerCase() === 'bytes' : false;

  if (!head || !acceptsRanges || len < MIN_PARALLEL_SIZE) {
    // 单线程
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return len || 0;
  }

  // 探针测速：单线程下载前 PROBE_SIZE，计时
  const probeBytes = Math.min(PROBE_SIZE, len);
  const probeStart = Date.now();
  try {
    const probeRes = await fetch(url, { signal, headers: { Range: `bytes=0-${probeBytes - 1}` } });
    if (!probeRes.ok) throw new Error(`HTTP ${probeRes.status} (probe)`);
    const probeBody = await probeRes.arrayBuffer();
    const probeMs = Date.now() - probeStart;
    const probeSpeed = probeMs > 0 ? probeBytes / probeMs : Infinity; // bytes/ms
    if (probeMs < 500 || probeSpeed >= SLOW_SPEED_THRESHOLD) {
      // 够快 → 单线程下完剩余部分（探针字节已拿到，写入 dest）
      const { createWriteStream, createReadStream } = await import('node:fs');
      const w = createWriteStream(dest);
      await new Promise((resolve, reject) => {
        w.on('error', reject);
        w.write(Buffer.from(probeBody));
        w.end(resolve);
      });
      const restRes = await fetch(url, { signal, headers: { Range: `bytes=${probeBytes}-${len - 1}` } });
      if (!restRes.ok) throw new Error(`HTTP ${restRes.status} (rest)`);
      await pipeline(Readable.fromWeb(restRes.body), createWriteStream(dest, { flags: 'a' }));
      return len;
    }
    // 慢 → 丢弃探针，转分块并发（从 0 开始全量分块）
    await rm(dest, { force: true }).catch(() => {});
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    if (!/HTTP|fetch/i.test(String(err?.message ?? ''))) throw err; // 探针网络异常 → 抛给上层换源
    // 探针 HTTP 错误（部分服务器 HEAD 与 GET 行为不一致）→ 直接分块
  }

  // 分块并发
  const parts = [];
  const chunk = Math.ceil(len / segments);
  for (let i = 0; i < segments; i++) {
    const start = i * chunk;
    const end = i === segments - 1 ? len - 1 : Math.min(start + chunk - 1, len - 1);
    if (start > end) break;
    parts.push({ start, end, file: `${dest}.part${i}` });
  }
  try {
    await Promise.all(parts.map(async (p) => {
      const res = await fetch(url, { signal, headers: { Range: `bytes=${p.start}-${p.end}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} (range ${p.start}-${p.end})`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(p.file));
    }));
    await mergeParts(parts.map((p) => p.file), dest);
  } finally {
    await Promise.all(parts.map((p) => rm(p.file, { force: true }).catch(() => {})));
  }
  return len;
}

/**
 * 清华 TUNA 镜像的 cloudflared Homebrew bottle URL（国内 CDN，实测 ~3MB/s）。
 * **仅 macOS**——Linux 的 Homebrew bottle 其 ELF 解释器是 `@@HOMEBREW_PREFIX@@`
 * 占位符（需 brew install 时 patchelf 替换），没装 Homebrew 的机器直接 spawn 会
 * ENOENT（issue #22）；Linux 走官方 GitHub 裸二进制（无需解压）+ 加速源。
 * 匹配按 CPU 架构取清华目录里版本号最新的 bottle——Homebrew 构建时部署目标
 * 设得较老、向后兼容，所以旧系统（如 Ventura）也能用新一点的 bottle。
 * 抓目录失败/无匹配 → null（调用方回退 GitHub/加速源，不影响可用性）。
 */
async function tsinghuaBottleUrl({ os, a }) {
  if (os !== 'darwin') return null;
  let res;
  try {
    res = await fetch(TUNA_BOTTLES, { signal: AbortSignal.timeout(20_000) });
  } catch { return null; }
  if (!res.ok) return null;
  let html;
  try { html = await res.text(); } catch { return null; }
  // macOS: arm64_<代号> 或 <代号>（Intel 无前缀），代号白名单排除 linux；Linux: arm64_linux / x86_64_linux
  const MACOS_CODES = 'monterey|ventura|sonoma|sequoia|tahoe';
  const pattern = os === 'darwin'
    ? new RegExp(`cloudflared-([0-9.]+)\\.${a === 'arm64' ? 'arm64_' : ''}(${MACOS_CODES})\\.bottle\\.tar\\.gz`, 'g')
    : new RegExp(`cloudflared-([0-9.]+)\\.${a === 'arm64' ? 'arm64' : 'x86_64'}_linux\\.bottle\\.tar\\.gz`, 'g');
  let best = null;
  let bestV = '';
  for (const m of html.matchAll(pattern)) {
    if (m[1] > bestV) { bestV = m[1]; best = m[0]; }
  }
  return best ? `${TUNA_BOTTLES}${best}` : null;
}

async function downloadCloudflared(binPath, signal) {
  const { os, a, ext } = platformBinary();
  const dir = dirname(binPath);
  const tmpFile = join(dir, `cloudflared.download`);
  const isWindows = os === 'windows';
  const fetchSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    : AbortSignal.timeout(120_000);

  // 源的顺序按平台定（issue #45）：
  // - macOS：清华 Homebrew bottle 排第一（国内 CDN 实测 ~3MB/s，给家用网络省几分钟），
  //   拿不到再退回官方源 + 国内加速源。
  // - Linux / Windows：不走 bottle，直接官方源优先。这两类环境网络差异太大
  //   （服务器、容器、 corporate 网络），多一层镜像就多一层失败模式；官方源
  //   拿不到时，再用国内加速源兜底。
  // bottle 与资产名无关，只算一次。
  const bottle = os === 'darwin' ? await tsinghuaBottleUrl({ os, a }).catch(() => null) : null;

  // 逐个资产试（linux 首选裸二进制，.tgz 只是回退），每个资产再逐个源试
  const assets = platformAssets();
  let lastErr = null;
  let usedAsset = null;

  for (let ai = 0; ai < assets.length && usedAsset === null; ai++) {
    const asset = assets[ai];
    const sources = [];
    if (bottle && asset.endsWith('.tgz')) {
      sources.push({ url: bottle, host: 'mirrors.tuna.tsinghua.edu.cn' });
    }
    for (const m of CLOUDFLARED_MIRRORS) sources.push({ url: m(asset), host: hostOf(m(asset)) });

    for (let i = 0; i < sources.length; i++) {
      const { url, host } = sources[i];
      console.log(`⬇️  下载 cloudflared（${asset}，源 ${i + 1}/${sources.length}：${host}）…`);
      try {
        // 多线程分块（官方 GitHub 支持 Range，Windows 50MB 从几分钟降到几十秒）；
        // 不支持 Range 的源自动回退单线程
        await downloadFile(url, tmpFile, { signal: fetchSignal });
        // 简单校验：空文件/极小文件视为下载失败（可能是镜像返回了错误页）
        const st = await stat(tmpFile);
        if (st.size < 1024 * 1024) throw new Error(`文件异常小（${st.size} 字节），疑似镜像错误页`);
        usedAsset = asset;
        lastErr = null;
        break; // 下载成功
      } catch (err) {
        lastErr = err;
        await rm(tmpFile, { force: true }).catch(() => {}); // 清掉半截文件
        console.warn(`  ⚠️ 源 ${i + 1} 失败：${err?.message ?? err}，尝试下一个…`);
      }
    }
  }
  if (usedAsset === null) {
    throw new Error(
      `cloudflared 下载失败：所有源都不通（最后错误：${lastErr?.message ?? lastErr}）。`
      + (isWindows
        ? `Windows 可手动安装后重试：winget install cloudflared；或下载 ${assets[0]} 放到 ${dir} 目录 | download failed — try: winget install cloudflared, or put the exe into ${dir}`
        : `也可以自己装好后在 settings.json 写 "cloudflaredPath": "/path/to/cloudflared" 跳过下载（或用环境变量 DSH_POCKET_CLOUDFLARED）；或用包管理器安装：apt/dnf install cloudflared | all mirrors failed — install cloudflared manually and set "cloudflaredPath" in settings.json, or: apt/dnf install cloudflared`),
    );
  }

  let extracted = join(dir, `cloudflared${ext}`);
  // 只有 .tgz 才需要解压：Windows 的 .exe 和 linux 的裸二进制本身就可直接执行
  // （linux 用裸二进制还有个好处——不依赖系统装了 tar，见 platformAssets 的说明）
  if (!usedAsset.endsWith('.tgz')) {
    await rename(tmpFile, extracted).catch(async () => {
      await cp(tmpFile, extracted).catch(() => {});
    });
  } else {
    // 解压到独立临时子目录（bottle 解压产物会占用 cacheDir/cloudflared 这个名字，
    // 直接解压到 dir 会让目标路径变成目录，rename 失败）
    const extractDir = join(dir, `.extract-${process.pid}-${Date.now()}`);
    await mkdir(extractDir, { recursive: true });
    try {
      await new Promise((resolve, reject) => {
        const child = spawn('tar', ['-xzf', tmpFile, '-C', extractDir], { stdio: 'ignore' });
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`cloudflared 解压失败（code=${code}）`)));
        // spawn 失败（Alpine / slim 镜像 / 容器里常见：根本没有 tar）时 err.code 是
        // ENOENT，直接抛出来只有一句 "spawn tar ENOENT"，看不出该怎么办
        child.once('error', (err) => reject(
          err?.code === 'ENOENT'
            ? new Error(`系统里没有 tar 命令，无法解压 ${usedAsset} —— 可改用 linux 裸二进制（默认已如此）或手动安装后设置 cloudflaredPath | no tar on this system`)
            : err,
        ));
      });
      // 找真实的二进制**文件**（排除目录）：
      // - GitHub tgz：extractDir/cloudflared
      // - Homebrew bottle（清华）：extractDir/cloudflared/<版本>/bin/cloudflared
      const { readdir } = await import('node:fs/promises');
      let found = null;
      const direct = join(extractDir, `cloudflared${ext}`);
      try { if ((await stat(direct)).isFile()) found = direct; } catch { /* 不存在 */ }
      if (!found) {
        const verDir = join(extractDir, 'cloudflared');
        try {
          const vers = await readdir(verDir);
          for (const v of vers) {
            const bin = join(verDir, v, 'bin', `cloudflared${ext}`);
            try { if ((await stat(bin)).isFile()) { found = bin; break; } } catch { /* 继续 */ }
          }
        } catch { /* 无此目录 */ }
      }
      if (!found) throw new Error('cloudflared 解压成功但未找到二进制 | binary not found after extract');
      if (found !== extracted) {
        await rename(found, extracted).catch(async () => { await cp(found, extracted).catch(() => {}); });
      }
    } finally {
      await rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!isWindows) await chmod(extracted, 0o755);
  // 解压/搬移完成就删掉临时下载文件，避免长期占用缓存目录
  await rm(tmpFile, { force: true }).catch(() => {});
  return extracted;
}

/** PATH 里是否已有 cloudflared。 */
function cloudflaredOnPath() {
  try {
    execSync(process.platform === 'win32' ? 'where cloudflared' : 'command -v cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** in-flight 下载（单飞）：并发调用复用同一次，防止交错写入损坏 tgz。 */
let downloading = null;

/**
 * 拿一个可用的 cloudflared 路径。
 * 优先：PATH 已有 → 直接用；否则用持久缓存（$DSH_HOME/dsh-pocket/cloudflared），
 * 只有缓存缺失才下载——避免每次开启公网都重新下 20MB。
 */
export { tsinghuaBottleUrl };

export async function resolveCloudflared({ home, onPhase = () => {}, signal } = {}) {
  // 自定义路径（issue #45）：用户可能在 settings.json 写了 cloudflaredPath，
  // 或者在外部注入 process.env.DSH_POCKET_CLOUDFLARED；命中就直接用，绕过
  // PATH 探测与下载（远程 Linux 服务器上下载源不可达时的兜底）。
  const explicit = process.env.DSH_POCKET_CLOUDFLARED;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(
        `DSH_POCKET_CLOUDFLARED 指向的路径不可执行：${explicit} | cloudflaredPath is set but not accessible: ${explicit}`,
      );
    }
  }
  if (cloudflaredOnPath()) return 'cloudflared';
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const cacheDir = join(dshHome, 'dsh-pocket', 'bin');
  const { os, a, ext } = platformBinary();
  // 缓存命中，兼容两种文件名（issue #15）：
  // 1) 本插件下载时写入的 bin 名：cloudflared.exe
  // 2) 手动放置的**发布资产名**：cloudflared-windows-amd64.exe（与下载失败的错误提示一致）
  const candidates = [
    join(cacheDir, `cloudflared${ext}`),
    join(cacheDir, `cloudflared-${os}-${a}${ext}`),
  ];
  for (const bin of candidates) {
    try {
      await access(bin);
      // Linux：识别并丢弃 Homebrew bottle 坏缓存（issue #22）——其 ELF 解释器是
      // @@HOMEBREW_PREFIX@@ 占位符，直接 spawn 报 ENOENT；读文件头（解释器路径在
      // ELF 头部附近）即可识别，命中则删掉走重新下载
      if (os === 'linux') {
        try {
          const fd = await open(bin, 'r');
          const head = Buffer.alloc(8192);
          await fd.read(head, 0, 8192, 0);
          await fd.close();
          if (head.includes('@@HOMEBREW_PREFIX@@')) {
            await rm(bin, { force: true }).catch(() => {});
            console.warn('dsh-pocket: discarding unusable Homebrew-bottle cloudflared cache | 丢弃不可用的 Homebrew bottle 缓存，重新下载');
            continue;
          }
        } catch { /* 读失败按正常缓存处理 */ }
      }
      return bin; // 缓存命中，秒开
    } catch { /* 继续找下一个 */ }
  }
  onPhase('downloading');
  await mkdir(cacheDir, { recursive: true });
  if (!downloading) {
    downloading = downloadCloudflared(join(cacheDir, `cloudflared${ext}`), signal).finally(() => { downloading = null; });
  }
  return downloading;
}

/**
 * 启动 cloudflared 快速隧道，返回公网 URL。
 * @param {object} opts
 * @param {number} opts.port  本机代理端口
 * @param {string} [opts.home] $DSH_HOME（cloudflared 持久缓存）
 * @param {AbortSignal} [opts.signal]
 * @param {(phase:string)=>void} [opts.onPhase] 进度回调：downloading→starting→registering→ready
 * @returns {Promise<{url:string, kill:()=>void}>}
 */
/**
 * 启动 cloudflared 命名隧道（issue #66：固定公网域名）。
 *
 * 用户在 Cloudflare Zero Trust 后台创建 Tunnel、把域名 ingress 的 Service 指向
 * `http://127.0.0.1:<port>`，复制 Tunnel Token 填进设置页。与快速隧道的区别：
 *   - Token 走 `TUNNEL_TOKEN` **环境变量**（不进 argv——长期凭据不该出现在
 *     进程列表/崩溃日志里，issue #66 讨论中的一致意见）；
 *   - URL 固定为用户绑定的域名（cloudflared 输出不打印它），由调用方拼 `https://<域名>`，
 *     所以这里返回 `url: null`；
 *   - 就绪判据是 stderr 出现 `Registered tunnel connection`（边缘连接注册成功即开始服务）。
 * @param {object} opts
 * @param {string} opts.token    Cloudflare Tunnel Token
 * @param {string} [opts.home]   $DSH_HOME（cloudflared 持久缓存）
 * @param {AbortSignal} [opts.signal]
 * @param {(phase:string)=>void} [opts.onPhase] 进度回调：downloading→starting→registering→ready
 * @returns {Promise<{url:null, kill:()=>void, onExit:(cb)=>()=>void}>}
 */
export async function startNamedTunnel({ token, home, signal, onPhase = () => {} }) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  // 与快速隧道一致强制 HTTP/2（国内/企业网常屏蔽 UDP 7844 → error 1033）
  // 与快速隧道一致强制 HTTP/2（国内/企业网常屏蔽 UDP 7844 → error 1033）
  // `--no-autoupdate` 必须在全局位置（子命令之前）：cloudflared 2026.x 移除了
  // `tunnel run` 子命令层级的该 flag，但全局位置仍有效（issue #78）
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', 'run', '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TUNNEL_TOKEN: String(token ?? '') },
  });
  let cleanup = null;
  let rejectErr = null;
  // H1：spawn 失败（缓存二进制损坏等）必须接住，否则 uncaughtException 崩宿主
  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}（可删除 $DSH_HOME/dsh-pocket/bin 缓存后重试）`));
  });
  onPhase('registering');

  await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      // 边缘连接注册成功即开始服务（每条连接一行；等第一条就够）
      if (/Registered tunnel connection/i.test(buf)) {
        cleanup();
        onPhase('ready');
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(
        `cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}——请检查 Tunnel Token 是否有效、域名 Service 是否指向本机代理端口 | `
        + `tunnel exited (code=${code})${tail ? ': ' + tail : ''} — check the Tunnel Token and the ingress hostname`,
      ));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // M4：摘掉监听后管道不再消费 → 64KB 缓冲填满会阻塞 cloudflared → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        'cloudflared 启动超时（30s）——请检查 Tunnel Token 是否有效、域名 Service 是否指向本机代理端口，'
        + '以及是否开着代理/VPN（Clash 等 TUN 模式会掐断隧道连接） | timeout — check the token, the ingress hostname, and quit any proxy/VPN (TUN mode)',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  // M1：隧道进程运行中死亡（崩溃/被杀）→ 通知监听方（service 据此把状态从 ready 打回）
  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url: null, // 固定域名由调用方（service）按设置拼 https://<hostname>
    kill: () => {
      try { child.kill(); } catch { /* 忽略 */ }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}

export async function startQuickTunnel({ port, home, signal, onPhase = () => {} }) {
  const bin = await resolveCloudflared({ home, onPhase, signal });
  onPhase('starting');
  // 强制 HTTP/2（TCP 443）而不是默认的 QUIC（UDP 7844）：
  // 国内网络/部分企业网常屏蔽 UDP 7844，导致 tunnel 报 error 1033（Tunnel error）；
  // HTTP/2 走 443 更稳。若平台未来恢复 QUIC 可达，可去掉 --protocol http2。
  // `--no-autoupdate` 必须在全局位置（子命令之前，见 issue #78 同款修复）
  const child = spawn(bin, ['--no-autoupdate', 'tunnel', '--url', `http://127.0.0.1:${port}`, '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // H1：spawn 失败（缓存二进制损坏等）必须接住，否则 uncaughtException 崩宿主
  child.on('error', (err) => {
    cleanup?.();
    onPhase?.('error');
    rejectErr?.(new Error(`cloudflared 启动失败：${err?.message ?? err}（可删除 $DSH_HOME/dsh-pocket/bin 缓存后重试）`));
  });
  onPhase('registering');

  let cleanup = null;
  let rejectErr = null;
  const url = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += String(chunk);
      const m = buf.match(QUICK_TUNNEL_URL_RE);
      if (m) {
        cleanup();
        onPhase('ready');
        resolve(m[0]);
      }
    };
    const onExit = (code) => {
      cleanup();
      // 带上 cloudflared 自己的输出（参数错误显示开头、运行期错误显示尾部，见 firstMeaningfulErrorLine），
      // 否则「code=1」用户无从排查（issue #65 / #78）
      const tail = firstMeaningfulErrorLine(buf);
      reject(new Error(`cloudflared 退出（code=${code}）${tail ? '：' + tail : ''}`));
    };
    cleanup = () => {
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // M4：摘掉监听后管道不再消费 → 64KB 缓冲填满会阻塞 cloudflared → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    const onAbort = () => {
      cleanup();
      child.kill();
      reject(new Error('已取消 | cancelled'));
    };
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(
        'cloudflared 启动超时（30s）——请检查是否开着代理/VPN（Clash 等 TUN 模式会掐断隧道连接），退出代理后重试 | '
        + 'timeout — if you run a proxy/VPN (Clash etc., TUN mode), it can block the tunnel; quit it and retry',
      ));
    }, 30_000);

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    rejectErr = reject;
  });

  // M1：隧道进程运行中死亡（崩溃/被杀）→ 通知监听方（service 据此把状态从 ready 打回）
  const exitListeners = new Set();
  child.on('exit', (code) => {
    for (const cb of exitListeners) cb(code);
  });

  return {
    url,
    kill: () => {
      try { child.kill(); } catch { /* 忽略 */ }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}

// ---------- frp 隧道（自建 frps：第三条公网路径） ----------
//
// 与 cloudflared 两条路径并列：连用户自己的 frps，TCP 转发本机代理端口，公网地址固定为
// http://<server>:<remotePort>。**明文 HTTP** —— 访问控制完全靠代理的公网密码
// （公网 Host 一律 fail closed，见 lib/index.js tokenForHost），所以本模式不支持免密。
//
// frpc 与 cloudflared 同构地「PATH 探测 → 持久缓存 → 下载」，另留 settings.json 的
// frpcPath 与 DSH_POCKET_FRPC 环境变量作为逃生口（下载源不可达时手动放一个）。
// token 只写配置文件（0o600）、不进 argv —— 与 issue #66 对 Tunnel Token 的立场一致。

/**
 * frp 回退版本（GitHub API 取 latest 失败时用；实测服务器 frps 0.71.0）。
 * **必须带 v 前缀**：release 的下载路径用的是 tag（`.../download/v0.71.0/...`），
 * 少了 v 会 404 —— 资产名里的版本号才不带 v（见 frpAssets）。
 */
const FRP_FALLBACK_VERSION = 'v0.71.0';

/** frp 下载源（官方 + 国内加速，与 cloudflared 的兜底思路一致）。 */
const FRP_MIRRORS = [
  (tag, asset) => `https://github.com/fatedier/frp/releases/download/${tag}/${asset}`,
  (tag, asset) => `https://ghproxy.net/https://github.com/fatedier/frp/releases/download/${tag}/${asset}`,
  (tag, asset) => `https://gh.ddlc.top/https://github.com/fatedier/frp/releases/download/${tag}/${asset}`,
  (tag, asset) => `https://gh-proxy.com/https://github.com/fatedier/frp/releases/download/${tag}/${asset}`,
];

/**
 * 平台对应的 frp 发布资产名（同 issue #45 的教训：资产名按平台拼，别猜）。
 * 实测 fatedier/frp v0.71.0：windows 只有 .zip，linux / darwin 只有 .tar.gz。
 * @param {string} version 版本号（可带 v 前缀）
 * @returns {string[]} 候选资产名
 */
export function frpAssets(version) {
  const { os, a } = platformBinary();
  const v = String(version ?? '').replace(/^v/, '');
  if (os === 'windows') return [`frp_${v}_windows_${a}.zip`];
  if (os === 'darwin') return [`frp_${v}_darwin_${a}.tar.gz`];
  return [`frp_${v}_linux_${a}.tar.gz`];
}

/** 取 fatedier/frp 最新 release 版本号；失败回退 FRP_FALLBACK_VERSION（不阻断下载）。 */
async function frpLatestVersion(signal) {
  try {
    const res = await fetch('https://api.github.com/repos/fatedier/frp/releases/latest', {
      headers: { 'user-agent': 'dsh-pocket' },
      signal: signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tag = (await res.json())?.tag_name;
    // 返回值带 v 前缀：下载路径用 tag，资产名里的版本号才去掉 v（frpAssets 负责）。
    if (typeof tag === 'string' && /^v?\d+\.\d+\.\d+$/.test(tag)) return tag.startsWith('v') ? tag : `v${tag}`;
  } catch { /* 回退到已知版本 */ }
  return FRP_FALLBACK_VERSION;
}

/**
 * 解压 frp 资产，把 frpc 放到 destBin。
 * Windows 资产是 zip：系统自带的 C:\WINDOWS\system32\tar.exe 是 bsdtar，能解 zip；
 * 万一环境里是 GNU tar（解不了 zip），回退 PowerShell 的 Expand-Archive。
 */
async function extractFrpc(archive, destBin, { isZip } = {}) {
  const { ext } = platformBinary();
  const extractDir = join(dirname(destBin), `.extract-frp-${process.pid}-${Date.now()}`);
  await mkdir(extractDir, { recursive: true });
  try {
    await new Promise((resolve, reject) => {
      // -xf 自动识别格式（bsdtar 同时支持 tar.gz 与 zip）
      const child = spawn('tar', ['-xf', archive, '-C', extractDir], { stdio: 'ignore' });
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 解压失败（code=${code}）`))));
      child.once('error', reject);
    }).catch(async (err) => {
      if (!isZip || process.platform !== 'win32') throw err;
      const esc = (s) => String(s).replace(/'/g, "''");
      await new Promise((resolve, reject) => {
        const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${esc(archive)}' -DestinationPath '${esc(extractDir)}' -Force`], { stdio: 'ignore' });
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Expand-Archive 失败（code=${code}）`))));
        child.once('error', reject);
      });
    });

    // 资产解出来多一层目录：frp_<ver>_<os>_<arch>/frpc[.exe]
    const { readdir } = await import('node:fs/promises');
    let found = null;
    for (const entry of await readdir(extractDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === `frpc${ext}`) { found = join(extractDir, entry.name); break; }
      if (entry.isDirectory()) {
        const inner = join(extractDir, entry.name, `frpc${ext}`);
        try { if ((await stat(inner)).isFile()) { found = inner; break; } } catch { /* 继续找 */ }
      }
    }
    if (!found) throw new Error('frpc 解压后未找到二进制 | frpc binary not found after extract');
    await rename(found, destBin).catch(async () => { await cp(found, destBin).catch(() => {}); });
  } finally {
    await rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 下载 frpc 到 binPath（复用 downloadFile 的多线程分块，与 cloudflared 同一套）。 */
async function downloadFrpc(binPath, signal) {
  const { os, ext } = platformBinary();
  const dir = dirname(binPath);
  const tmp = join(dir, 'frp.download');
  // 每个源单独计时：github 直连在国内常挂死，若所有源共用一个超时预算，
  // 第一个源超时后其余镜像会立刻跟着 abort，等于没有回退。
  const attemptSignal = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000));
  const version = await frpLatestVersion(signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000));
  let lastErr = null;

  for (const asset of frpAssets(version)) {
    for (let i = 0; i < FRP_MIRRORS.length; i++) {
      const url = FRP_MIRRORS[i](version, asset);
      console.log(`⬇️  下载 frpc（${asset}，源 ${i + 1}/${FRP_MIRRORS.length}：${hostOf(url)}）…`);
      try {
        await downloadFile(url, tmp, { signal: attemptSignal() });
        const st = await stat(tmp);
        // 镜像常回一个 200 的错误页：体积明显不对就别浪费时间解压
        if (st.size < 512 * 1024) throw new Error(`文件异常小（${st.size} 字节），疑似镜像错误页`);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await rm(tmp, { force: true }).catch(() => {});
        console.warn(`  ⚠️ 源 ${i + 1} 失败：${err?.message ?? err}，尝试下一个…`);
      }
    }
    if (lastErr === null) {
      try {
        await extractFrpc(tmp, binPath, { isZip: asset.endsWith('.zip') });
        if (os !== 'windows') await chmod(binPath, 0o755);
        return binPath;
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
  }
  throw new Error(
    `frpc 下载失败：所有源都不通（最后错误：${lastErr?.message ?? lastErr}）。`
    + `可手动下载 frp（${version}）后把 frpc${ext} 放到 ${dir}，或在 settings.json 写 "frpcPath" `
    + `| frpc download failed — put frpc${ext} into ${dir}, or set "frpcPath" in settings.json`,
  );
}

/** in-flight frpc 下载（单飞）：并发调用复用同一次，避免交错写同一个缓存文件。 */
let downloadingFrpc = null;

/**
 * 拿一个可用的 frpc 路径：
 * DSH_POCKET_FRPC（frpcPath 设置）→ PATH → 持久缓存 → 下载。
 */
export async function resolveFrpc({ home, onPhase = () => {}, signal } = {}) {
  const explicit = process.env.DSH_POCKET_FRPC;
  if (explicit) {
    try {
      await access(explicit);
      return explicit;
    } catch {
      throw new Error(`frpcPath 指向的路径不可执行：${explicit} | frpcPath is set but not accessible: ${explicit}`);
    }
  }
  try {
    execSync(process.platform === 'win32' ? 'where frpc' : 'command -v frpc', { stdio: 'ignore' });
    return 'frpc';
  } catch { /* PATH 里没有 → 走缓存/下载 */ }
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const cacheDir = join(dshHome, 'dsh-pocket', 'bin');
  const { os, a, ext } = platformBinary();
  for (const bin of [join(cacheDir, `frpc${ext}`), join(cacheDir, `frpc-${os}-${a}${ext}`)]) {
    try {
      await access(bin);
      return bin;
    } catch { /* 继续找下一个 */ }
  }
  onPhase('downloading');
  await mkdir(cacheDir, { recursive: true });
  if (!downloadingFrpc) {
    downloadingFrpc = downloadFrpc(join(cacheDir, `frpc${ext}`), signal).finally(() => { downloadingFrpc = null; });
  }
  return downloadingFrpc;
}

/**
 * 生成 frpc.toml（frp v0.52+ 的 TOML 格式）。
 * token 只写文件（0o600）、不进 argv —— 进程列表与崩溃日志里不该出现长期凭据。
 */
export function frpConfigToml({ server, serverPort = 7000, token = '', remotePort, localPort, tls = true, protocol = 'tcp', compress = true }) {
  const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [
    `serverAddr = ${q(server)}`,
    `serverPort = ${Number(serverPort)}`,
  ];
  if (token) lines.push('auth.method = "token"', `auth.token = ${q(token)}`);
  // transport.* 必须排在 [[proxies]] **之前**：写在后面 TOML 会把它归进 proxy 表，
  // frpc 报 `unmarshal ProxyConfig error: json: unknown field "protocol"`（实测）。
  // quic/kcp 自带加密（kcp 不支持 tls），只有 tcp 才写 transport.tls.enable。
  if (protocol === 'quic' || protocol === 'kcp') lines.push(`transport.protocol = ${q(protocol)}`);
  else if (tls) lines.push('transport.tls.enable = true');
  lines.push(
    '',
    '[[proxies]]',
    'name = "dsh-pocket"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${Number(localPort)}`,
    `remotePort = ${Number(remotePort)}`,
    '',
  );
  // 隧道压缩（snappy）必须写在 [[proxies]] 表里：这是**每个代理**的 transport 选项
  // （frp 的 ProxyTransport），写到顶层 transport 会被 frpc 判 `json: unknown field
  // "useCompression"` 直接启动失败（frpc 0.71 实测，`frpc verify` 验过）。
  // 公网隧道按流量计费，而 DSH 的会话数据与图片 base64 全在 WS 里，本代理只压 HTTP
  // （gzip/br），WS 一路是明文 JSON —— 这是唯一能压到它的地方。
  if (compress) lines.push('transport.useCompression = true');
  return lines.join('\n');
}

/**
 * 启动 frpc，把本机代理端口经 frps 暴露成 http://<server>:<remotePort>。
 *
 * 就绪判据：frpc 输出出现 `start proxy success`（登录 + 代理注册都成功）。
 * `login to server failed` 视为**立即失败**（token 不一致 / 端口不通）：用户要的是
 * 一句能排查的话，不是干等 30 秒超时。
 *
 * @param {object} opts
 * @param {string} opts.server       frps 地址（IP 或域名）
 * @param {number} [opts.serverPort] frps 监听端口（默认 7000）
 * @param {string} [opts.token]      frps auth.token（服务器未开 auth 时可空）
 * @param {number} opts.remotePort   服务器上暴露的端口
 * @param {number} opts.localPort    本机代理端口
 * @param {boolean} [opts.tls]       是否加密 frpc→frps 这一跳（默认 true；仅 tcp 协议有效）
 * @param {string} [opts.protocol]   传输协议：'tcp'（默认）| 'quic' | 'kcp'
 * @param {string} [opts.home]       $DSH_HOME（frpc 缓存 + frpc.toml 落盘目录）
 * @param {AbortSignal} [opts.signal]
 * @param {(phase: string) => void} [opts.onPhase] downloading → starting → registering → ready
 * @returns {Promise<{url: string, kill: () => void, onExit: (cb: (code: number) => void) => () => void}>}
 */
export async function startFrpTunnel({
  server,
  serverPort = 7000,
  token = '',
  remotePort,
  localPort,
  tls = true,
  protocol = 'tcp',
  compress = true,
  home,
  signal,
  onPhase = () => {},
}) {
  if (!server) throw new Error('frp 未配置服务器地址 | frp server address is not set');
  if (!remotePort) throw new Error('frp 未配置远程端口 | frp remote port is not set');
  const bin = await resolveFrpc({ home, onPhase, signal });
  onPhase('starting');
  const dshHome = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const cfgPath = join(dshHome, 'dsh-pocket', 'frpc.toml');
  await mkdir(dirname(cfgPath), { recursive: true });
  await writeFile(cfgPath, frpConfigToml({ server, serverPort, token, remotePort, localPort, tls, protocol, compress }), { mode: 0o600 });

  const child = spawn(bin, ['-c', cfgPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let cleanup = () => {};
  let rejectSpawn = null;
  child.on('error', (err) => {
    cleanup();
    rejectSpawn?.(new Error(`frpc 启动失败：${err?.message ?? err} | failed to spawn frpc: ${err?.message ?? err}`));
  });
  onPhase('registering');

  await new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; cleanup(); reject(err); };
    const onData = (chunk) => {
      buf += String(chunk);
      if (buf.length > 64_000) buf = buf.slice(-32_000);
      if (settled) return;
      if (/start proxy success/i.test(buf)) {
        settled = true;
        cleanup();
        onPhase('ready');
        resolve();
        return;
      }
      // token 不一致 / 端口不通：立刻失败（frps 侧会回 token in login doesn't match）
      if (/login to server failed|token in login doesn't match/i.test(buf)) {
        const tail = firstMeaningfulErrorLine(buf);
        child.kill();
        fail(new Error(
          `frpc 登录 frps 失败${tail ? `：${tail}` : ''}——请检查 frp token 与服务器 frps.toml 的 auth.token 是否一致、`
          + `${server}:${serverPort} 是否可达 | frpc login failed — check the frp token and the server address`,
        ));
      }
    };
    const onExit = (code) => {
      const tail = firstMeaningfulErrorLine(buf);
      fail(new Error(
        `frpc 退出（code=${code}）${tail ? `：${tail}` : ''}——请检查 frp token、服务器地址，以及远程端口 ${remotePort} 是否已被占用 `
        + `| frpc exited (code=${code}) — check token, server address and whether remote port ${remotePort} is taken`,
      ));
    };
    const onAbort = () => { child.kill(); fail(new Error('已取消 | cancelled')); };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(
        `frpc 启动超时（30s）——请检查 ${server}:${serverPort} 是否可达、token 是否正确、远程端口 ${remotePort} 是否被占用 | frpc start timed out`,
      ));
    }, 30_000);
    cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      // 摘掉监听后管道不再被消费会让 frpc 阻塞在写 → 继续吞掉输出
      child.stdout.resume();
      child.stderr.resume();
    };
    rejectSpawn = reject;
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  // 就绪后的进程死亡（崩溃/被杀）→ 交给 service 打回状态
  const exitListeners = new Set();
  child.on('exit', (code) => { for (const cb of exitListeners) cb(code); });

  return {
    url: `http://${server}:${remotePort}`,
    kill: () => {
      try { child.kill(); } catch { /* 忽略 */ }
    },
    /** 注册「进程已退出」回调，返回取消函数。 */
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
  };
}
