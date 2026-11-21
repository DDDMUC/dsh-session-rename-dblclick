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
        /*
         * One box, and the text never moves into it: the box is positioned by
         * NEGATIVE offsets equal to its own padding + border, so the glyphs stay
         * exactly where the title drew them. No size or position change on enter
         * or leave - only the border and shadow appear.
         */
        .dsr-wrap {
          position: fixed; z-index: 2147483000; box-sizing: border-box;
          display: flex; align-items: center;
          margin: 0; border: 1px solid transparent; background: transparent;
          box-shadow: none; transition: none;
        }
        /* Editing: the colours are set inline by openEditor from tokens resolved INSIDE
           the theme scope. They cannot live here - this overlay hangs off <body>, where
           the theme variables do not exist, so a var() would fall back to something
           invented (that is exactly how the ring once came out black). */
        /*
         * Idle affordance. It CANNOT be a pseudo-element on the title: the product's
         * crumb is display:inline-block with overflow hidden, so anything drawn outside
         * its box is clipped away. So the ring is its own fixed overlay, positioned
         * with exactly the same maths as the editor - hovering previews the box that
         * is about to appear.
         */
        .dsr-ring {
          position: fixed; z-index: 2147482999; display: none; box-sizing: border-box;
          pointer-events: none; background: transparent;
          /* The reference paints its hover pill with the host tokens; hand-rolled rgba
             never matches a themed build. */
          border: 1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 16%, transparent));
          box-shadow: var(--dsw-shadow-lv2, 0 2px 8px 0 rgba(0, 0, 0, .04));
          transition:
            border-color var(--ds-transition-duration, 120ms) var(--ds-ease-in-out, ease),
            box-shadow var(--ds-transition-duration, 120ms) var(--ds-ease-in-out, ease);
        }
        .dsr-input {
          display: block; width: 100%; box-sizing: border-box;
          margin: 0; padding: 0; border: 0; outline: none;
          background: transparent; color: inherit; font: inherit;
          letter-spacing: inherit; text-align: inherit;
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
        return sessionId ? { sessionId, titleEl: crumb, surface: 'header' } : null
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
      return sessionId ? { sessionId, titleEl, surface: 'row' } : null
    }

    // --- the in-place editor ---------------------------------------------------

    /** @type {null | { closed: boolean, targetEl: Element, sessionId: string }} */
    let editor = null


    /** Width of `text` in the title's own font, so the editor can hug the glyphs. */
    function measureText(el, text, font) {
      const cs = window.getComputedStyle(el)
      const size = font !== undefined && font !== null ? font.size : parseFloat(cs.fontSize) || 13
      const weight = font !== undefined && font !== null ? font.weight : cs.fontWeight
      const family = font !== undefined && font !== null ? font.family : cs.fontFamily
      const lineHeight = font !== undefined && font !== null ? font.lineHeight : parseFloat(cs.lineHeight) || Math.round(size * 1.35)
      const style = font !== undefined && font !== null ? font.style : cs.fontStyle
      const spacing = font !== undefined && font !== null ? font.letterSpacing : cs.letterSpacing
      // Measure with a REAL element, not canvas metrics.
      //
      // Canvas measureText and the layout engine disagree by a pixel or two per CJK
      // string, so a canvas-measured pill came out ~2px wider than the text it hugs.
      // The reference is `width: fit-content`, i.e. whatever layout says, so ask layout.
      let width = 0
      let probe = null
      try {
        probe = document.createElement('span')
        probe.textContent = text
        probe.setAttribute('aria-hidden', 'true')
        probe.style.position = 'absolute'
        probe.style.visibility = 'hidden'
        probe.style.pointerEvents = 'none'
        probe.style.whiteSpace = 'pre'
        probe.style.font = `${style} ${weight} ${size}px ${family}`
        probe.style.lineHeight = `${lineHeight}px`
        probe.style.letterSpacing = spacing
        const host = el !== null && el !== undefined && el.parentElement !== null && el.parentElement !== undefined ? el.parentElement : document.body
        host.appendChild(probe)
        width = probe.getBoundingClientRect().width
      } catch (error) {
        width = 0
      } finally {
        if (probe !== null && typeof probe.remove === 'function') probe.remove()
      }
      if (!width) width = text.length * size * 0.62
      return { width, height: lineHeight, padLeft: parseFloat(cs.paddingLeft) || 0, padTop: parseFloat(cs.paddingTop) || 0 }
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

    const BORDER = 1
    const PAD_X = 12
    // The live product draws its field with --dsl-input-height:44px and
    // --dsl-input-border-radius:22px, i.e. a 44px pill whose caps are TRUE semicircles
    // (radius = height / 2, nothing for the browser to clamp).
    //
    // A 40px pill with a 22px radius is not the same thing: CSS scales both radii by
    // 40/44, so the caps come out at 20px and read a touch tighter at both ends. That
    // is the difference one sees when the two are put side by side.
    const PILL_HEIGHT = 44
    const PILL_RADIUS = 22

    /**
     * The pill that the editor and the hover ring both draw.
     *
     * Content is the TITLE LINE BOX, not its border box: the crumb carries its own
     * 4px padding, and measuring from the text is what keeps the glyphs still. The
     * header targets the product pill (40px); a sidebar row targets its own height so
     * the box cannot spill onto its neighbours.
     * @returns {{ left: number, top: number, width: number, height: number, padY: number }}
     */
    /**
     * The font the pill renders in.
     *
     * The reference pill uses the product's strong 14px token (weight 600, 22px line).
     * The DSH crumb is 14px/500/20px, so copying it makes the pill look lighter and
     * tighter than the reference. Take the size and weight from the token but keep the
     * host family, and measure with exactly that font so the width still fits.
     */
    function pillFont(titleEl) {
      const cs = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' ? window.getComputedStyle(titleEl) : null
      if (cs === null) return { size: 14, weight: '400', style: 'normal', lineHeight: 20, family: 'inherit', letterSpacing: 'normal' }
      return {
        size: parseFloat(cs.fontSize) || 14,
        weight: cs.fontWeight || '400',
        style: cs.fontStyle || 'normal',
        lineHeight: parseFloat(cs.lineHeight) || 20,
        family: cs.fontFamily || 'inherit',
        letterSpacing: cs.letterSpacing || 'normal',
      }
    }

    function boxOf(titleEl, title, surface) {
      const rect = titleEl.getBoundingClientRect()
      const font = pillFont(titleEl)
      const metrics = measureText(titleEl, title, font)
      const contentHeight = Math.max(14, Math.round(font.lineHeight))
      // Padding is computed from the BORDER as well, so the box lands on the target
      // height instead of target + 2.
      const target = surface === 'header' ? PILL_HEIGHT : contentHeight + 8
      const padY = Math.max(2, Math.min(12, Math.round((target - contentHeight) / 2) - BORDER))
      const contentLeft = rect.left + metrics.padLeft
      const contentTop = rect.top + metrics.padTop
      const room = typeof window === 'undefined' ? 0 : window.innerWidth - (contentLeft - (BORDER + PAD_X)) - 8
      const wanted = Math.max(metrics.width + 2, 24)
      const maxContent = Math.max(24, room - 2 * (BORDER + PAD_X))
      const contentWidth = Math.round(Math.min(wanted, maxContent))
      return {
        left: Math.round(contentLeft - (BORDER + PAD_X)),
        top: Math.round(contentTop - (BORDER + padY)),
        width: contentWidth + 2 * (BORDER + PAD_X),
        height: contentHeight + 2 * (BORDER + padY),
        padY,
        contentHeight,
      }
    }

    let ringEl = null
    let ringOwner = null

    /** Show the hover ring around a header title, in the editor's own geometry. */
    function showRing(titleEl) {
      if (editor !== null) return
      const title = (titleEl.textContent || '').trim()
      const box = boxOf(titleEl, title, 'header')
      if (box.width < 24 || box.height < 14) return
      if (ringEl === null) {
        ringEl = document.createElement('div')
        ringEl.className = 'dsr-ring'
        document.body.appendChild(ringEl)
      }
      ringEl.style.left = `${box.left}px`
      ringEl.style.top = `${box.top}px`
      ringEl.style.width = `${box.width}px`
      ringEl.style.height = `${box.height}px`
      ringEl.style.borderRadius = `${Math.round(Math.min(PILL_RADIUS, box.height / 2))}px`
      ringEl.style.borderColor = resolveToken(titleEl, '--dsw-alias-border-l2', 'borderColor', 'rgba(0, 0, 0, 0.1)')
      ringEl.style.boxShadow = resolveToken(titleEl, '--dsw-shadow-lv2', 'boxShadow', 'none')
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        ringEl.style.color = window.getComputedStyle(titleEl).color
      }
      ringEl.style.display = 'block'
      ringOwner = titleEl
    }

    function hideRing() {
      ringOwner = null
      if (ringEl !== null) ringEl.style.display = 'none'
    }

    /**
     * A theme token resolved where it really applies.
     *
     * The ring and the editor are appended to <body>, i.e. OUTSIDE the element that
     * carries the DSH theme variables, so a `var(--dsw-*)` inside their stylesheet
     * resolves to nothing and silently falls back to a hand-picked colour. Read the
     * token from the title itself (inheritance resolves it there) and pin the result
     * inline.
     */
    function resolveToken(el, name, property, fallback) {
      if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return fallback
      const host = el !== null && el !== undefined && el.parentElement ? el.parentElement : null
      if (host === null) return fallback
      let probe = null
      try {
        // A token may point at another token: --dsw-alias-brand-primary is
        // var(--dsw-static-neutral-bluish-1000), so getPropertyValue hands back that
        // literal text, and writing it on an element outside the theme scope makes the
        // declaration invalid (which quietly falls back to currentColor). The probe sits
        // INSIDE the theme scope, so the browser resolves the whole chain.
        probe = document.createElement('span')
        probe.setAttribute('aria-hidden', 'true')
        probe.style.position = 'absolute'
        probe.style.visibility = 'hidden'
        probe.style.pointerEvents = 'none'
        probe.style[property] = `var(${name}, ${fallback})`
        host.appendChild(probe)
        const value = window.getComputedStyle(probe)[property]
        return typeof value === 'string' && value.length > 0 ? value : fallback
      } catch (error) {
        return fallback
      } finally {
        if (probe !== null && typeof probe.remove === 'function') probe.remove()
      }
    }

    /**
     * The reference brand blue, exactly as the demo paints it.
     *
     * --dsw-alias-brand-primary is NOT used on purpose: both themes name it and give it
     * different values. The demo maps it to its deepseek blue (#3964fe light, #5686fe
     * dark); DSH maps it to a neutral (rgb(15, 17, 21)) because black is the accent of
     * its shell. Copying the token name therefore paints a black ring in DSH.
     */
    const REFERENCE_BRAND = { light: '#3964fe', dark: '#5686fe' }

    /** Rough luminance of a computed colour, or null when it cannot be parsed. */
    function luminanceOf(color) {
      const match = /rgba?\(([^)]+)\)/.exec(String(color))
      if (match === null) return null
      const parts = match[1].split(',').map((value) => parseFloat(value))
      if (parts.length < 3) return null
      return (0.299 * parts[0] + 0.587 * parts[1] + 0.114 * parts[2]) / 255
    }

    /** Which reference blue: the label colour (text) tells us whether the theme is dark. */
    function referenceBrand(titleEl) {
      const label = luminanceOf(resolveToken(titleEl, '--dsw-alias-label-primary', 'color', ''))
      return label !== null && label > 0.5 ? REFERENCE_BRAND.dark : REFERENCE_BRAND.light
    }

    function openEditor(target) {
      finish()
      const { sessionId, titleEl } = target
      const title = (titleEl.textContent || '').trim()
      const rect = titleEl.getBoundingClientRect()
      if (rect.width < 8 || rect.height < 8) return
      hideRing()
      // The hover ring has just drawn this exact pill, so entering the editor is a
      // change of colour, not of geometry.
      const box = boxOf(titleEl, title, target.surface)
      // Declared before the log that prints it: the previous revision logged `brand`
      // while its const sat further down, which threw a temporal-dead-zone error inside
      // openEditor AFTER the click was already swallowed - so a click did nothing at all.
      const brand = referenceBrand(titleEl)
      // A double click (or a drag) leaves a text selection on the title; the editor
      // shows its own selection, so drop the old one instead of stacking two bands.
      if (typeof window !== 'undefined' && typeof window.getSelection === 'function') {
        const selection = window.getSelection()
        if (selection !== null && selection !== undefined && typeof selection.removeAllRanges === 'function') {
          selection.removeAllRanges()
        }
      }
      // One line of arithmetic in the console: if the pill ever looks wrong again, the
      // numbers are already printed instead of guessed at.
      console.info('[dsh-session-rename-dblclick] box', {
        surface: target.surface,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        padY: box.padY,
        contentHeight: box.contentHeight,
        font: pillFont(titleEl),
        brand,
        title: rect.width + 'x' + rect.height,
      })

      const wrap = document.createElement('div')
      wrap.className = 'dsr-wrap'
      wrap.dataset.editing = 'true'
      wrap.style.left = `${box.left}px`
      wrap.style.top = `${box.top}px`
      wrap.style.width = `${box.width}px`
      wrap.style.height = `${box.height}px`
      const font = pillFont(titleEl)
      // The reference focus ring is an inset shadow, not a border: Input.module.css
      // paints `inset 0 0 0 1px var(--dsw-alias-brand-primary)`. Same here, so the ring
      // hugs the pill instead of growing it by a pixel.
      wrap.style.borderColor = 'transparent'
      wrap.style.background = resolveToken(titleEl, '--dsw-specific-input-major', 'backgroundColor', 'transparent')
      wrap.style.boxShadow = `inset 0 0 0 1px ${brand}`
      wrap.style.borderRadius = `${Math.round(Math.min(PILL_RADIUS, box.height / 2))}px`
      wrap.style.padding = `${box.padY}px ${PAD_X}px`
      wrap.style.fontFamily = font.family
      wrap.style.fontSize = `${font.size}px`
      wrap.style.fontWeight = font.weight
      wrap.style.fontStyle = font.style
      wrap.style.lineHeight = `${font.lineHeight}px`
      wrap.style.letterSpacing = font.letterSpacing

      const input = document.createElement('input')
      input.className = 'dsr-input'
      input.type = 'text'
      input.maxLength = MAX_TITLE
      input.value = title
      input.spellcheck = false
      input.setAttribute('aria-label', '重命名会话')
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
      const focusNow = () => {
        if (state.closed) return
        input.focus({ preventScroll: true })
        // The reference drops a caret after the last character; it does NOT select the
        // title. Selecting everything made the first keystroke replace the whole name,
        // and it repainted the text with a selection band that the reference never shows.
        const end = String(input.value).length
        if (typeof input.setSelectionRange === 'function') input.setSelectionRange(end, end)
      }
      // Next frame when there is one (some hosts without a window still run this code).
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusNow)
      else focusNow()
    }

    // --- listener --------------------------------------------------------------

    // The browser's own `dblclick` is the primary trigger, but some builds route
    // a row click through handlers that cancel the native double-click synthesis.
    // Tracking the two clicks here keeps the gesture working either way: same
    // session, within 600 ms, within 8 px of the previous click.
    const DOUBLE_MS = 600
    const DOUBLE_PX = 8
    let lastClick = null

    /**
     * The header title a hover is over, or null.
     *
     * Deliberately does NOT resolve the session: showing a ring must not depend on the
     * id being unambiguous, or hovering would silently do nothing exactly when two
     * conversations are on screen.
     */
    function headerTitleOf(node) {
      const el = elementOf(node)
      if (!el || typeof el.closest !== 'function') return null
      if (el.closest('input, textarea, [contenteditable="true"]')) return null
      return el.closest('[class*="_crumbCurrent"]')
    }

    /** Draw the pill that a click is about to open. */
    function onHover(event) {
      if (editor) return
      const owner = headerTitleOf(event.target)
      if (owner === null || owner === undefined) return
      if (owner !== ringOwner) showRing(owner)
    }

    function onOut(event) {
      if (ringOwner === null) return
      const next = event.relatedTarget
      if (next !== null && next !== undefined && typeof ringOwner.contains === 'function' && ringOwner.contains(next)) return
      hideRing()
    }

    function onDoubleClick(event) {
      if (event.button !== 0) return
      const target = resolveTarget(event.target)
      if (!target) {
        lastClick = null
        return
      }
      if (target.surface === 'header') {
        // Leave the event alone. The current crumb is a plain <span> with no handler of
        // its own (only ancestor crumbs are buttons, and those are not this node), so
        // there is nothing to defend against - and swallowing it took away the native
        // "double click selects a word" inside our own input, which is exactly what one
        // wants while renaming.
        if (editor === null) openEditor(target)
        return
      }
      // A row is different: the product opens ITS rename dialog on this same event
      // (Rows.tsx: onDoubleClick -> onRenameRequest). Swallow it whether or not our
      // editor is up, otherwise the stock modal lands on top of our input.
      event.preventDefault()
      event.stopPropagation()
      if (editor) return
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
      // The header title is a plain span: clicking it does nothing in the product, so
      // ONE click opens the editor - that is what the reference implementation does
      // (the box is always there, a click swaps its contents for an input). A sidebar
      // row is different: clicking it opens the session, so it needs the deliberate
      // second click.
      if (target.surface === 'header') {
        lastClick = null
        event.preventDefault()
        event.stopPropagation()
        openEditor(target)
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
        document.addEventListener('mouseover', onHover, true)
        document.addEventListener('mouseout', onOut, true)
        // Not every environment that runs this bundle has a window (the tests drive
        // it under a bare document); the ring is repositioned on demand anyway.
        const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        if (hasWindow) {
          window.addEventListener('scroll', hideRing, true)
          window.addEventListener('resize', hideRing)
        }
        return () => {
          document.removeEventListener('dblclick', onDoubleClick, true)
          document.removeEventListener('click', onClick, true)
          document.removeEventListener('mouseover', onHover, true)
          document.removeEventListener('mouseout', onOut, true)
          if (hasWindow) {
            window.removeEventListener('scroll', hideRing, true)
            window.removeEventListener('resize', hideRing)
          }
          hideRing()
          lastClick = null
          finish()
          if (typeof window !== 'undefined') window.__DSH_SESSION_RENAME__ = false
        }
      }
      if (ctx && typeof ctx.effect === 'function') ctx.effect(install)
      else install()

    }

    return { apply, __resolveTarget: resolveTarget, __sessionIdOfRow: sessionIdOfRow, __sessionIdForHeader: sessionIdForHeader, __openEditor: openEditor, __onDoubleClick: onDoubleClick }
  },
})
