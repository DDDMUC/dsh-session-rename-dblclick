// dsh-session-rename-dblclick — client half.
//
// Double-clicking a Session title renames it in place — in both places the
// product shows that title:
//
//   * the sidebar Session row          `[class*="_sessionRow"]`
//   * the header breadcrumb title      `[class*="_crumbCurrent"]`
//
// Neither surface exposes a title slot (`sidebar.workspaces` and
// `conversation.session.header` are single slots whose replacement would shadow
// the shipped row and header), so this module decorates the rendered DOM and
// keeps every mutation reversible:
//
//   * one capture-phase `dblclick` listener on `document`;
//   * a floating <input> placed over the title box, with the title's own
//     computed font, so the swap reads as in-place editing;
//   * the title element is hidden with `visibility` while editing and restored
//     on close (never removed, so React keeps reconciling the same nodes);
//   * Enter or blur commits, Escape cancels, an unchanged or empty value is a
//     no-op;
//   * the commit posts to the host half, which calls the shipped
//     `sessionController.rename`, and the accepted text is painted immediately
//     so the row updates even if the title projection lags.
//
// Selectors key on CSS-module local suffixes, never on the build-hashed prefix
// (`wnFoaW_title` today): that prefix changes on every build.
window.__ModuleLoader__.load({
  id: 'dsh-session-rename-dblclick',
  factory: () => {
    const ROUTE = '/dsh-session-rename/rename'
    const MAX_TITLE = 200
    const STYLE_ATTR = 'data-dsh-session-rename'
    const SESSION_IN_PATH = /\/session\/([^/?#]+)/

    const zh = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language || '')
    const text = zh
      ? {
          failed: '重命名失败：',
          unreachable: '改名接口没有响应（宿主侧插件未加载）',
        }
      : {
          failed: 'Rename failed: ',
          unreachable: 'Rename endpoint unavailable (host half not loaded)',
        }

    // --- styling ---------------------------------------------------------------

    /** One <style> element, keyed so a reload never stacks duplicates. */
    function ensureStyle() {
      if (document.querySelector(`style[${STYLE_ATTR}]`)) return
      const style = document.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      style.textContent = `
        .dsr-wrap { position: fixed; z-index: 2147483000; box-sizing: border-box; }
        .dsr-input {
          display: block; width: 100%; height: 100%; box-sizing: border-box;
          margin: 0; padding: 0 3px; border-radius: 4px;
          border: 1px solid var(--dsw-alias-brand-primary, #4d6bfe);
          background: var(--dsw-alias-bg-overlay, #ffffff);
          color: var(--dsw-alias-label-primary, #1f2023);
          outline: none; line-height: normal;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .12);
        }
        .dsr-toast {
          position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
          z-index: 2147483001; max-width: 62vw; padding: 8px 12px;
          border-radius: 8px; font-size: 12.5px; line-height: 1.5;
          background: var(--dsw-alias-bg-overlay, #ffffff);
          color: var(--dsw-alias-state-error-primary, #d33);
          border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .15));
          box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
        }
      `
      document.head.appendChild(style)
    }

    /** One transient message, reused so repeated failures cannot stack. */
    let toastTimer = 0
    function toast(message) {
      const previous = document.querySelector('.dsr-toast')
      if (previous) previous.remove()
      const node = document.createElement('div')
      node.className = 'dsr-toast'
      node.textContent = message
      document.body.appendChild(node)
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toastTimer = 0
        node.remove()
      }, 4200)
    }

    // --- target resolution -----------------------------------------------------

    function elementOf(node) {
      if (!node) return null
      if (node.nodeType === 1) return /** @type {Element} */ (node)
      return node.parentElement || null
    }

    /**
     * The Session the conversation panel around `crumb` is showing.
     *
     * Walks up until an ancestor holds conversation content, then keeps only the
     * TOP-LEVEL occurrences (one whose own nearest `[data-conversation-session]`
     * ancestor is itself, so an embedded subagent panel does not pass for the
     * outer conversation). More than one survivor means the answer is ambiguous -
     * return null rather than rename a session the user did not point at.
     * @param {Element} crumb
     * @returns {string | null}
     */
    function sessionIdForHeader(crumb) {
      let node = crumb
      for (let depth = 0; depth < 24 && node !== null && node !== undefined; depth += 1) {
        if (typeof node.querySelectorAll !== 'function') {
          node = node.parentElement
          continue
        }
        const found = node.querySelectorAll('[data-conversation-session]')
        if (found.length === 0) {
          node = node.parentElement
          continue
        }
        const top = []
        for (const el of found) {
          const parent = el.parentElement
          const owner = parent && typeof parent.closest === 'function' ? parent.closest('[data-conversation-session]') : null
          if (owner === null) top.push(el)
        }
        if (top.length !== 1) return null
        const value = top[0].getAttribute('data-conversation-session')
        return typeof value === 'string' && value.length > 0 ? value : null
      }
      return null
    }

    /**
     * The Session a sidebar row names.
     *
     * `data-row-key` first: current builds render the row as
     * `<div role="treeitem" data-row-key="session:<id>">` with an onClick. The
     * anchor this module used to require no longer exists, which made every
     * double-click a silent no-op. The anchor stays as a fallback.
     * @param {Element} row
     * @returns {string | null}
     */
    function sessionIdOfRow(row) {
      const key = row && typeof row.getAttribute === 'function' ? row.getAttribute('data-row-key') : null
      if (typeof key === 'string' && key.startsWith('session:') && key.length > 'session:'.length) {
        return key.slice('session:'.length)
      }
      const link = row && typeof row.querySelector === 'function' ? row.querySelector('a[href*="/session/"]') : null
      return sessionIdFromHref(link && link.getAttribute('href'))
    }

    function sessionIdFromHref(href) {
      const match = href ? SESSION_IN_PATH.exec(href) : null
      return match ? match[1] : null
    }

    /**
     * Map a double-clicked node to the Session title it names.
     * @returns {{ sessionId: string, titleEl: Element } | null}
     */
    function resolveTarget(node) {
      const el = elementOf(node)
      if (!el || typeof el.closest !== 'function') return null
      // Never start an edit from inside another editable surface.
      if (el.closest('input, textarea, [contenteditable="true"]')) return null

      // header breadcrumb: the title of the Session this page shows.
      // The URL cannot answer this: the web front end has no router, so
      // location.href stays "http://host:port/" whatever session is open.
      // DSH itself answers the same question with `[data-conversation-session]`
      // (that is how its stop-shortcut finds the session), so read that - and
      // refuse to guess when more than one conversation is on screen.
      const crumb = el.closest('[class*="_crumbCurrent"]')
      if (crumb) {
        const sessionId = sessionIdForHeader(crumb)
        return sessionId ? { sessionId, titleEl: crumb } : null
      }

      // sidebar row: `data-row-key="session:<id>"` is the shipped contract.
      // The row is a <div role="treeitem" data-row-key=...> with an onClick, not
      // a link - requiring an anchor here matched nothing in current builds, so
      // every double-click was a silent no-op.
      const row = el.closest('[class*="_sessionRow"], [data-row-key^="session:"]')
      if (!row) return null
      const titleEl = el.closest('[class*="_title"]') || row.querySelector('[class*="_title"]')
      if (!titleEl || !row.contains(titleEl)) return null
      const sessionId = sessionIdOfRow(row)
      return sessionId ? { sessionId, titleEl } : null
    }

    // --- the in-place editor ---------------------------------------------------

    /** @type {null | { closed: boolean, targetEl: Element, sessionId: string }} */
    let editor = null

    function copyFont(from, to) {
      const cs = window.getComputedStyle(from)
      to.style.fontFamily = cs.fontFamily
      to.style.fontSize = cs.fontSize
      to.style.fontWeight = cs.fontWeight
      to.style.fontStyle = cs.fontStyle
      to.style.letterSpacing = cs.letterSpacing
      to.style.lineHeight = cs.lineHeight
      to.style.textAlign = cs.textAlign
    }

    /** Width of `text` in the title's own font, so the editor can hug the glyphs. */
    function measureText(el, text) {
      const cs = window.getComputedStyle(el)
      const fontSize = parseFloat(cs.fontSize) || 13
      const lineHeight = parseFloat(cs.lineHeight) || Math.round(fontSize * 1.35)
      let width = 0
      try {
        if (!measureText.canvas) measureText.canvas = document.createElement('canvas')
        const context = measureText.canvas.getContext('2d')
        context.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
        width = context.measureText(text).width
      } catch {
        width = 0
      }
      if (!width) width = text.length * fontSize * 0.62
      const spacing = parseFloat(cs.letterSpacing)
      if (Number.isFinite(spacing) && spacing !== 0) width += spacing * Math.max(text.length - 1, 0)
      return { width, height: lineHeight, padLeft: parseFloat(cs.paddingLeft) || 0 }
    }

    /** Close the editor and restore the title it covered. Idempotent. */
    function finish() {
      const current = editor
      if (!current) return
      editor = null
      current.closed = true
      const { targetEl } = current
      // One editor exists at a time, but remove every stray node: a second
      // module instance would otherwise leave an input behind.
      for (const node of document.querySelectorAll('.dsr-wrap')) node.remove()
      if (targetEl && targetEl.style) targetEl.style.visibility = current.previousVisibility
    }

    async function persist(sessionId, targetEl, title) {
      let response
      let body = null
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, title }),
        })
        body = await response.json().catch(() => null)
      } catch {
        toast(text.unreachable)
        return
      }
      if (!response.ok || !body || body.ok !== true) {
        const detail = body && (body.error || body.code)
        toast(text.failed + String(detail || `HTTP ${response.status}`))
        return
      }
      // Paint now: the host re-renders the same text a moment later, but the
      // row should not flash the old title in between.
      if (targetEl && targetEl.isConnected) {
        const accepted = typeof body.title === 'string' && body.title ? body.title : title
        targetEl.textContent = accepted
      }
    }

    function openEditor(target) {
      finish()
      const { sessionId, titleEl } = target
      const title = (titleEl.textContent || '').trim()
      const rect = titleEl.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return

      // Hug the text: the editor is the glyph box plus a hairline frame, not the
      // padded row or header box the title happens to live in.
      const metrics = measureText(titleEl, title)
      const boxHeight = Math.round(metrics.height + 2)
      const boxTop = Math.round(rect.top + (rect.height - boxHeight) / 2)
      const boxLeft = Math.round(rect.left + metrics.padLeft - 1)
      const room = typeof window === 'undefined' ? 0 : window.innerWidth - boxLeft - 8
      const wanted = Math.min(Math.max(metrics.width + 8, 56), Math.max(rect.width, 56) + 40)
      const boxWidth = Math.round(room > 56 ? Math.min(wanted, room) : wanted)

      const wrap = document.createElement('div')
      wrap.className = 'dsr-wrap'
      wrap.style.left = `${boxLeft}px`
      wrap.style.top = `${boxTop}px`
      wrap.style.width = `${boxWidth}px`
      wrap.style.height = `${boxHeight}px`

      const input = document.createElement('input')
      input.className = 'dsr-input'
      input.type = 'text'
      input.maxLength = MAX_TITLE
      input.value = title
      input.spellcheck = false
      input.setAttribute('aria-label', '重命名会话')
      copyFont(titleEl, input)
      wrap.appendChild(input)

      const previousVisibility = titleEl.style.visibility
      const state = { closed: false, targetEl: titleEl, sessionId, previousVisibility }
      editor = state

      const commit = () => {
        if (state.closed) return
        const value = input.value.replace(/\s+/g, ' ').trim()
        const unchanged = value === title || value.length === 0
        finish()
        if (!unchanged) void persist(sessionId, titleEl, value.slice(0, MAX_TITLE))
      }

      input.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Enter' && !event.isComposing) {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          finish()
        }
      })
      input.addEventListener('blur', () => {
        // Removal done by finish() never fires this with a live state.
        if (!state.closed) commit()
      })

      document.body.appendChild(wrap)
      titleEl.style.visibility = 'hidden'
      requestAnimationFrame(() => {
        if (state.closed) return
        input.focus({ preventScroll: true })
        input.select()
      })
    }

    // --- listener --------------------------------------------------------------

    // The browser's own `dblclick` is the primary trigger, but some builds route
    // a row click through handlers that cancel the native double-click synthesis.
    // Tracking the two clicks here keeps the gesture working either way: same
    // session, within 600 ms, within 8 px of the previous click.
    const DOUBLE_MS = 600
    const DOUBLE_PX = 8
    let lastClick = null

    function onDoubleClick(event) {
      if (event.button !== 0) return
      if (editor) return
      const target = resolveTarget(event.target)
      if (!target) {
        lastClick = null
        return
      }
      event.preventDefault()
      event.stopPropagation()
      openEditor(target)
    }

    function onClick(event) {
      if (event.button !== 0) return
      if (editor) return
      const target = resolveTarget(event.target)
      if (!target) {
        lastClick = null
        return
      }
      const now = Date.now()
      const previous = lastClick
      lastClick = { sessionId: target.sessionId, x: event.clientX, y: event.clientY, time: now }
      // A real double-click reports detail 2; the timing test covers the case
      // where the browser's own synthesis never happened.
      const byDetail = event.detail >= 2
      const byTiming = previous !== null
        && previous.sessionId === target.sessionId
        && now - previous.time <= DOUBLE_MS
        && Math.abs(previous.x - event.clientX) <= DOUBLE_PX
        && Math.abs(previous.y - event.clientY) <= DOUBLE_PX
      if (!byDetail && !byTiming) return
      lastClick = null
      event.preventDefault()
      event.stopPropagation()
      openEditor(target)
    }

    // --- plugin ----------------------------------------------------------------

    function apply(ctx) {
      ensureStyle()
      // The client graph can activate one bundle twice (boot row plus a reload);
      // a second listener pair would open two editors over the same title.
      if (typeof window !== 'undefined' && window.__DSH_SESSION_RENAME__) return
      if (typeof window !== 'undefined') window.__DSH_SESSION_RENAME__ = true
      console.info('[dsh-session-rename-dblclick] ready — double-click a session title to rename')
      const install = () => {
        document.addEventListener('dblclick', onDoubleClick, true)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('dblclick', onDoubleClick, true)
          document.removeEventListener('click', onClick, true)
          lastClick = null
          finish()
          if (typeof window !== 'undefined') window.__DSH_SESSION_RENAME__ = false
        }
      }
      if (ctx && typeof ctx.effect === 'function') ctx.effect(install)
      else install()

    }

    return { apply, __resolveTarget: resolveTarget, __sessionIdOfRow: sessionIdOfRow, __sessionIdForHeader: sessionIdForHeader }
  },
})
