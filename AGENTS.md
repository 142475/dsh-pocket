# AGENTS.md

给在本仓库里干活的 AI / 协作者看的约定（人看的说明见 `README.md`，本地开发见 `LOCAL-DEV.md`）。

## 这是什么

dsh-pocket：给 DeepSeek Harness 套一层带访问密码的代理（局域网 / 公网 / Cloudflare 隧道 / 自建 frp）。
本目录是本地 fork（`142475/dsh-pocket`），DSH profile 用 `link:` 指到这里，改完代码重启宿主即生效。

## 常用命令

```bash
npm test                 # node --test 全量用例（改了 lib/ 或 test/ 必跑）
node client/build.mjs    # 只有改了 client/index.jsx 才需要；产物 client/client.js 要一起提交
```

端到端验证：起一个临时端口的小代理打到真实上游（别动用户正在用的 3080/3081），再 `curl -i` 看响应头 / 行为。

## 约定

- 只改后端 `lib/*.mjs` 时不需要重构建前端产物。
- 远端：`origin` = 上游作者仓库 `shaobeichen/dsh-pocket`（**无推送权限**）；推自己的改动一律用 `fork` = `142475/dsh-pocket`。
- 提交信息用中文，形如 `feat(proxy): …` / `fix(tunnel): …`。
- `npm test` 必须全绿（`exit 0`）。本机 Windows 上会有 3 个用例显示 `skipped`，那是平台限制而非失败，原因写在 `LOCAL-DEV.md`。
- 代理 / 隧道这类行为改动，除了单元测试，尽量再做一次真实端到端验证（临时端口 → 真实上游）。
- Windows 本机注意：写完文件确认没被亿赛通重新加密（文件头变 `62 14 23 65` 就是被加密了，要右键解密）。
