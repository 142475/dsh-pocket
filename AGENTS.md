# AGENTS.md — dsh-pocket（本地分支）

本仓库是 `shaobeichen/dsh-pocket` 的 fork，**基线 = 上游 v2.13.1**，本地只多一条自研功能：**自建 frp 通道**。

## 与上游的关系（改之前必读）

- 合并上游时按 **「上游为准」**：冲突一律取上游实现；上游已有等价功能的本地实现一律丢弃。
- **唯一保留的本地功能是 frp**（`lib/tunnel.mjs` 的 `startFrpTunnel` / `frpConfigToml` / `frpAssets`，
  `lib/settings.mjs` 的 `frpServer`/`frpServerPort`/`frpRemotePort`/`frpTls`/`frpProtocol`，
  `lib/index.js` 的 `tunnelMode==='frp'` 分支与配网提示，`client/index.jsx` 的 frp 表单）。
- 已经放弃、**不要再加回来**：流量字节计量（`METRICS_PATH`）、Safari 16 polyfill（`withResolvers`）、
  登录 PIN 预填（`dsh_pocket_pin`）、文件守卫（上游 #197 已删）、自定义静态缓存头。
- 移动端 z-index / centerCol 两处修复已由上游 #191、#200 覆盖，不要重复实现。

## 本地开发三件事

1. 跑测试：`node --test test/*.test.js`（**不能**只给目录，会 `MODULE_NOT_FOUND`）。
2. 改了 `client/**` 必须 `node client/build.mjs` 重构建，**并把 `client/client.js` 一起提交**（宿主加载的是产物）。
3. 改了 `lib/**` 要重启 DSH 才生效（插件以 junction 挂在宿主进程里）。

## 本机路径坑

- 真实目录是 `D:\idea\0自己的项目\少用项目\dsh-pocket`；`D:\idea\dsh-pocket` 只是 junction，
  `ops_read_files` 之类的 no-follow 工具会报 `PATH_RESTRICTED`，**务必用真实路径**。
- `client/mobile/mobile.css.ts` 是模板字符串：注释里不要出现反引号包裹的标识符，否则 esbuild 提前结束模板。
- 改了原本 LF 的 `.md` 之后查行尾，`ops_edit_file` 会写成 CRLF，让 diff 变成整文件重写。

## 运行态

- profile 里 `node_modules/dsh-pocket` 是指向本仓库的 junction ⇒ 改完重启 DSH，手机刷新即用新包。
- 手机公网入口：frp `43.226.38.149:60012` → 本机 `127.0.0.1:3081`（`~/.dsh/dsh-pocket/frpc.toml`），
  设置 `tunnelMode: "frp"`。经 frp 访问时 pocket 判「公网」⇒ 只认 `~/.dsh/dsh-pocket/token`（不是 `token-lan`）。

## 推送

`origin` = `https://github.com/142475/dsh-pocket`（没有 fork/upstream 远端）。GitHub 推送：

```bash
env -u no_proxy -u NO_PROXY git -c http.proxy=http://127.0.0.1:82 -c credential.helper= \
  push "https://142475:$TK@github.com/142475/dsh-pocket" main
```

推完 `git fetch` 补 tracking ref，验收只认 `ls-remote` 与 `rev-parse HEAD` 对拍。
