# dsh-pocket frp 隧道接入方案

- 状态：已确认，实施中（2026-09-29）
- 形态：**TCP 转发**（`http://<frps>:<remotePort>`），frps 在用户自建服务器 `158.101.29.160`
- 实测服务器：`snowdreamtech/frps:0.71.0-debian`（Docker，`bindPort = 7000`，有 `auth.token`，无 `allowPorts`）
- 远程端口取 **60012**（沿用服务器既有命名习惯：60001 webdav / 60004 nginx dynamic proxy / 60011 frp tunnel），
  Oracle 安全列表已放行（`ocid1.securitylist.oc1.phx.aaaaaaaabfsrcth3mjopbw4uogovduze6nswzc2hmfqdjwyhd4ivlkktw6ma`）
- 前置：frps 已在运行（`158.101.29.160:7000` 实测 OPEN）；frpc 由插件自动下载

## 背景

插件现有两条公网路径：Cloudflare 快速隧道（随机域名）与命名隧道（固定域名）。
两者都依赖 Cloudflare。用户已有自建 frp 服务器，希望第三条路径：**不依赖任何第三方**，
直接把本机代理端口经 frps 转发成公网地址。

## 目标形态

`tunnelMode` 从二选一变三选一：`quick` | `named` | `frp`。三者互斥，语义一致：

- 都复用同一个「公网密码」边界（`classifyHost` fail-closed：非 loopback/私网 Host 一律按公网处理）；
- 都复用同一个状态机（`tunnelState.phase`）、二维码、设置页开关与「记住开关」标记；
- frp 地址固定（IP:端口不变），因此与 named 同等处理：**随 DSH 重启自动恢复、公网 PIN 不自动轮换**。

## 关键决策与理由

1. **不新建通道体系，只加 `tunnelMode` 的第三个取值**：PIN 边界、自动恢复标记
   （`$DSH_HOME/dsh-pocket/tunnel-auto.json`）、状态机、RPC 契约全部现成，改动局限在
   隧道启动分支与设置页。新建一套「frp 通道」会重复上述四件事。
2. **TCP 转发，不做 HTTP 自定义域名/vhost**：TCP 只要 frps 放行一个端口，零额外服务器配置。
   代价是明文 HTTP（靠公网 PIN 保护）。要 HTTPS 需域名 + frps ACME，属于后续可加项（见文末）。
3. **token 只写配置文件，不进 argv**：与 issue #66 对 Cloudflare Tunnel Token 的处理一致 ——
   长期凭据不该出现在进程列表 / 崩溃日志里。配置文件 `$DSH_HOME/dsh-pocket/frpc.toml`，权限 0o600。
4. **frpc 二进制自动下载**：与 cloudflared 完全同构 —— PATH 探测 → `$DSH_HOME/dsh-pocket/bin`
   缓存 → 下载。复用现成的 `downloadFile`（多线程分块 + 单线程探针测速）。解压用系统 `tar`
   （Windows 自带的 `C:\WINDOWS\system32\tar.exe` 是 bsdtar，能解 zip），失败回退 `Expand-Archive`。
   另留 `settings.json` 的 `frpcPath` 与 `DSH_POCKET_FRPC` 环境变量作为逃生口。
5. **就绪判据用 frpc 自己的日志**：`start proxy success`。另外把 `login to server failed`
   当**立即失败**（token 错 / 端口不通）而不是等满 30s 超时 —— 用户看到的是一句能排查的话。
6. **公网 PIN 不轮换**：frp 地址固定，轮换会让手机上保存的链接失效（与 named 同一理由）。
   用户可用「自定义密码」主动更换。

## 实现清单

| 文件 | 改动 |
| --- | --- |
| `lib/tunnel.mjs` | 新增 `resolveFrpc()`、`startFrpTunnel()`、`frpConfigToml()`；资产名按平台拼 `frp_<ver>_<os>_<arch>.zip/tar.gz` |
| `lib/settings.mjs` | 新增 `frpServer` / `frpServerPort` / `frpToken` / `frpRemotePort` / `frpTls` / `frpcPath` |
| `lib/service.mjs` | `startTunnel()` 增加 `mode === 'frp'` 分支；`status()` 的 `tunnelConfig` 增加脱敏 `frp` 视图；进度文案按模式区分 |
| `lib/index.js` | `getTunnelConfig` 带上 frp 字段；`onTunnelReady('frp')` 与 named 同等（不轮换 PIN）；RPC `tunnel.setConfig` 接受 frp 字段；`frpcPath` 写入 env |
| `lib/web-rpc.js` | `tunnel.setConfig` 允许 `mode === 'frp'` |
| `client/api.js` | `redactStatus` 透传 frp 脱敏视图 |
| `client/index.jsx` | 模式按钮 2 → 3；frp 表单（服务器 / 端口 / Token / 远程端口 / TLS 开关） |
| `client/pocket-locales.js` | 新增 zh/en 文案（`test/locales.test.js` 守护对齐） |

### frpc 配置（生成物）

```toml
serverAddr = "158.101.29.160"
serverPort = 7000
auth.method = "token"
auth.token = "<用户填>"
transport.tls.enable = true

[[proxies]]
name = "dsh-pocket"
type = "tcp"
localIP = "127.0.0.1"
localPort = 3081        # 代理实际端口（端口被占时自动 +1，用运行时的值）
remotePort = 60012
```

