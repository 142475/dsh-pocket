// 移动端文件守卫（issue #17 修正）：手机点文件链接会触发桌面 open 失败，改为弹提示；
// 并隐藏「添加工作区」入口。测试只验证「接线 + 识别方式不依赖 hash 类名 + 打包产物
// 含逻辑 + CSS 隐藏入口」，与 mobile-nav.test.js 同风格（不引 jsdom，读源码/产物断言）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SELECTABLE_ROLES,
  SELECTABLE_SELECTOR,
  isSelectableRole,
  looksLikeFilePath,
} from '../client/mobile/fileGuard-rules.mjs';

const src = readFileSync(new URL('../client/mobile/fileGuard.ts', import.meta.url), 'utf8');
const apply = readFileSync(new URL('../client/mobile/mobile-apply.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../client/mobile/mobile.css.ts', import.meta.url), 'utf8');
const bundle = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

test('fileGuard 只依赖稳定结构（button/a + 路径文案），不依赖 hash 类名', () => {
  assert.ok(src.includes("closest('button, a')"), '必须用 closest("button, a") 找文件链接');
  assert.ok(src.includes('looksLikeFilePath'), '必须用语义化路径检测，而非按类名');
  // hash 类名形如 [class$="_xxx"]；检测逻辑里绝不能出现按类名的属性选择器
  assert.ok(!/\[class[*^$]?=/.test(src), 'fileGuard.ts 的检测不能出现 class 属性选择器（hash 类名每次构建都变）');
});

test('mobile-apply 已接线 startFileGuard（窄屏生效、传入 readFile，且不再接 fileCopy）', () => {
  assert.ok(apply.includes("import { startFileGuard } from './fileGuard.ts'"), '必须 import 模块');
  assert.ok(apply.includes('startFileGuard(readFile)'), '必须调用 startFileGuard 并传入 readFile 回调');
  assert.ok(apply.includes('POCKET_ENDPOINTS.fileRead'), 'readFile 回调必须打到 fileRead 端点');
  assert.ok(apply.includes('getWorkspaceCwd()'), 'readFile 必须携带工作区 cwd 以精确解析相对路径');
  assert.ok(apply.includes("'dsh-mobile-nav: file open guard + copy button + hide add-workspace (issue #17)'"), 'effect 标签应标注 issue #17');
  assert.ok(apply.includes('if (!narrow.matches) return'), '守卫 effect 必须受 narrow 门控');
  assert.ok(!apply.includes('startFileCopyInjection'), '不应再引用已删除的复制按钮模块');
});

test('源码含提示文案与「添加工作区」隐藏文案（产物会被 esbuild 转义，故查源码）', () => {
  // 提示文案
  assert.ok(src.includes('手机上无法直接打开电脑上的文件'), 'fileGuard.ts 必须定义「无法打开」提示文案');
  // 中英双语隐藏标签
  assert.ok(src.includes('添加工作区') && src.includes('Add workspace'), '必须覆盖中英双语的添加工作区入口');
});

test('打包产物含守卫 + 复制按钮结构标记', () => {
  // esbuild 会把单引号规范成双引号、中文转义成 \\uXXXX，故只查 ASCII 结构标记。
  assert.ok(/closest\(\s*["']button, a["']\s*\)/.test(bundle), '产物必须保留 closest("button, a") 检测——先跑 node client/build.mjs');
  assert.ok(bundle.includes('stopImmediatePropagation'), '产物必须能在捕获阶段阻止桌面 open');
  assert.ok(bundle.includes('file-guard-toast'), '产物必须含 toast 标记');
  assert.ok(bundle.includes('add-workspace'), '产物必须含隐藏添加工作区的逻辑');
  // 复制按钮：注入标记 + 经 RPC 读文件（data-mobile-nav-copy 标记已处理链接，避免重复注入）
  assert.ok(bundle.includes('copy-file'), '产物必须含复制按钮标记 data-mobile-nav="copy-file"');
  assert.ok(bundle.includes('data-mobile-nav-copy'), '产物必须用标记避免重复注入复制按钮');
});

test('可勾选控件（role=checkbox/radio…）不是文件链接：选项带路径文案时不被拦、不注入复制按钮', () => {
  // 真凶场景：ask_user_question 的选项就是 <button role="checkbox|radio">，
  // 文案/描述里带路径时会被当成文件链接 ⇒ 复选框点不动 + 旁边多一个「复制」按钮。
  assert.equal(looksLikeFilePath('lib/proxy.mjs'), true, '纯路径文案本身仍算文件链接');
  assert.equal(
    looksLikeFilePath('选项说明：见 lib/proxy.mjs 的注释'),
    true,
    '文案里含路径也会命中（所以必须靠角色排除，而不是靠文案）',
  );
  for (const role of SELECTABLE_ROLES) {
    assert.equal(isSelectableRole(role), true, role + ' 必须被排除');
    assert.ok(SELECTABLE_SELECTOR.includes('[role="' + role + '"]'), role + ' 必须进选择器');
  }
  assert.equal(isSelectableRole('CHECKBOX'), true, '角色名大小写不敏感');
  assert.equal(isSelectableRole('button'), false, '普通 button 仍是候选');
  assert.equal(isSelectableRole(null), false, '没有 role 不是可勾选控件');
  assert.ok(SELECTABLE_SELECTOR.startsWith('label,'), '<label> 包裹的复选框也要排除');
});

test('fileGuard 统一走 isFileLink（点击拦截 + 注入各一处），规则只留在 fileGuard-rules.mjs', () => {
  assert.ok(src.includes("from './fileGuard-rules.mjs'"), '必须复用共享规则模块');
  assert.ok(src.includes('isSelectableControl'), '必须有可勾选控件判定');
  assert.ok(src.includes('el.closest(SELECTABLE_SELECTOR)'), '必须用 closest 排除选项行内部的元素');
  assert.ok(!src.includes('function looksLikeFilePath'), '规则不能在本文件复制一份（两边会漂移）');
  assert.equal((src.match(/!isFileLink\(/g) ?? []).length, 2, '点击拦截与复制按钮注入都必须用 isFileLink');
});

test('打包产物含可勾选控件排除逻辑', () => {
  assert.ok(
    bundle.includes('"checkbox"') && bundle.includes('"menuitemradio"'),
    '产物必须含可勾选角色表——先跑 node client/build.mjs',
  );
  assert.ok(bundle.includes('el.closest(SELECTABLE_SELECTOR)'), '产物必须用选择器排除选项行内部的元素');
});

test('CSS 隐藏「添加工作区」图标 + 复制按钮样式（窄屏）', () => {
  assert.ok(css.includes('button[aria-label="添加工作区"]'), 'mobile.css.ts 必须隐藏 zh 添加工作区按钮');
  assert.ok(css.includes('button[aria-label="Add workspace"]'), 'mobile.css.ts 必须隐藏 en 添加工作区按钮');
  // 复制按钮样式必须存在（窄屏才注入/显示）
  assert.ok(css.includes('[data-mobile-nav="copy-file"]'), 'mobile.css.ts 必须含复制按钮样式');
});
