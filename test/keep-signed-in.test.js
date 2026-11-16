// 免重输（TROUBLESHOOTING 第 46 / 59 节）：登录 cookie 派生用的 sessionKey 必须**落盘持久化**。
//
// 旧实现每次 dsh web 启动都 `randomBytes(16)` → 一重启/升级，手机带来的 dsh_pocket_token
// 立刻失配，用户被迫重新输 PIN。这里锁住三条行为：
//   1) 首次调用把 key 写进 $DSH_HOME/dsh-pocket/cookie-key（32+ 位十六进制，0600）；
//   2) 「重启」（重新导入模块）后取到同一个 key；
//   3) 删掉该文件 = 登出所有设备，随后会生成新 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const TMP_ROOT = join(import.meta.dirname, '..', 'temp');

test('免重输：cookieKey 落盘持久化，重启后复用同一个；删文件才换新', async () => {
  const home = mkdtempSync(join(TMP_ROOT, 'keep-signed-in-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const mod1 = await import(`../lib/settings.mjs?v=1-${Date.now()}`);
    const first = mod1.cookieKey();
    assert.match(first, /^[0-9a-f]{32,}$/, 'cookieKey 应是 32+ 位十六进制');
    const file = join(home, 'dsh-pocket', 'cookie-key');
    assert.equal(readFileSync(file, 'utf8'), first, 'key 必须落盘');

    // 重新导入模块 = 模拟 dsh web 重启（新进程里重新计算）
    const mod2 = await import(`../lib/settings.mjs?v=2-${Date.now()}`);
    assert.equal(mod2.cookieKey(), first, '重启后必须复用同一 key，否则手机要重输 PIN');

    // 删文件 = 登出所有设备
    rmSync(file);
    assert.notEqual(mod2.cookieKey(), first, '删除 cookie-key 后应生成新 key');
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