### 服务器侧（158.101.29.160）

```toml
# frps.toml
bindPort = 7000
auth.method = "token"
auth.token = "<强随机，与插件里填的一致>"
allowPorts = [{ start = 18000, end = 18100 }]   # 建议：限制可映射端口段
```

- 放行要**三处**齐备（实测缺任一处都是「连不上」）：
  1. **VCN 安全列表**：按端口逐条放行，已用 OCI CLI 加
     `frp tunnel 60012 (dsh-pocket)`（TCP 60012 / 0.0.0.0/0），安全列表
     `ocid1.securitylist.oc1.phx.aaaaaaaabfsrcth3mjopbw4uogovduze6nswzc2hmfqdjwyhd4ivlkktw6ma`
  2. **实例内 iptables**：Oracle Linux 镜像默认 `-P INPUT ACCEPT`，无需改
  3. **frps 容器的端口映射**（最容易漏）：本机 frps 是 docker compose 部署
     （`/home/opc/sofaware/frps/docker-compose.yml`，镜像 `snowdreamtech/frps:0.71.0-debian`，
     `restart: unless-stopped`），`remotePort` 只在**容器内**监听 —— compose 的 `ports`
     必须加 `- "60012:60012"`，再 `docker compose up -d` 重建容器
     （改前先 `cp -a docker-compose.yml docker-compose.yml.bak.$(date +%Y%m%d_%H%M%S)`；
     重建只中断数秒，其他 frpc 隧道会自动重连）。
     实测：只加安全列表时外网连 60012 被拒；补上映射后立刻通。
- frps 常驻：本机是 docker compose（`restart: unless-stopped`）；裸机部署则是
  systemd + `frps -c /etc/frp/frps.toml`。

## 安全边界（改动前必读）

- frp 隧道是**明文 HTTP**：浏览器 → frps 明文，frpc → frps 段由 `transport.tls.enable = true` 加密。
  因此公网 PIN **必须**开启，且这是唯一的访问控制 —— 这也是本方案不做「frp 免密」的原因。
- `remotePort` 在服务器上全网可扫：建议 frps 配 `allowPorts` + 强 `auth.token`；
  发现异常访问时改 `remotePort` 即可（插件侧只改一个设置项）。
- 不信任 `x-forwarded-for`（与 upstream 一致）：frp 转发不写它，来源限速按 TCP 源地址。

## 测试

- `test/frp.test.js`（新）：TOML 生成（token 在文件里、argv 里没有）、就绪判据
  （`start proxy success` 才 ready）、`login to server failed` 立即失败、30s 超时、进程退出回调、URL 拼接。
- `test/service.test.js`：`mode === 'frp'` 走 frp 启动、URL 用 frps 地址、失败保留自动恢复标记并重试、
  `onTunnelReady('frp')` 不轮换 PIN。
- `test/settings.test.js`：新键读写、端口范围校验、token 清除、`frpTls` 默认 true。
- `test/locales.test.js`：zh/en key 对齐（既有守护）。
- 真机 e2e：设置页填 frps 信息 → 开公网 → 手机扫码 → 输公网 PIN → 同屏可用。

## 后续可加（不在本次范围）

- **HTTP 自定义域名模式**（`type = "http"` + `customDomains` + frps `vhostHTTPPort`）：可再上
  HTTPS（frps ACME），届时 URL 从 `http://IP:端口` 变成 `https://域名`。
- 多代理（同时暴露 DSH 与其它本地服务）。
- frps 侧的连接状态面板（插件内显示 frpc 的 run id / 在线时长）。

## QUIC 传输协议（可选，抗晚高峰丢包）

- 新设置 `frpProtocol`：`'tcp'`（默认）| `'quic'`。设置页 frp 表单里是「传输协议」下拉框；
  选 quic 时不再显示 TLS 勾选（QUIC 自带 TLS，再开会冲突）。
- **服务端要求**：frps.toml 加 `quicBindPort = 7000`（**必须等于 `bindPort`**：frpc 只用
  `serverPort` 拨号，QUIC 与 TCP 共用同一个端口号、不同协议）；docker-compose.yml 加
  `- "7000:7000/udp"`，OCI 安全列表放行 UDP 7000。少一处 frpc 就停在 `try to connect to server...`。
- 生成 frpc.toml 时 `transport.*` 必须排在 `[[proxies]]` **之前**：写在后面会被 TOML 归进 proxy 表，
  frpc 报 `unmarshal ProxyConfig error: json: unknown field "protocol"`（实测）。评测语法用 `frpc verify -c <file>`。
- 实测（2,242,590 B 原始载荷，服务器本机 curl 经 frps 转发）：tcp+tls 0.632s / 3.55 MB/s，
  quic 0.803s / 2.79 MB/s；gzip 后 43,621 B 两者都是 0.180s。**链路好时 TCP 更快**，QUIC 的价值在丢包时（晚高峰）。
- 不提供 kcp：frp 里属遗留协议，且 frps 的 `kcpBindPort` 会与 `quicBindPort` 抢同一个 UDP 端口。
