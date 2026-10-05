// 移动端文件守卫（issue #17）：dsh-web 在手机上点「文件链接」会触发桌面端
// workspaces.openPath(open <path>)，既打不开（文件在电脑上），又会抛
// "path open failed". 这里做两件事：
//   1) 捕获阶段拦截这类激活（点击 / 键盘），改为弹一个提示；
//   2) 隐藏「添加工作区」入口（手机上配工作区无意义）。
// 移植自 dsh-web-mobile（MIT）。
//
// 识别规则见 fileGuard-rules.mjs（纯函数，可单测）；**可勾选控件（role=checkbox/radio…）
// 也是 <button>，必须排除**，否则 ask_user_question 里带路径的选项会被拦成「文件链接」，
// 表现为复选框点不动。
import {
  SELECTABLE_SELECTOR,
  isSelectableRole,
  looksLikeFilePath,
} from './fileGuard-rules.mjs'

/** 手机上点击文件时弹出的提示。 */
const GUARD_MSG = '手机上无法直接打开电脑上的文件'
/** 「添加工作区」入口的文案（随语言变化），两种都覆盖。 */
const WS_LABELS = ['添加工作区', '添加工作区…', 'Add workspace', 'Add workspace…']

/** 可勾选控件（复选框/单选框/选项行/标签）——它们也是 <button>，但不是文件链接。 */
function isSelectableControl(el: HTMLElement): boolean {
  return isSelectableRole(el.getAttribute('role')) || el.closest(SELECTABLE_SELECTOR) !== null
}

/** 是不是一个「该被当作文件链接处理」的元素。 */
function isFileLink(el: HTMLElement): boolean {
  if (isSelectableControl(el)) return false
  return looksLikeFilePath(el.textContent)
}

export function startFileGuard(): () => void {
  // 轻量 toast：自包含，不依赖 dsh-pocket 面板的 React 状态。
  let toastEl: HTMLElement | null = null
  let toastTimer: number | null = null
  const showToast = (text: string): void => {
    if (toastEl === null) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('data-mobile-nav', 'file-guard-toast')
      Object.assign(toastEl.style, {
        position: 'fixed',
        left: '50%',
        bottom: '64px',
        transform: 'translateX(-50%)',
        maxWidth: '84vw',
        zIndex: '9999',
        padding: '10px 14px',
        borderRadius: '10px',
        background: 'rgba(20,22,28,.92)',
        color: '#fff',
        fontSize: '13px',
        lineHeight: '1.4',
        textAlign: 'center',
        fontFamily: 'inherit',
        boxShadow: '0 4px 16px rgba(0,0,0,.28)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity .18s ease',
      } as CSSStyleDeclaration)
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    requestAnimationFrame(() => {
      if (toastEl !== null) toastEl.style.opacity = '1'
    })
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      if (toastEl !== null) toastEl.style.opacity = '0'
    }, 2600)
  }

  // 捕获阶段拦截文件链接的激活。按钮的键盘激活（Enter/Space）会派发 click，
  // 因此只拦 click 即可同时覆盖鼠标与键盘，避免重复处理。
  const onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    if (target === null) return
    const el = target.closest('button, a') as HTMLElement | null
    if (el === null) return
    if (!isFileLink(el)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    showToast(GUARD_MSG)
  }
  document.addEventListener('click', onClick, true)

  // 隐藏「添加工作区」入口：图标按钮由 mobile.css.ts 按 aria-label 隐藏；
  // 下拉菜单里的文本项 CSS 选不到，这里按文案兜底（只在新增节点时检查，省开销）。
  const hideWsEntries = (): (() => void) => {
    const checkOne = (node: Node): void => {
      if (node.nodeType !== 1) return
      const el = node as HTMLElement
      const txt = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()
      if (WS_LABELS.includes(txt)) {
        el.style.display = 'none'
        el.setAttribute('data-mobile-nav-hide', 'add-workspace')
      }
    }
    const sel = '[role="menuitem"],[role="option"],li,button,a'
    document.querySelectorAll(sel).forEach(checkOne)
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return
          checkOne(n)
          ;(n as HTMLElement).querySelectorAll?.(sel).forEach(checkOne)
        })
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }
  const disconnectWs = hideWsEntries()

  return () => {
    document.removeEventListener('click', onClick, true)
    disconnectWs()
    if (toastTimer !== null) window.clearTimeout(toastTimer)
    toastEl?.remove()
  }
}
