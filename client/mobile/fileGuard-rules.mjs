// 移动端文件守卫的判定规则（纯函数，fileGuard.ts 与单测共用，不依赖 DOM）。
// 识别方式：不依赖 dsh-web 的 hash 类名（每次构建都变），只认「文本像文件路径的
// <button>/<a>」——文件链接按钮的文案就是路径（如 lib/proxy.mjs / /Users/.../x.ts）。
//
// 但**可勾选控件也是 <button>**：ask_user_question 的选项就是
// `<button role="checkbox|radio">`（见 dsh-client-ui-user-questions 的 option 渲染），
// 选项文案/描述里带路径时会被误判成文件链接 ⇒ 点不动复选框 + 旁边多出一个「复制」按钮。
// 因此所有判定都必须先排除这些角色。

/** 可勾选 / 可选项控件角色：是 <button>，但不是文件链接。 */
export const SELECTABLE_ROLES = Object.freeze([
  'checkbox',
  'radio',
  'switch',
  'option',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
])

/** 排除可勾选控件的 CSS 选择器（含 <label> 包裹的复选框）。 */
export const SELECTABLE_SELECTOR =
  'label,' + SELECTABLE_ROLES.map((role) => `[role="${role}"]`).join(',')

/** 角色名是否属于可勾选控件（大小写不敏感）。 */
export function isSelectableRole(role) {
  return typeof role === 'string' && SELECTABLE_ROLES.includes(role.toLowerCase())
}

/** 文本是否像文件路径：绝对路径 / 相对路径 / 带扩展名的目录路径。 */
export function looksLikeFilePath(text) {
  const t = (text ?? '').trim()
  if (t.length < 3 || t.length > 320) return false
  if (/^(\/|~\/|\.\.?\/|[A-Za-z]:\\)/.test(t)) return true
  if (/\/[\w.\-]+\.\w{1,12}$/.test(t)) return true
  if (/[\w.\-]+\/[\w.\-]+\.\w{1,12}/.test(t)) return true
  return false
}
