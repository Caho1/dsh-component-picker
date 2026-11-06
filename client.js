/**
 * Browser element picker — Claude-style element inspection for the built-in
 * (right-sidebar) Browser tab.
 *
 * Flow, mirroring `open-claude-ui/docs/v4.16336.0/05-元素选择、组件名与上下文注入.md`:
 *   1. A pointer tool is added to the Browser tab's own toolbar (top-right,
 *      after "open in system browser"), injected into the shipped toolbar DOM
 *      because the Browser package declares no toolbar slot.
 *   2. Clicking it runs an inspector inside the guest page through
 *      `webview.executeJavaScript`. The inspector draws the hover highlight and
 *      the `tag#id.class` label in a closed shadow root above everything
 *      (z-index 2147483647, pointer-events none, orange palette), and resolves
 *      with the clicked element's context.
 *   3. The embedder grabs a padded screenshot of the element through
 *      `webview.capturePage`, pastes it into the composer as an image
 *      attachment, and writes the `<selected-element>` XML block into the draft.
 *   4. The chip shelf above the composer lists the picks and previews the exact
 *      payload (thumbnail, Element / Component / Props / Source / Text /
 *      Selector / Styles / HTML) on hover.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-component-picker',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-component-picker';
    const PREFIX = 'dsh-cp';
    const HOST_ATTRIBUTE = 'data-dsh-cp-ui';

    /* ------------------------------------------------------------------ *
     * Copy
     * ------------------------------------------------------------------ */

    const EN = {
      'pick.title': 'Select an element on the page',
      'pick.busy': 'Picking an element…',
      'chip.remove': 'Remove',
      'card.heading': 'Included with your message',
      'card.more': 'Show {count} more details',
      'card.less': 'Hide details',
      'label.element': 'Element',
      'label.component': 'Component',
      'label.owners': 'in {owners}',
      'label.props': 'Props',
      'label.source': 'Source',
      'label.text': 'Text',
      'label.selector': 'Selector',
      'label.styles': 'Computed styles',
      'label.html': 'HTML',
      'label.screenshot': 'Screenshot',
      'error.noComposer': 'Open a Session before picking an element',
      'error.busy': 'The composer is busy; try again in a moment',
      'error.write': 'Could not write into the composer',
      'error.noPage': 'The page is not ready yet',
      'error.noBrowser': 'Element picking needs the built-in Browser tab',
      'error.inspect': 'The page refused the inspector',
      'delivery.context': 'Sent as a context message',
      'delivery.prefix': 'Sent as a prefix of your message',
      'delivery.fallback': 'Context delivery failed; sent with your message',
      'row.selectedTitle': 'Selected element',
      'row.selected': 'Selected element',
      'row.contextTitle': 'Context injected',
      'row.context': 'context',
    };

    const ZH = {
      'pick.title': '选择页面中的元素',
      'pick.busy': '正在拾取元素…',
      'chip.remove': '移除',
      'card.heading': '已包含在消息中',
      'card.more': '展开其余 {count} 项',
      'card.less': '收起',
      'label.element': '元素',
      'label.component': '组件',
      'label.owners': '在 {owners} 中',
      'label.props': 'Props',
      'label.source': '来源',
      'label.text': '文本',
      'label.selector': '选择器',
      'label.styles': '计算样式',
      'label.html': 'HTML',
      'label.screenshot': '截图',
      'error.noComposer': '先打开一个会话，再拾取元素',
      'error.busy': '输入框正在发送消息，稍后再试',
      'error.write': '写入输入框失败',
      'error.noPage': '页面还没有准备好',
      'error.noBrowser': '元素拾取需要在内置浏览器标签页中使用',
      'error.inspect': '页面拒绝了检查脚本',
      'delivery.context': '以 context 消息发送',
      'delivery.prefix': '随消息前缀发送',
      'delivery.fallback': '宿主投递失败，已随消息发送',
      'row.selectedTitle': '选中元素',
      'row.selected': '选中元素',
      'row.contextTitle': '上下文注入',
      'row.context': '上下文',
    };

    function makeTranslator(ctx) {
      let service = null;
      try {
        service = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
      } catch (error) {
        service = null;
      }
      if (service) {
        for (const [locale, dict] of [['en', EN], ['zh', ZH]]) {
          try {
            service.register(NS, locale, dict);
          } catch (error) {
            /* A reloaded module may re-register; the dictionary is identical. */
          }
        }
      }
      let bound = null;
      try {
        bound = service && typeof service.bind === 'function' ? service.bind(NS) : null;
      } catch (error) {
        bound = null;
      }
      return (key, params) => {
        let template = key;
        if (bound) {
          try {
            const value = bound(key);
            if (typeof value === 'string' && value && value !== key) template = value;
          } catch (error) {
            /* fall through to the embedded dictionary */
          }
        }
        if (template === key) {
          let active = '';
          try {
            active = service ? String(service.getLocale().active || '') : '';
          } catch (error) {
            active = '';
          }
          if (!active && typeof navigator !== 'undefined') active = String(navigator.language || '');
          template = (active.toLowerCase().startsWith('zh') ? ZH : EN)[key] || EN[key] || key;
        }
        if (params) {
          for (const name of Object.keys(params)) {
            template = template.split('{' + name + '}').join(String(params[name]));
          }
        }
        return template;
      };
    }

    let translate = (key) => EN[key] || key;

    /* ------------------------------------------------------------------ *
     * Store
     * ------------------------------------------------------------------ */

    const state = {
      /** sessionId -> `{ actions, getDraft, getPhase }` published by the binding seat. */
      bindings: new Map(),
      /** sessionId -> Pick[] */
      picks: new Map(),
      /** `{ pickId, sessionId, anchor, pinned }` */
      preview: null,
      /** How the last batch reached the model: 'context' | 'prefix' | null. */
      delivery: null,
      /** `{ webview, toolbar }` while an inspector runs */
      picking: null,
      notice: null,
    };

    const listeners = new Set();
    let noticeTimer = 0;
    let pickSeq = 0;
    let pickToken = 0;

    function emit() {
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch (error) {
          warn(error);
        }
      }
      try {
        renderRail();
      } catch (error) {
        warn(error);
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function useStore() {
      const [, force] = React.useState(0);
      React.useEffect(() => subscribe(() => force((value) => value + 1)), []);
      return state;
    }

    function warn(error) {
      try {
        if (typeof console !== 'undefined' && console.error) console.error(error);
      } catch (ignored) {
        /* no console */
      }
    }

    function notify(text) {
      state.notice = text;
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        noticeTimer = 0;
        state.notice = null;
        emit();
      }, 2800);
      emit();
    }

    function picksOf(sessionId) {
      return state.picks.get(sessionId) || [];
    }

    function activeBinding() {
      const entries = Array.from(state.bindings.entries());
      return entries.length ? entries[0] : null;
    }

    /* --- preview hover intent: 600ms open, 200ms grace, warm latch ------ */

    const OPEN_DELAY = 600;
    const CLOSE_DELAY = 200;
    let openTimer = 0;
    let closeTimer = 0;
    let warm = false;

    function schedulePreview(pick, anchor) {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = 0;
      }
      if (state.preview && state.preview.pinned) return;
      if (state.preview && state.preview.pickId === pick.id) {
        state.preview = { ...state.preview, anchor };
        emit();
        return;
      }
      if (warm || state.preview) {
        warm = true;
        state.preview = { pickId: pick.id, sessionId: pick.sessionId, anchor, pinned: false };
        emit();
        return;
      }
      if (openTimer) clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        openTimer = 0;
        warm = true;
        state.preview = { pickId: pick.id, sessionId: pick.sessionId, anchor, pinned: false };
        emit();
      }, OPEN_DELAY);
    }

    function holdPreview() {
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = 0;
      }
    }

    function releasePreview() {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = 0;
      }
      if (!state.preview) {
        warm = false;
        return;
      }
      if (state.preview.pinned) return;
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        closeTimer = 0;
        if (state.preview && !state.preview.pinned) {
          state.preview = null;
          warm = false;
          emit();
        }
      }, CLOSE_DELAY);
    }

    function pinPreview(pick, anchor) {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = 0;
      }
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = 0;
      }
      const pinned = !!state.preview && state.preview.pickId === pick.id && state.preview.pinned;
      warm = true;
      state.preview = pinned ? null : { pickId: pick.id, sessionId: pick.sessionId, anchor, pinned: true };
      emit();
    }

    function closePreviewNow() {
      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = 0;
      }
      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = 0;
      }
      warm = false;
      if (state.preview) {
        state.preview = null;
        emit();
      }
    }

    /* ------------------------------------------------------------------ *
     * The inspector that runs inside the guest page
     * ------------------------------------------------------------------ */

    /* eslint-disable */
    function pageInspector() {
      var doc = document;
      var win = window;
      var HOST_ATTR = 'data-dsh-element-picker';
      var CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
      var STYLE_PROPS = [
        'display', 'position', 'flex-direction', 'gap', 'width', 'height',
        'padding', 'margin', 'background-color', 'color', 'font-size',
        'font-weight', 'border-radius',
      ];

      return new Promise(function (resolve) {
        var previous = win.__dshElementPicker;
        if (previous && typeof previous.stop === 'function') {
          try { previous.stop(); } catch (error) {}
        }
        var stale = doc.querySelectorAll('[' + HOST_ATTR + ']');
        for (var s = 0; s < stale.length; s++) {
          if (stale[s].parentNode) stale[s].parentNode.removeChild(stale[s]);
        }

        function clean(value) {
          return String(value == null ? '' : value).replace(CONTROL, '');
        }

        function important(element, styles) {
          for (var name in styles) element.style.setProperty(name, styles[name], 'important');
        }

        var host = doc.createElement('div');
        host.setAttribute(HOST_ATTR, '');
        host.setAttribute('aria-hidden', 'true');
        important(host, {
          all: 'initial', position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
          width: '100%', height: '100%', margin: '0', padding: '0', border: '0',
          background: 'transparent', overflow: 'hidden', 'pointer-events': 'none',
          'z-index': '2147483647', display: 'block', 'box-sizing': 'border-box',
        });

        var root = host;
        try {
          root = host.attachShadow({ mode: 'closed' });
        } catch (error) {
          root = host;
        }

        var layer = doc.createElement('div');
        important(layer, { all: 'initial', display: 'contents' });
        root.appendChild(layer);

        var box = doc.createElement('div');
        important(box, {
          all: 'initial', position: 'fixed', 'box-sizing': 'border-box', display: 'block',
          'border-radius': '4px', 'pointer-events': 'none', opacity: '0',
          border: '1px solid rgba(236, 131, 90, .55)', background: 'rgba(236, 131, 90, .06)',
          transition: 'left 180ms cubic-bezier(0.16, 1, 0.3, 1), top 180ms cubic-bezier(0.16, 1, 0.3, 1), width 180ms cubic-bezier(0.16, 1, 0.3, 1), height 180ms cubic-bezier(0.16, 1, 0.3, 1), background 200ms ease-out, border-color 200ms ease-out, opacity 160ms ease-out',
          'z-index': '2147483646',
        });
        layer.appendChild(box);

        var label = doc.createElement('div');
        important(label, {
          all: 'initial', position: 'fixed', display: 'block', 'box-sizing': 'border-box',
          height: '18px', 'line-height': '18px', padding: '0 6px', 'border-radius': '4px',
          'background-color': '#d95926', color: '#ffffff',
          font: '500 11px/18px system-ui, sans-serif',
          'max-width': '240px', overflow: 'hidden', 'text-overflow': 'ellipsis',
          'white-space': 'nowrap', 'pointer-events': 'none', opacity: '0',
          transition: 'left 180ms cubic-bezier(0.16, 1, 0.3, 1), top 180ms cubic-bezier(0.16, 1, 0.3, 1), opacity 160ms ease-out',
          'z-index': '2147483647',
        });
        layer.appendChild(label);

        if (doc.documentElement) doc.documentElement.appendChild(host);

        var pointerX = -1;
        var pointerY = -1;
        var current = null;
        var stopped = false;
        /* Keep the page's own pointer: the shipped picker never swaps in a crosshair. */

        function viewportOffsets() {
          var view = win.visualViewport;
          return view ? { left: view.offsetLeft || 0, top: view.offsetTop || 0 } : { left: 0, top: 0 };
        }

        function hitTest(x, y) {
          var stack;
          try {
            stack = doc.elementsFromPoint ? doc.elementsFromPoint(x, y) : [doc.elementFromPoint(x, y)];
          } catch (error) {
            return null;
          }
          for (var i = 0; i < stack.length; i++) {
            var node = stack[i];
            if (!node || node.nodeType !== 1) continue;
            if (node === host) continue;
            if (node === doc.documentElement || node === doc.body) continue;
            return node;
          }
          return null;
        }

        function labelFor(element) {
          var tag = (element.tagName || '').toLowerCase();
          var id = '';
          var classes = '';
          try {
            id = element.getAttribute('id') || '';
            classes = element.getAttribute('class') || '';
          } catch (error) {}
          var first = classes.split(/\s+/)[0] || '';
          var suffix = id ? '#' + id : first ? '.' + first : '';
          return clean(tag + suffix).slice(0, 64);
        }

        function draw(element) {
          if (!element) {
            box.style.setProperty('opacity', '0', 'important');
            label.style.setProperty('opacity', '0', 'important');
            return;
          }
          var rect = element.getBoundingClientRect();
          var offsets = viewportOffsets();
          var x = rect.left + offsets.left;
          var y = rect.top + offsets.top;
          box.style.setProperty('left', x + 'px', 'important');
          box.style.setProperty('top', y + 'px', 'important');
          box.style.setProperty('width', Math.max(0, rect.width) + 'px', 'important');
          box.style.setProperty('height', Math.max(0, rect.height) + 'px', 'important');
          box.style.setProperty('background', 'rgba(236, 131, 90, .06)', 'important');
          box.style.setProperty('border-color', 'rgba(236, 131, 90, .55)', 'important');
          box.style.setProperty('opacity', '1', 'important');

          label.textContent = labelFor(element);
          var viewWidth = doc.documentElement.clientWidth || win.innerWidth;
          var top = y >= 20 ? y - 20 : Math.max(0, y) + 2;
          var left = Math.max(0, Math.min(x, viewWidth - label.offsetWidth - 2));
          label.style.setProperty('top', top + 'px', 'important');
          label.style.setProperty('left', left + 'px', 'important');
          label.style.setProperty('opacity', '1', 'important');
        }

        function track() {
          if (stopped || pointerX < 0) return;
          current = hitTest(pointerX, pointerY);
          draw(current);
        }

        /* ---- context capture ---- */

        function fiberOf(node) {
          if (!node || typeof node !== 'object') return null;
          var keys;
          try { keys = Object.getOwnPropertyNames(node); } catch (error) { return null; }
          for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
              var fiber = node[key];
              if (fiber && typeof fiber === 'object') return fiber;
            }
          }
          return null;
        }

        function usefulName(name) {
          if (typeof name !== 'string') return '';
          var trimmed = name.trim();
          if (!trimmed || trimmed.length < 2) return '';
          if (trimmed === 'Anonymous' || trimmed === 'Fragment') return '';
          if (/^_c\d*$/.test(trimmed)) return '';
          return trimmed.slice(0, 100);
        }

        var COMPONENT_TAGS = { 0: true, 1: true, 11: true, 14: true, 15: true };

        function typeName(type, depth) {
          if (!type || depth > 3) return '';
          if (typeof type === 'string') return '';
          if (typeof type === 'function') return usefulName(type.displayName || type.name);
          if (typeof type === 'object') {
            var own = usefulName(type.displayName);
            if (own) return own;
            return typeName(type.type, depth + 1) || typeName(type.render, depth + 1);
          }
          return '';
        }

        function summarizeValue(value) {
          if (value === null || value === undefined) return String(value);
          var type = typeof value;
          if (type === 'string') return clean(value).slice(0, 160);
          if (type === 'number' || type === 'boolean') return String(value);
          if (type === 'function') return '[function]';
          if (type === 'object') {
            try {
              if (Array.isArray(value)) return '[array(' + value.length + ')]';
              if (value.$$typeof) return '[element]';
            } catch (error) {
              return '[object]';
            }
            return '[object]';
          }
          return String(value);
        }

        function summarizeProps(props) {
          var out = {};
          if (!props || typeof props !== 'object') return out;
          var keys;
          try { keys = Object.keys(props); } catch (error) { return out; }
          var count = 0;
          for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key === 'children' || key === 'ref' || key === 'key' || key === '__proto__') continue;
            if (count >= 20) {
              out['…'] = '+' + (keys.length - count) + ' more';
              break;
            }
            try {
              out[key] = summarizeValue(props[key]);
            } catch (error) {
              out[key] = '[unreadable]';
            }
            count += 1;
          }
          return out;
        }

        function inspectComponent(element) {
          var empty = { name: '', owners: [], props: {} };
          var start = fiberOf(element);
          if (!start) return empty;
          var fiber = start;
          var guard = 0;
          var found = null;
          while (fiber && guard < 400) {
            if (COMPONENT_TAGS[fiber.tag] === true) {
              var name = typeName(fiber.elementType || fiber.type, 0);
              if (name) {
                found = { fiber: fiber, name: name };
                break;
              }
            }
            fiber = fiber.return;
            guard += 1;
          }
          if (!found) return empty;
          var owners = [];
          var owner = found.fiber._debugOwner;
          guard = 0;
          while (owner && owners.length < 4 && guard < 24) {
            var ownerName = typeName(owner.elementType || owner.type, 0);
            if (ownerName && owners[owners.length - 1] !== ownerName) owners.push(ownerName);
            owner = owner._debugOwner;
            guard += 1;
          }
          var props = {};
          try {
            props = summarizeProps(found.fiber.memoizedProps);
          } catch (error) {
            props = {};
          }
          return { name: found.name, owners: owners, props: props };
        }

        function sourceOf(element) {
          var fiber = fiberOf(element);
          var guard = 0;
          while (fiber && guard < 60) {
            var source = fiber._debugSource;
            if (source && source.fileName) {
              return clean(source.fileName) + (source.lineNumber ? ':' + source.lineNumber : '');
            }
            fiber = fiber.return;
            guard += 1;
          }
          return '';
        }

        function selectorPath(element) {
          var parts = [];
          var node = element;
          var depth = 0;
          while (node && node.nodeType === 1 && depth < 4) {
            var part = (node.tagName || '').toLowerCase();
            var id = '';
            var classes = '';
            try {
              id = node.getAttribute('id') || '';
              classes = node.getAttribute('class') || '';
            } catch (error) {}
            if (id) {
              part += '#' + id;
            } else {
              var list = classes.split(/\s+/).filter(Boolean).slice(0, 2);
              if (list.length) part += '.' + list.join('.');
            }
            parts.unshift(part);
            node = node.parentElement;
            depth += 1;
          }
          return clean(parts.join(' > ')).slice(0, 300);
        }

        function capture(element) {
          var styles = {};
          try {
            var computed = win.getComputedStyle(element);
            for (var i = 0; i < STYLE_PROPS.length; i++) {
              var property = STYLE_PROPS[i];
              var value = computed.getPropertyValue(property);
              if (value && value.trim()) styles[property] = value.trim().slice(0, 80);
            }
          } catch (error) {}

          var attributes = {};
          var names = ['role', 'aria-label', 'type', 'name', 'placeholder', 'href', 'title', 'alt', 'data-testid', 'value'];
          for (var n = 0; n < names.length; n++) {
            try {
              var attribute = element.getAttribute(names[n]);
              if (attribute) attributes[names[n]] = clean(attribute).slice(0, 120);
            } catch (error) {}
          }

          var classes = '';
          var id = '';
          try {
            classes = element.getAttribute('class') || '';
            id = element.getAttribute('id') || '';
          } catch (error) {}

          var html = '';
          try {
            html = clean(element.outerHTML || '').slice(0, 1200);
          } catch (error) {}

          var text = '';
          try {
            text = clean(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
          } catch (error) {}

          return {
            tag: (element.tagName || '').toLowerCase(),
            id: clean(id).slice(0, 80),
            classes: clean(classes).split(/\s+/).filter(Boolean).slice(0, 8),
            attributes: attributes,
            text: text,
            selector: selectorPath(element),
            styles: styles,
            html: html,
            component: inspectComponent(element),
            source: sourceOf(element),
          };
        }

        /* ---- events ---- */

        function hit(event) {
          pointerX = event.clientX;
          pointerY = event.clientY;
          track();
        }

        function onPointerMove(event) {
          if (event.pointerType === 'touch') return;
          hit(event);
        }

        function onScrollOrResize() {
          track();
        }

        function swallow(event) {
          event.preventDefault();
          event.stopPropagation();
        }

        function onClick(event) {
          event.preventDefault();
          event.stopPropagation();
          var element = current || hitTest(event.clientX, event.clientY);
          if (!element) return;
          var payload = capture(element);
          var rect = element.getBoundingClientRect();
          finish({
            ok: true,
            element: payload,
            rect: {
              left: rect.left + 0, top: rect.top + 0,
              width: rect.width + 0, height: rect.height + 0,
            },
            viewport: { width: win.innerWidth, height: win.innerHeight },
            url: String(win.location ? win.location.href : ''),
            title: clean(doc.title || '').slice(0, 160),
          });
        }

        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish(null);
          }
        }

        function onContextMenu(event) {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }

        function detach() {
          stopped = true;
          win.removeEventListener('pointermove', onPointerMove, true);
          win.removeEventListener('scroll', onScrollOrResize, true);
          win.removeEventListener('resize', onScrollOrResize, true);
          win.removeEventListener('pointerdown', swallow, true);
          win.removeEventListener('mousedown', swallow, true);
          win.removeEventListener('click', onClick, true);
          win.removeEventListener('contextmenu', onContextMenu, true);
          win.removeEventListener('keydown', onKeyDown, true);
          if (win.__dshElementPicker && win.__dshElementPicker.owner === owner) delete win.__dshElementPicker;
        }

        function removeHost() {
          if (host.parentNode) host.parentNode.removeChild(host);
        }

        /* Resolve at once; the picked box stays for 4s like the shipped picker. */
        function finish(result) {
          if (stopped) return;
          detach();
          if (result) {
            box.style.setProperty('border-color', 'rgba(236, 131, 90, .9)', 'important');
            box.style.setProperty('background', 'rgba(236, 131, 90, .16)', 'important');
            label.style.setProperty('opacity', '0', 'important');
            win.setTimeout(removeHost, 4000);
          } else {
            removeHost();
          }
          resolve(result);
        }

        var owner = {};
        win.__dshElementPicker = {
          owner: owner,
          stop: function () {
            if (stopped) return;
            detach();
            removeHost();
            resolve(null);
          },
        };

        win.addEventListener('pointermove', onPointerMove, true);
        win.addEventListener('scroll', onScrollOrResize, true);
        win.addEventListener('resize', onScrollOrResize, true);
        win.addEventListener('pointerdown', swallow, true);
        win.addEventListener('mousedown', swallow, true);
        win.addEventListener('click', onClick, true);
        win.addEventListener('contextmenu', onContextMenu, true);
        win.addEventListener('keydown', onKeyDown, true);
      });
    }
    /* eslint-enable */

    const INSPECTOR_SOURCE = `(${pageInspector.toString()})()`;

    /* ------------------------------------------------------------------ *
     * Browser integration
     * ------------------------------------------------------------------ */

    const VIEW_ATTR = 'data-sidebar-browser-frame';

    function visible(node) {
      if (!node || !node.isConnected) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    }

    function webviewOf(node) {
      return node && typeof node.executeJavaScript === 'function' ? node : null;
    }

    function findToolbar(webview) {
      let node = webview.parentElement;
      for (let depth = 0; node && depth < 6; depth += 1) {
        const form = node.querySelector && node.querySelector('form[class*="toolbar"]');
        if (form) return form;
        node = node.parentElement;
      }
      /* Fallback: the pane's only form is the address row. */
      let root = webview.parentElement;
      for (let depth = 0; root && depth < 4; depth += 1) {
        const forms = root.querySelectorAll ? Array.from(root.querySelectorAll('form')) : [];
        const withInput = forms.find((form) => form.querySelector('input'));
        if (withInput) return withInput;
        root = root.parentElement;
      }
      return null;
    }

    function createToolButton(toolLabel) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `${PREFIX}-tool`;
      button.setAttribute(HOST_ATTRIBUTE, '');
      button.setAttribute('aria-label', toolLabel);
      button.title = toolLabel;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '15');
      svg.setAttribute('height', '15');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.9');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arrow.setAttribute('d', 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.58 6.125a.5.5 0 0 1-.947.063z');
      svg.appendChild(arrow);
      button.appendChild(svg);
      return button;
    }

    /** One tool button per live Browser tab, kept inside the shipped toolbar. */
    const toolbarButton = new WeakMap();

    function toolButtons() {
      return Array.from(document.querySelectorAll(`button.${PREFIX}-tool`));
    }

    function refreshToolStates() {
      const active = state.picking ? state.picking.webview : null;
      for (const button of toolButtons()) {
        const on = !!active && button.__dshWebview === active;
        button.setAttribute('data-active', on ? 'true' : 'false');
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        button.title = on ? translate('pick.busy') : translate('pick.title');
      }
    }

    function ensureToolButtons() {
      const label = translate('pick.title');
      let webviews = [];
      try {
        webviews = Array.from(document.querySelectorAll(`[${VIEW_ATTR}="webview"]`));
      } catch (error) {
        webviews = [];
      }
      for (const webview of webviews) {
        if (!visible(webview)) continue;
        const toolbar = findToolbar(webview);
        if (!toolbar) continue;
        let button = toolbarButton.get(webview);
        if (!button || !button.isConnected) {
          button = createToolButton(label);
          button.__dshWebview = webview;
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            togglePick(webview, button);
          });
          toolbarButton.set(webview, button);
        }
        if (button.parentElement !== toolbar) toolbar.appendChild(button);
        if (button.title !== label && !state.picking) button.title = label;
      }
      for (const button of toolButtons()) {
        if (!button.isConnected) button.remove();
      }
      refreshToolStates();
    }

    function stopPicking() {
      const current = state.picking;
      if (!current) return;
      state.picking = null;
      try {
        const webview = current.webview;
        if (webview && typeof webview.executeJavaScript === 'function') {
          webview.executeJavaScript('window.__dshElementPicker && window.__dshElementPicker.stop && window.__dshElementPicker.stop()').catch(() => {});
        }
      } catch (error) {
        /* the guest is gone */
      }
      refreshToolStates();
      emit();
    }

    function togglePick(webview, button) {
      if (state.picking && state.picking.webview === webview) {
        stopPicking();
        return;
      }
      startPick(webview, button);
    }

    async function startPick(webview, button) {
      if (state.picking) stopPicking();
      const bindingEntry = activeBinding();
      if (!bindingEntry) {
        notify(translate('error.noComposer'));
        return;
      }
      const token = ++pickToken;
      state.picking = { webview, button, token };
      refreshToolStates();
      emit();

      let result = null;
      try {
        result = await webview.executeJavaScript(INSPECTOR_SOURCE, true);
      } catch (error) {
        warn(error);
        notify(translate('error.inspect'));
      } finally {
        if (state.picking && state.picking.token === token) state.picking = null;
        refreshToolStates();
        emit();
      }

      if (!result || result.ok !== true || !result.element) return;
      await completePick(webview, result, bindingEntry);
    }

    async function captureScreenshot(webview, rect, viewport) {
      try {
        if (!webview || typeof webview.capturePage !== 'function') return null;
        const pad = 80;
        const width = Math.max(1, Math.round(viewport && viewport.width ? viewport.width : webview.getBoundingClientRect().width));
        const height = Math.max(1, Math.round(viewport && viewport.height ? viewport.height : webview.getBoundingClientRect().height));
        const x = Math.max(0, Math.floor(rect.left - pad));
        const y = Math.max(0, Math.floor(rect.top - pad));
        const cropWidth = Math.min(width - x, Math.ceil(rect.width + pad * 2));
        const cropHeight = Math.min(height - y, Math.ceil(rect.height + pad * 2));
        let image = webview.capturePage({
          x,
          y,
          width: Math.max(1, cropWidth),
          height: Math.max(1, cropHeight),
        });
        if (image && typeof image.then === 'function') image = await image;
        if (!image) return null;
        const size = typeof image.getSize === 'function' ? image.getSize() : null;
        const longest = size ? Math.max(size.width, size.height) : 0;
        if (size && longest > 1200) {
          const scale = 1200 / longest;
          image = image.resize({
            width: Math.max(1, Math.round(size.width * scale)),
            height: Math.max(1, Math.round(size.height * scale)),
          });
        }
        const dataUrl = typeof image.toDataURL === 'function' ? image.toDataURL() : null;
        return dataUrl ? { dataUrl, crop: { x, y, width: Math.max(1, cropWidth), height: Math.max(1, cropHeight) } } : null;
      } catch (error) {
        warn(error);
        return null;
      }
    }

    /** Draw the picked element's bounds on the crop, the way the shipped card shows it. */
    async function annotateScreenshot(shot, rect) {
      if (!shot || !shot.dataUrl) return null;
      try {
        const image = document.createElement('img');
        image.src = shot.dataUrl;
        if (typeof image.decode === 'function') {
          await image.decode();
        } else {
          await new Promise((resolve, reject) => {
            image.onload = resolve;
            image.onerror = reject;
          });
        }
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context) return shot.dataUrl;
        context.drawImage(image, 0, 0);
        const scale = canvas.width / Math.max(1, shot.crop.width);
        const x = (rect.left - shot.crop.x) * scale;
        const y = (rect.top - shot.crop.y) * scale;
        const width = Math.max(1, rect.width * scale);
        const height = Math.max(1, rect.height * scale);
        const radius = Math.min(6 * scale, width / 2, height / 2);
        context.lineWidth = Math.max(1.5, 1.5 * scale);
        context.strokeStyle = 'rgba(236, 131, 90, .9)';
        context.beginPath();
        context.moveTo(x + radius, y);
        context.arcTo(x + width, y, x + width, y + height, radius);
        context.arcTo(x + width, y + height, x, y + height, radius);
        context.arcTo(x, y + height, x, y, radius);
        context.arcTo(x, y, x + width, y, radius);
        context.closePath();
        context.stroke();
        return canvas.toDataURL('image/png');
      } catch (error) {
        warn(error);
        return shot.dataUrl;
      }
    }

    function escapeXml(value) {
      return String(value == null ? '' : value)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/[&<>"']/g, (char) => {
          switch (char) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return '&apos;';
          }
        });
    }

    function elementTitle(data) {
      if (!data) return 'element';
      if (data.component && data.component.name) return `<${data.component.name} />`;
      if (data.id) return `${data.tag}#${data.id}`;
      const first = (data.classes || [])[0];
      return first ? `${data.tag}.${first}` : data.tag;
    }

    function oneLine(value, max) {
      return String(value == null ? '' : value)
        .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
    }

    /**
     * One self-describing line. dsh renders the submitted prompt verbatim (there
     * is no hidden-block stripping and no Host bridge in this profile), so the
     * payload stays compact and readable instead of a multi-line XML document.
     */
    function formatBlock(data) {
      const component = data.component || { name: '', owners: [], props: {} };
      const parts = ['<selected-element'];
      if (component.name) parts.push(`component=${component.name}`);
      parts.push(`tag=${data.tag}`);
      if (data.id) parts.push(`id=${data.id}`);
      if (data.classes && data.classes.length) parts.push(`class="${oneLine(data.classes.join(' '), 120)}"`);
      if (component.owners && component.owners.length) parts.push(`owners="${oneLine(component.owners.join(' > '), 120)}"`);
      if (data.text) parts.push(`text="${oneLine(data.text, 160)}"`);
      if (data.selector) parts.push(`selector="${oneLine(data.selector, 220)}"`);
      if (data.source) parts.push(`source=${oneLine(data.source, 160)}`);
      const props = component.props || {};
      if (Object.keys(props).length) {
        let serialised = '';
        try {
          serialised = JSON.stringify(props);
        } catch (error) {
          serialised = '';
        }
        if (serialised) parts.push(`props='${oneLine(serialised, 300).replace(/'/g, '’')}'`);
      }
      return `${parts.join(' ')} />`;
    }

    function withTimeout(promise, ms) {
      return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms)),
      ]);
    }

    /**
     * L1/L2 only: store the context object and draw the pill. The draft stays
     * untouched; `flushContexts` serializes at submit time (see §5.6.1).
     */
    async function completePick(webview, result, bindingEntry) {
      const [sessionId, binding] = bindingEntry;
      const data = result.element;
      const shot = await captureScreenshot(webview, result.rect, result.viewport);

      pickSeq += 1;
      const pick = {
        id: `pick-${pickSeq}`,
        sessionId,
        label: elementTitle(data),
        data,
        screenshot: shot ? shot.dataUrl : null,
        url: result.url || '',
        title: result.title || '',
      };
      const list = picksOf(sessionId).slice();
      list.push(pick);
      state.picks.set(sessionId, list);
      emit();

    }

    function removePick(sessionId, pickId) {
      const list = picksOf(sessionId);
      const index = list.findIndex((entry) => entry.id === pickId);
      if (index < 0) return;
      const remaining = list.filter((entry) => entry.id !== pickId);
      if (remaining.length) state.picks.set(sessionId, remaining);
      else state.picks.delete(sessionId);
      if (state.preview && state.preview.pickId === pickId) closePreviewNow();
      emit();
    }

    /* ------------------------------------------------------------------ *
     * L3 — serialize at submit time and never into the editable value
     * ------------------------------------------------------------------ */

    function pendingSerialization(sessionId) {
      const list = picksOf(sessionId);
      if (!list.length) return '';
      return list.map((pick) => formatBlock(pick.data)).join('\n\n');
    }

    /**
     * Delivery mode, decided once per page load by probing the Host route.
     *   'context' — the Host half answers, so the block becomes a model-facing
     *               context message and the prompt stays clean.
     *   'prefix'  — no Host route (plugin Host half not active); the block is
     *               written ahead of the prompt instead.
     */
    const STATE_URL = 'component-picker/state';
    const STAGE_URL = 'component-picker/stage';

    let hostMode = null;
    let hostProbe = null;

    /** Report the browser half's boot state to the Host diagnostics route. */
    function reportBoot(payload) {
      try {
        const body = encodeURIComponent(JSON.stringify(payload));
        void fetch(`${STATE_URL}?boot=${body}`, { credentials: 'same-origin' });
      } catch (error) {
        /* diagnostics must never break the plugin */
      }
    }

    function resolveHostMode() {
      if (hostMode !== null) return Promise.resolve(hostMode);
      if (hostProbe) return hostProbe;
      hostProbe = (async () => {
        let mode = 'prefix';
        try {
          const response = await fetch(STATE_URL, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          });
          const data = await response.json().catch(() => null);
          if (response.ok && data && data.ok === true) mode = 'context';
        } catch (error) {
          mode = 'prefix';
        }
        /* Cache success only: a Host half loaded later gets another chance. */
        if (mode === 'context') hostMode = 'context';
        hostProbe = null;
        emit();
        return mode;
      })();
      return hostProbe;
    }

    let lastStageFailure = '';

    async function stageOnHost(sessionId, text, summary) {
      try {
        const response = await fetch(STAGE_URL, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, text, summary }),
        });
        const data = await response.json().catch(() => null);
        if (data && data.ok === true) {
          lastStageFailure = '';
          return true;
        }
        lastStageFailure = `HTTP ${response.status}${data && data.reason ? ' ' + data.reason : ''}`;
        return false;
      } catch (error) {
        lastStageFailure = String(error && error.message ? error.message : error);
        return false;
      }
    }

    /**
     * L3: serialize at submit. The mode decides whether the block becomes a
     * Host-injected context message or a prefix of the prompt.
     */
    async function flushContexts(sessionId, binding) {
      const list = picksOf(sessionId);
      if (!list.length) return false;
      const xml = list.map((pick) => formatBlock(pick.data)).join('\n\n');
      const summary = list.length === 1
        ? `Selected ${elementTitle(list[0].data)}`
        : `${list.length} selected elements`;
      const mode = hostMode === null ? await resolveHostMode() : hostMode;

      if (mode === 'context' && (await stageOnHost(sessionId, xml, summary))) {
        state.delivery = 'context';
        state.picks.delete(sessionId);
        closePreviewNow();
        emit();
        try {
          binding.actions.submit();
        } catch (error) {
          warn(error);
        }
        return true;
      }

      state.delivery = 'prefix';
      if (lastStageFailure) {
        notify(`${translate('delivery.fallback')} (${lastStageFailure})`);
        lastStageFailure = '';
      }
      const draft = binding.getDraft() || '';
      const body = draft.trim() ? `${xml}\n\n${draft}` : xml;
      const restore = { draft, picks: list.slice() };
      /* Insert at the document start so inline reference chips survive. */
      let written = false;
      try {
        const actions = binding.actions;
        if (typeof actions.captureInsertion === 'function' && typeof actions.insertText === 'function') {
          const span = actions.captureInsertion();
          if (span) {
            const insert = draft.trim() ? `${xml}\n\n` : xml;
            written = actions.insertText(insert, { start: 0, end: 0, draftRev: span.draftRev }) === true;
          }
        }
      } catch (error) {
        warn(error);
      }
      if (!written) binding.actions.setDraft(body);
      state.picks.delete(sessionId);
      closePreviewNow();
      emit();
      setTimeout(() => {
        try {
          binding.actions.submit();
        } catch (error) {
          warn(error);
          state.picks.set(sessionId, restore.picks);
          try {
            binding.actions.setDraft(restore.draft);
          } catch (ignored) {
            /* the composer is gone */
          }
          emit();
        }
      }, 0);
      return true;
    }

    function composerEditorOf(node) {
      if (!node || !node.closest) return null;
      return node.closest('[contenteditable="true"]');
    }

    const SEND_NAME = /^(send|submit|发送|提交|发送消息)/i;

    function isSendControl(button) {
      if (!button) return false;
      if (button.type === 'submit') return true;
      const name = `${button.getAttribute('aria-label') || ''} ${button.getAttribute('title') || ''} ${button.textContent || ''}`.trim();
      return SEND_NAME.test(name);
    }

    /**
     * Capture-phase submit interception: Enter in the composer, or the Send
     * control inside it. Only when contexts are pending and the input is plain.
     */
    function installSubmitHook(ctx) {
      const onKeyDown = (event) => {
        if (event.key !== 'Enter' || event.isComposing || event.shiftKey) return;
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        if (!composerEditorOf(event.target)) return;
        const entry = activeBinding();
        if (!entry) return;
        const [sessionId, binding] = entry;
        if (!picksOf(sessionId).length) return;
        if (typeof binding.getPhase === 'function' && binding.getPhase() !== 'plain') return;
        event.preventDefault();
        event.stopPropagation();
        void flushContexts(sessionId, binding);
      };

      const onPointerDown = (event) => {
        const button = event.target && event.target.closest ? event.target.closest('button') : null;
        if (!button || !isSendControl(button)) return;
        if (button.closest(`[${HOST_ATTRIBUTE}]`)) return;
        const entry = activeBinding();
        if (!entry) return;
        const [sessionId, binding] = entry;
        if (!picksOf(sessionId).length) return;
        if (typeof binding.getPhase === 'function' && binding.getPhase() !== 'plain') return;
        event.preventDefault();
        event.stopPropagation();
        void flushContexts(sessionId, binding);
      };

      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('pointerdown', onPointerDown, true);
      return () => {
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('pointerdown', onPointerDown, true);
      };
    }

    /* ------------------------------------------------------------------ *
     * Components
     * ------------------------------------------------------------------ */

    /** Claude's element-context glyph: a pointer arrow, not code brackets. */
    function CursorIcon(props) {
      const size = (props && props.size) || 13;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round',
          strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
        },
        h('path', { d: 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.58 6.125a.5.5 0 0 1-.947.063z' }),
      );
    }

    function storeDelivery() {
      return state.delivery;
    }

    function CardRow(props) {
      return [h('dt', { key: 'dt' }, props.label), h('dd', { key: 'dd' }, props.children)];
    }

    function PreviewCard(props) {
      const { pick, anchor, pinned, viewport, t } = props;
      const [expanded, setExpanded] = React.useState(false);
      const data = pick.data || {};

      const width = 320;
      const gap = 8;
      const vw = viewport.width || 0;
      const vh = viewport.height || 0;
      const left = Math.max(8, Math.min(anchor ? anchor.left : 8, Math.max(8, vw - width - 8)));
      const spaceAbove = anchor ? anchor.top - 8 : 0;
      const spaceBelow = anchor ? vh - anchor.bottom - 8 : 0;
      /* top-start first, like the shipped floating card; flip only when cramped. */
      const placeBelow = !anchor || (spaceAbove < 240 && spaceBelow > spaceAbove);
      const style = { width: `${width}px`, left: `${left}px` };
      if (anchor) {
        if (placeBelow) style.top = `${Math.min(anchor.bottom + gap, Math.max(8, vh - 80))}px`;
        else style.bottom = `${Math.max(8, vh - anchor.top + gap)}px`;
      }

      const main = [];
      main.push(h(CardRow, { key: 'element', label: t('label.element') }, h('span', { dir: 'ltr' }, elementTitle(data))));
      if (data.component && data.component.name) {
        const owners = data.component.owners || [];
        main.push(
          h(
            CardRow,
            { key: 'component', label: t('label.component') },
            h('code', { className: `${PREFIX}-mono` }, data.component.name),
            owners.length
              ? h('span', { className: `${PREFIX}-muted` }, ' ' + t('label.owners', { owners: owners.join(' › ') }))
              : null,
          ),
        );
      }
      const componentProps = (data.component && data.component.props) || {};
      const propKeys = Object.keys(componentProps);
      if (propKeys.length) {
        main.push(
          h('dt', { key: 'props-dt' }, t('label.props')),
          h(
            'dd',
            { key: 'props-dd' },
            h(
              'dl',
              { className: `${PREFIX}-dl ${PREFIX}-dl--nested` },
              propKeys.map((name) =>
                h(
                  React.Fragment,
                  { key: name },
                  h('dt', null, name),
                  h('dd', null, h('span', { className: `${PREFIX}-mono` }, String(componentProps[name]))),
                ),
              ),
            ),
          ),
        );
      }
      if (data.source) {
        main.push(h(CardRow, { key: 'source', label: t('label.source') }, h('code', { className: `${PREFIX}-mono` }, data.source)));
      }
      if (data.text) {
        main.push(h(CardRow, { key: 'text', label: t('label.text') }, h('span', null, data.text.slice(0, 160))));
      }

      const extra = [];
      extra.push(
        h('dt', { key: 'selector-dt' }, t('label.selector')),
        h('dd', { key: 'selector-dd' }, h('code', { className: `${PREFIX}-mono` }, data.selector || '—')),
      );
      const styleEntries = Object.entries(data.styles || {});
      if (styleEntries.length) {
        extra.push(
          h('dt', { key: 'styles-dt' }, t('label.styles')),
          h(
            'dd',
            { key: 'styles-dd' },
            h(
              'dl',
              { className: `${PREFIX}-dl ${PREFIX}-dl--nested` },
              styleEntries.map(([name, value]) =>
                h(
                  React.Fragment,
                  { key: name },
                  h('dt', null, name),
                  h('dd', null, h('span', { className: `${PREFIX}-mono` }, String(value))),
                ),
              ),
            ),
          ),
        );
      }
      if (data.html) {
        extra.push(
          h('dt', { key: 'html-dt' }, t('label.html')),
          h('dd', { key: 'html-dd' }, h('pre', { className: `${PREFIX}-code`, dir: 'ltr' }, data.html)),
        );
      }
      const extraCount = extra.length / 2;

      return h(
        'div',
        {
          className: `${PREFIX}-card`,
          style,
          role: pinned ? 'dialog' : 'group',
          'aria-label': pinned ? t('card.heading') : undefined,
          [HOST_ATTRIBUTE]: '',
          onMouseEnter: holdPreview,
          onMouseLeave: releasePreview,
        },
        h(
          'div',
          { className: `${PREFIX}-card__head` },
          h('span', { className: `${PREFIX}-chip__glyph` }, h(CursorIcon, { size: 13 })),
          h('span', null, t('card.heading')),
        ),
        pick.screenshot
          ? h('img', {
              className: `${PREFIX}-shot`,
              src: pick.screenshot,
              alt: t('label.screenshot'),
              draggable: false,
            })
          : null,
        h('dl', { className: `${PREFIX}-dl` }, main),
        extraCount
          ? h(
              'button',
              {
                type: 'button',
                className: `${PREFIX}-link`,
                onClick: () => setExpanded((value) => !value),
                'aria-expanded': expanded,
              },
              expanded ? t('card.less') : t('card.more', { count: extraCount }),
            )
          : null,
        extraCount && expanded ? h('dl', { className: `${PREFIX}-dl` }, extra) : null,
        storeDelivery()
          ? h('div', { className: `${PREFIX}-card__foot` }, storeDelivery() === 'context' ? t('delivery.context') : t('delivery.prefix'))
          : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * Pills — inside the composer card, above the editor (⑤ layout spec)
     * ------------------------------------------------------------------ */

    const RAIL_SELECTOR = '[data-dsh-cp-rail]';
    let railSignature = '';

    function composerEditorElement() {
      let nodes = [];
      try {
        nodes = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      } catch (error) {
        return null;
      }
      const visibleNodes = nodes.filter((node) => node.isConnected && node.getClientRects().length > 0);
      return visibleNodes[0] || nodes[0] || null;
    }

    /** The composer card above the editor, plus the editor's left offset inside it. */
    function railHost(editor) {
      const editorRect = editor.getBoundingClientRect();
      let node = editor.parentElement;
      let guard = 0;
      while (node && guard < 5) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > editorRect.height + 40) {
          return { host: node, offset: Math.max(0, Math.round(editorRect.left - rect.left)) };
        }
        node = node.parentElement;
        guard += 1;
      }
      const parent = editor.parentElement;
      if (!parent) return null;
      const rect = parent.getBoundingClientRect();
      return { host: parent, offset: Math.max(0, Math.round(editorRect.left - rect.left)) };
    }

    function ensureRail(create) {
      const editor = composerEditorElement();
      if (!editor) return null;
      let rail = document.querySelector(RAIL_SELECTOR);
      if (!rail) {
        if (!create) return null;
        rail = document.createElement('div');
        rail.className = `${PREFIX}-rail`;
        rail.setAttribute('data-dsh-cp-rail', '');
        rail.setAttribute(HOST_ATTRIBUTE, '');
      }
      const target = railHost(editor);
      if (!target) return null;
      if (rail.parentElement !== target.host || rail !== target.host.firstElementChild) {
        target.host.insertBefore(rail, target.host.firstChild);
      }
      /* The pill column starts where the editor starts, not under the "+" control. */
      rail.style.paddingInlineStart = `${Math.max(8, target.offset)}px`;
      return rail;
    }

    function pillGlyph() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '14');
      svg.setAttribute('height', '14');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.9');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.58 6.125a.5.5 0 0 1-.947.063z');
      svg.appendChild(path);
      return svg;
    }

    function createPill(pick) {
      const chip = document.createElement('div');
      chip.className = `${PREFIX}-chip`;
      chip.setAttribute(HOST_ATTRIBUTE, '');
      chip.dataset.pickId = pick.id;

      const anchor = () => {
        const rect = chip.getBoundingClientRect();
        return { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right };
      };

      const main = document.createElement('button');
      main.type = 'button';
      main.className = `${PREFIX}-chip__main`;
      main.title = pick.label;
      main.setAttribute('aria-haspopup', 'dialog');
      main.setAttribute('aria-expanded', 'false');
      const glyph = document.createElement('span');
      glyph.className = `${PREFIX}-chip__glyph`;
      glyph.appendChild(pillGlyph());
      const label = document.createElement('span');
      label.className = `${PREFIX}-chip__label`;
      label.textContent = pick.label;
      main.appendChild(glyph);
      main.appendChild(label);
      main.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        pinPreview(pick, anchor());
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = `${PREFIX}-chip__remove`;
      remove.setAttribute('aria-label', translate('chip.remove'));
      remove.title = translate('chip.remove');
      remove.textContent = '×';
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removePick(pick.sessionId, pick.id);
      });

      chip.addEventListener('mouseenter', () => schedulePreview(pick, anchor()));
      chip.addEventListener('mouseleave', releasePreview);
      chip.addEventListener('focusin', () => schedulePreview(pick, anchor()));

      chip.appendChild(main);
      chip.appendChild(remove);
      return chip;
    }

    function syncRailState() {
      const rail = document.querySelector(RAIL_SELECTOR);
      if (!rail) return;
      const open = state.preview && !state.picking ? state.preview.pickId : null;
      for (const chip of Array.from(rail.querySelectorAll(`.${PREFIX}-chip`))) {
        const isOpen = chip.dataset.pickId === open;
        chip.setAttribute('data-open', isOpen ? 'true' : 'false');
        const main = chip.querySelector(`.${PREFIX}-chip__main`);
        if (main) main.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      }
    }

    /** Reconcile the rail with the store; cheap when nothing changed. */
    function renderRail() {
      if (typeof document === 'undefined' || !document.body) return;
      const entry = activeBinding();
      const sessionId = entry ? entry[0] : null;
      const list = sessionId ? picksOf(sessionId) : [];
      const rail = ensureRail(true);
      if (!rail) return;
      const signature = list.map((pick) => pick.id).join('|');
      if (signature !== railSignature) {
        railSignature = signature;
        rail.textContent = '';
        for (const pick of list) rail.appendChild(createPill(pick));
      }
      rail.hidden = list.length === 0;
      syncRailState();
    }

    /** Invisible seat that publishes the composer binding for the module. */
    function PickerBridge(props) {
      const sessionId = props.sessionId;
      const actions = props.inputActions;
      const useInput = typeof props.useInput === 'function' ? props.useInput : null;
      const draft = useInput ? useInput((snapshot) => snapshot.draft) : '';
      const phase = useInput ? useInput((snapshot) => snapshot.phase) : 'plain';
      const draftRef = React.useRef('');
      const phaseRef = React.useRef('plain');
      draftRef.current = typeof draft === 'string' ? draft : '';
      phaseRef.current = typeof phase === 'string' ? phase : 'plain';

      React.useEffect(() => {
        if (!actions || !sessionId) return undefined;
        const binding = {
          actions,
          getDraft: () => draftRef.current,
          getPhase: () => phaseRef.current,
        };
        state.bindings.set(sessionId, binding);
        try {
          renderRail();
        } catch (error) {
          warn(error);
        }
        return () => {
          if (state.bindings.get(sessionId) === binding) state.bindings.delete(sessionId);
        };
      }, [sessionId, actions]);

      return null;
    }

    function PreviewLayer(props) {
      const store = useStore();
      const preview = store.preview;
      const [viewport, setViewport] = React.useState(() => ({ width: 0, height: 0 }));

      React.useEffect(() => {
        const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
      }, []);

      React.useEffect(() => {
        if (!preview) return undefined;
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closePreviewNow();
          }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
      }, [preview]);

      const children = [];
      if (preview) {
        const pick = picksOf(preview.sessionId).find((entry) => entry.id === preview.pickId);
        if (pick) {
          children.push(h(PreviewCard, { key: 'card', pick, anchor: preview.anchor, pinned: preview.pinned, t: props.t, viewport }));
        }
      }
      if (store.notice) {
        children.push(h('div', { key: 'notice', className: `${PREFIX}-toast`, role: 'alert' }, store.notice));
      }
      return h('div', { className: `${PREFIX}-layer`, [HOST_ATTRIBUTE]: '' }, children);
    }

    /* ------------------------------------------------------------------ *
     * Chat context row — owns the 'context' node kind
     * ------------------------------------------------------------------ */

    function contextText(node) {
      const data = node && node.data && Array.isArray(node.data.content) ? node.data : node;
      const blocks = data && Array.isArray(data.content) ? data.content : [];
      return blocks
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
    }

    /** Read the one-line payload back into fields for the row. */
    function parsePayload(text) {
      const attrs = {};
      if (typeof text !== 'string') return attrs;
      const pattern = /([A-Za-z][\w-]*)=("([^"]*)"|'([^']*)'|([^\s/>]+))/g;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        attrs[match[1]] = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5];
      }
      return attrs;
    }

    function payloadTitle(attrs) {
      if (attrs.component) return `<${attrs.component} />`;
      if (attrs.id) return `${attrs.tag || 'element'}#${attrs.id}`;
      const first = String(attrs.class || '').split(/\s+/).filter(Boolean)[0];
      return first ? `${attrs.tag || 'element'}.${first}` : (attrs.tag || 'element');
    }

    /**
     * The transcript pill: the same 40px / 4px-radius / double-hairline shape the
     * composer pill uses, so a picked element reads the same everywhere.
     */
    function ElementContextRow(props) {
      const { text, t } = props;
      const [open, setOpen] = React.useState(false);
      const attrs = parsePayload(text);
      const title = payloadTitle(attrs);
      const snippet = attrs.text || '';
      const propsJson = attrs.props ? attrs.props.replace(/&quot;/g, '"') : '';

      const rows = [];
      rows.push(['label.element', title]);
      if (attrs.component) {
        rows.push([
          'label.component',
          attrs.component + (attrs.owners ? ' ' + t('label.owners', { owners: attrs.owners }) : ''),
        ]);
      }
      if (attrs.source) rows.push(['label.source', attrs.source]);
      if (snippet) rows.push(['label.text', snippet]);
      if (attrs.selector) rows.push(['label.selector', attrs.selector]);

      return h(
        'div',
        { className: `${PREFIX}-chatrow`, [HOST_ATTRIBUTE]: '', 'data-context-source': 'component-picker' },
        h(
          'button',
          {
            type: 'button',
            className: `${PREFIX}-pill`,
            'aria-expanded': open,
            title,
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: `${PREFIX}-pill__glyph` }, h(CursorIcon, { size: 14 })),
          h('span', { className: `${PREFIX}-pill__label` }, title),
          snippet ? h('span', { className: `${PREFIX}-pill__text` }, snippet) : null,
          h('span', { className: `${PREFIX}-pill__chevron`, 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        ),
        open
          ? h(
              'div',
              { className: `${PREFIX}-panel` },
              h(
                'dl',
                { className: `${PREFIX}-dl` },
                rows.map(([key, value]) =>
                  h(React.Fragment, { key },
                    h('dt', null, t(key)),
                    h('dd', null, h('span', { className: `${PREFIX}-mono` }, String(value)))),
                ),
              ),
              propsJson
                ? h(React.Fragment, null,
                    h('div', { className: `${PREFIX}-panel__key` }, t('label.props')),
                    h('pre', { className: `${PREFIX}-panel__code`, dir: 'ltr' }, propsJson))
                : null,
              h('pre', { className: `${PREFIX}-panel__code`, dir: 'ltr' }, text),
            )
          : null,
      );
    }

    /** Chat `context` node. */
    function ChatContextRow(props) {
      const node = props.node || {};
      const source = node.source || {};
      const t = props.t;
      const text = contextText(node);
      if (source.kind === 'component-picker') return h(ElementContextRow, { text, t });
      const producer = node.producer || {};
      const label = producer.label || source.kind || t('row.context');
      return h(GenericContextRow, {
        t,
        label,
        text,
        title: t('row.contextTitle'),
      });
    }

    /** Chat `turn-trigger` node. */
    function ChatTurnTriggerRow(props) {
      const node = props.node || {};
      const data = node.data || {};
      const source = data.source || {};
      const t = props.t;
      const text = contextText(node);
      const time = typeof data.time === 'number' ? new Date(data.time) : null;
      if (source.kind === 'component-picker') return h(ElementContextRow, { text, t });
      return h(GenericContextRow, {
        t,
        label: source.kind || t('row.context'),
        text,
        time,
        title: t('row.contextTitle'),
      });
    }

    /** Plain disclosure for every other producer that hits these two kinds. */
    function GenericContextRow(props) {
      const { t, label, text, time, title } = props;
      const [open, setOpen] = React.useState(false);
      return h(
        'div',
        { className: `${PREFIX}-chatrow`, [HOST_ATTRIBUTE]: '' },
        h(
          'button',
          {
            type: 'button',
            className: `${PREFIX}-row__head`,
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h('span', { className: `${PREFIX}-row__icon` }, h(CodeIcon, null)),
          h('span', { className: `${PREFIX}-row__title` }, title),
          h('span', { className: `${PREFIX}-row__producer` }, label),
          time
            ? h('time', { className: `${PREFIX}-row__time`, dateTime: time.toISOString() },
                time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
            : null,
          h('span', { className: `${PREFIX}-row__chevron`, 'aria-hidden': 'true' }, open ? '▾' : '▸'),
        ),
        open && text ? h('pre', { className: `${PREFIX}-row__body`, dir: 'ltr' }, text) : null,
      );
    }

    /* ------------------------------------------------------------------ *
     * Styles
     * ------------------------------------------------------------------ */

    const CSS = `
.dsh-cp-tool {
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  display: inline-flex; flex: none; align-items: center; justify-content: center;
  background: 0 0; color: var(--dsw-alias-label-secondary); cursor: pointer;
  transition: color .15s ease, background-color .15s ease;
}
.dsh-cp-tool:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
}
.dsh-cp-tool[data-active="true"] {
  color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
}
.dsh-cp-tool:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

/* Pill rail: the composer card's inner top area, above the editor. */
.dsh-cp-rail { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px 8px 4px; }
.dsh-cp-rail[hidden] { display: none; }

/* Element pill — measured spec: 40px tall, 4px radius, double hairline. */
.dsh-cp-chip { position: relative; display: inline-flex; align-items: center; max-width: 100%; }
.dsh-cp-chip:hover, .dsh-cp-chip:focus-within { z-index: 10; }
.dsh-cp-chip__main {
  position: relative; display: inline-flex; align-items: center; gap: 5px; height: 40px; padding: 0 8px;
  border: 0; border-radius: 4px; overflow: hidden;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-family: inherit; font-size: 13px; font-weight: 400; line-height: 1; cursor: pointer;
  box-shadow: 0 0 0 .5px var(--dsw-alias-border-l1);
}
.dsh-cp-chip__main::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none; box-shadow: inset 0 0 0 .5px var(--dsw-alias-border-l1);
}
.dsh-cp-chip__main:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-bg-base), 0 0 0 1px var(--dsw-alias-brand-primary), 0 0 6px 1px var(--dsw-alias-brand-primary);
}
.dsh-cp-chip__glyph { display: inline-flex; color: var(--dsw-alias-label-secondary); }
.dsh-cp-chip__label {
  max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
}
/* Remove control: hidden until the pill is hovered or focused. */
.dsh-cp-chip__remove {
  position: absolute; top: -6px; right: -6px; width: 16px; height: 16px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 0; border-radius: 9999px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  box-shadow: 0 0 0 1px var(--dsw-alias-border-l1);
  font-size: 11px; line-height: 1; cursor: pointer;
  opacity: 0; pointer-events: none;
  transition: opacity .15s cubic-bezier(.4, 0, .2, 1);
}
.dsh-cp-chip:hover .dsh-cp-chip__remove,
.dsh-cp-chip:focus-within .dsh-cp-chip__remove { opacity: 1; pointer-events: auto; }
.dsh-cp-chip__remove:hover { color: var(--dsw-alias-label-primary); }
@media (prefers-reduced-motion: reduce) {
  .dsh-cp-chip__remove { transition: none; }
}

.dsh-cp-chatrow { display: flex; flex-direction: column; gap: 8px; margin: 4px 0; align-items: flex-start; }

/* Transcript pill — same measured spec as the composer pill. */
.dsh-cp-pill {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: min(100%, 640px); padding: 4px 6px; margin-inline-start: -6px;
  border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer; text-align: start;
  transition: background-color .12s ease;
}
.dsh-cp-pill:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-cp-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-cp-pill__glyph { display: inline-flex; flex: none; color: var(--dsw-alias-label-secondary); }
.dsh-cp-pill__label { color: var(--dsw-alias-label-primary); white-space: nowrap; }
.dsh-cp-pill__text {
  color: var(--dsw-alias-label-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-width: 260px;
}
.dsh-cp-pill__time { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-inline-start: 2px; opacity: .8; }
.dsh-cp-pill__chevron { font-size: 9px; opacity: .55; }

.dsh-cp-panel {
  display: flex; flex-direction: column; gap: 8px; width: 320px; max-width: min(100%, 420px);
  padding: 8px; border-radius: 10px;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .12), 0 2px 6px rgba(0, 0, 0, .08);
}
.dsh-cp-panel__key { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-cp-panel__code {
  margin: 0; padding: 6px 8px; border-radius: 6px; max-height: 240px; overflow: auto;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary);
}

.dsh-cp-row { display: flex; flex-direction: column; gap: 6px; margin: 2px 0; }
.dsh-cp-row__head {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 2px 6px; border: 0; border-radius: 6px; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px;
  cursor: pointer; text-align: start;
}
.dsh-cp-row__head:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-cp-row__icon { display: inline-flex; flex: none; }
.dsh-cp-row__title { color: var(--dsw-alias-label-primary); }
.dsh-cp-row__producer {
  color: var(--dsw-alias-label-secondary); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; max-width: 320px;
}
.dsh-cp-row__chevron { font-size: 10px; opacity: .7; }
.dsh-cp-row__time { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-inline-start: auto; }
.dsh-cp-row__body {
  margin: 0; padding: 8px 10px; border-radius: 8px; max-height: 320px; overflow: auto;
  background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary);
}
.dsh-cp-row--ours .dsh-cp-row__title { color: var(--dsw-alias-label-primary); }

.dsh-cp-layer { position: fixed; inset: 0; z-index: 2147482000; pointer-events: none; }

.dsh-cp-card {
  position: fixed; z-index: 2147482001; pointer-events: auto;
  display: flex; flex-direction: column; gap: 8px;
  width: 320px; max-height: 360px; overflow-y: auto; padding: 8px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
  box-shadow:
    0 0 0 1px var(--dsw-alias-border-l2),
    0 8px 24px rgba(0, 0, 0, .18),
    0 2px 6px rgba(0, 0, 0, .1);
  color: var(--dsw-alias-label-primary);
  font-size: 13px; font-weight: 400; text-align: start;
  user-select: text;
}
.dsh-cp-card__foot {
  color: var(--dsw-alias-label-secondary); font-size: 11px;
  border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 6px;
}
.dsh-cp-card__head {
  display: flex; align-items: center; gap: 4px;
  color: var(--dsw-alias-label-secondary); font-size: 13px;
}
.dsh-cp-shot {
  display: block; max-height: 120px; max-width: 100%; align-self: flex-start;
  border-radius: 4px; box-shadow: 0 0 0 1px var(--dsw-alias-border-l1);
  object-fit: contain;
}
.dsh-cp-dl { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 12px; row-gap: 4px; margin: 0; }
.dsh-cp-dl dt { color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.dsh-cp-dl dd { margin: 0; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.dsh-cp-dl--nested {
  column-gap: 8px; row-gap: 2px; font-size: 12px;
  font-family: anthropic-mono, ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
}
.dsh-cp-mono { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dsh-cp-muted { color: var(--dsw-alias-label-secondary); }
.dsh-cp-code {
  margin: 0; font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere;
}
.dsh-cp-link {
  align-self: flex-start; padding: 0; border: 0; background: transparent;
  color: var(--dsw-alias-brand-primary); font: inherit; cursor: pointer;
}
.dsh-cp-toast {
  position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
  padding: 6px 12px; border-radius: 8px; font-size: 12px;
  background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-label-primary); box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
}
`;

    /* ------------------------------------------------------------------ *
     * Plugin
     * ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
        const t = makeTranslator(ctx);
        translate = (key, params) => t(key, params);

        ctx.effect(() => {
          if (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function') {
            return styles.insert(CSS);
          }
          const element = document.createElement('style');
          element.setAttribute('data-dsh-cp', '');
          element.textContent = CSS;
          document.head.appendChild(element);
          return () => element.remove();
        });

        /* Keep one picker tool inside every live Browser toolbar. */
        ctx.effect(() => {
          let scheduled = 0;
          const run = () => {
            if (scheduled) {
              window.clearTimeout(scheduled);
              scheduled = 0;
            }
            try {
              ensureToolButtons();
              renderRail();
            } catch (error) {
              warn(error);
            }
          };
          const schedule = () => {
            if (scheduled) return;
            scheduled = window.setTimeout(run, 300);
          };
          run();
          const timer = window.setInterval(run, 1000);
          let observer = null;
          try {
            observer = new MutationObserver(schedule);
            observer.observe(document.body, { childList: true, subtree: true });
          } catch (error) {
            observer = null;
          }
          return () => {
            window.clearInterval(timer);
            if (scheduled) window.clearTimeout(scheduled);
            if (observer) observer.disconnect();
            for (const button of Array.from(document.querySelectorAll(`button.${PREFIX}-tool`))) button.remove();
            stopPicking();
          };
        });

        /* L3: serialize pending contexts into the outgoing prompt at submit. */
        ctx.effect(() => installSubmitHook(ctx));
        ctx.effect(() => {
          void resolveHostMode();
          return () => {};
        });

        const withTranslation = (Component) => (props) => h(Component, { ...props, t });

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'component-picker.binding', order: 15 },
            withTranslation(PickerBridge),
          ),
        );

        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register(
            { name: 'conversation.chat.node', key: 'context' },
            withTranslation(ChatContextRow),
          ),
        );

        ctx.slots.inject('conversation.chat.node', () =>
          ctx.slots.register(
            { name: 'conversation.chat.node', key: 'turn-trigger' },
            withTranslation(ChatTurnTriggerRow),
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'component-picker.preview', order: 60 },
            withTranslation(PreviewLayer),
          ),
        );

        } catch (error) {
          reportBoot({ error: String((error && error.stack) || error) });
          throw error;
        }
      },
    };
  },
});
