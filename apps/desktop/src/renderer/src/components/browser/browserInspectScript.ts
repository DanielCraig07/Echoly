/**
 * 内置浏览器 DOM 元素检查与拾取注入脚本
 *
 * 激活后在页面悬停显示半透明蓝色选框与尺寸标签，点击拦截事件并回传元素结构。
 *
 * 回传通道说明：早期实现走 console.log 哨兵字符串，页面自身包装过 console.log 时
 * （大量前端框架与日志库都会）拾取会静默失效，且哨兵串会污染用户控制台。
 * 现在改为返回一个 Promise，由渲染层 `await webview.executeJavaScript(...)` 直接取结果。
 */

/**
 * 计算元素的关键计算样式摘要。
 * 只取与「让 AI 判断布局 / 排查样式问题」最相关的一批属性，避免 payload 膨胀。
 */
const STYLE_PROBE_KEYS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'line-height',
  'border',
  'border-radius',
  'flex-direction',
  'justify-content',
  'align-items',
  'gap',
  'z-index',
];

export const INJECTED_INSPECT_SCRIPT = `
(async function() {
  // 若已有一次拾取会话在等待，先结束它（上一个 await 会收到 null）
  var stale = window.__echoly_cleanup_inspect;
  if (typeof stale === 'function') {
    try { stale(null); } catch (e) { /* ignore */ }
  }

  return await new Promise(function(resolve) {
    var OVERLAY_ID = '__echoly_inspector_overlay';
    var LABEL_ID = '__echoly_inspector_label';
    var HINT_ID = '__echoly_inspector_hint';
    var STYLE_KEYS = ${JSON.stringify(STYLE_PROBE_KEYS)};

    var done = false;
    var currentTarget = null;
    // 方向键向下「回到子元素」时使用的下钻栈：栈顶是当前选中元素的下一个子级
    var drillStack = [];

    window.__echoly_inspect_active = true;

    function escapeIdent(value) {
      try {
        return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
      } catch (e) {
        return String(value);
      }
    }

    function classSnippet(el, limit) {
      if (!el || typeof el.className !== 'string') return '';
      var cls = el.className.trim().split(/\\s+/).filter(Boolean).slice(0, limit);
      if (!cls.length) return '';
      return cls.map(function(c) { return '.' + escapeIdent(c); }).join('');
    }

    /**
     * 生成尽量唯一的选择器。
     * 早期实现只拼 tag + 前两个类名，同级同类元素（如列表项）与重复类名会指向多个元素，
     * 这里在有歧义时补 :nth-of-type(n) 消歧，并对 id 做唯一性校验后再使用。
     */
    function getSelectorPath(el, maxDepth) {
      if (!el || el.nodeType !== 1) return '';
      var depth = maxDepth || 6;
      var parts = [];
      var cur = el;
      var levels = 0;

      while (cur && cur.nodeType === 1 && cur !== document.documentElement && levels < depth) {
        // id 只在页面内确实唯一时才作为锚点，否则会指向错误元素
        if (cur.id) {
          var idSel = '#' + escapeIdent(cur.id);
          try {
            if (document.querySelectorAll(idSel).length === 1) {
              parts.unshift(idSel);
              return parts.join(' > ');
            }
          } catch (e) { /* ignore */ }
        }

        var part = cur.tagName.toLowerCase() + classSnippet(cur, 2);
        var parent = cur.parentElement;
        if (parent) {
          var sameTag = Array.prototype.filter.call(parent.children, function(c) {
            return c.tagName === cur.tagName;
          });
          if (sameTag.length > 1) {
            part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
          }
        }
        parts.unshift(part);
        cur = parent;
        levels++;
      }

      return parts.join(' > ');
    }

    function countSelectorMatch(selector) {
      if (!selector) return 0;
      try {
        return document.querySelectorAll(selector).length;
      } catch (e) {
        return 0;
      }
    }

    function collectComputedStyles(el) {
      var out = {};
      try {
        var cs = window.getComputedStyle(el);
        for (var i = 0; i < STYLE_KEYS.length; i++) {
          var key = STYLE_KEYS[i];
          var value = cs.getPropertyValue(key);
          if (value) out[key] = value;
        }
      } catch (e) { /* ignore */ }
      return out;
    }

    /** 祖先链摘要：让 AI 知道该元素处在什么容器结构里 */
    function collectAncestors(el, limit) {
      var out = [];
      var cur = el ? el.parentElement : null;
      var max = limit || 6;
      while (cur && cur.nodeType === 1 && cur !== document.documentElement && out.length < max) {
        out.push({
          tagName: cur.tagName.toLowerCase(),
          id: cur.id || '',
          className: typeof cur.className === 'string' ? cur.className.trim().slice(0, 120) : '',
        });
        cur = cur.parentElement;
      }
      return out.reverse();
    }

    /** 同级兄弟摘要：区分「列表里的第几个」这类信息 */
    function collectSiblings(el) {
      try {
        var parent = el.parentElement;
        if (!parent) return null;
        var children = Array.prototype.slice.call(parent.children);
        return {
          total: children.length,
          index: children.indexOf(el),
          tags: children.slice(0, 12).map(function(c) { return c.tagName.toLowerCase(); }),
        };
      } catch (e) {
        return null;
      }
    }

    function getCleanOuterHtml(el) {
      if (!el) return '';
      try {
        var clone = el.cloneNode(true);
        // 移除多余的巨大 base64 图片与脚本，避免传输溢出
        var imgs = clone.querySelectorAll('img');
        Array.prototype.forEach.call(imgs, function(img) {
          if (img.src && img.src.indexOf('data:') === 0 && img.src.length > 200) {
            img.src = 'data:image/...[truncated]';
          }
        });
        var html = clone.outerHTML || '';
        if (html.length > 3000) {
          html = html.slice(0, 3000) + '... <!-- [truncated] -->';
        }
        return html;
      } catch (e) {
        return el.outerHTML ? el.outerHTML.slice(0, 3000) : '';
      }
    }

    function describe(el) {
      var tag = el.tagName.toLowerCase();
      var id = el.id ? '#' + el.id : '';
      return tag + id + classSnippet(el, 2);
    }

    // ── 悬浮高亮选框与尺寸标签 ──────────────────────────────────────────────
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = [
      'position: fixed',
      'pointer-events: none',
      'z-index: 2147483647',
      'border: 2px dashed #3b82f6',
      'background: rgba(59, 130, 246, 0.18)',
      'box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4), inset 0 0 0 1px rgba(59, 130, 246, 0.3)',
      'border-radius: 4px',
      'transition: all 0.06s ease-out',
      'display: none',
      'box-sizing: border-box',
    ].join(';') + ';';

    var labelEl = document.createElement('div');
    labelEl.id = LABEL_ID;
    labelEl.style.cssText = [
      'position: absolute',
      'top: -24px',
      'left: 0',
      'background: #1e293b',
      'color: #f8fafc',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace',
      'font-size: 11px',
      'font-weight: 600',
      'padding: 2px 6px',
      'border-radius: 4px',
      'border: 1px solid #3b82f6',
      'white-space: nowrap',
      'pointer-events: none',
      'box-shadow: 0 2px 6px rgba(0,0,0,0.3)',
    ].join(';') + ';';

    overlay.appendChild(labelEl);
    document.documentElement.appendChild(overlay);

    // ── 顶部操作提示条 ──────────────────────────────────────────────────────
    var hintEl = document.getElementById(HINT_ID);
    if (hintEl) hintEl.remove();

    hintEl = document.createElement('div');
    hintEl.id = HINT_ID;
    hintEl.textContent = '元素选取中：点击引用 · ↑ 选父级 · ↓ 选子级 · Esc 取消';
    hintEl.style.cssText = [
      'position: fixed',
      'top: 0',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'pointer-events: none',
      'background: linear-gradient(90deg, #1d4ed8, #2563eb)',
      'color: #ffffff',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'font-size: 12px',
      'font-weight: 600',
      'padding: 5px 14px',
      'border-radius: 0 0 6px 6px',
      'box-shadow: 0 2px 10px rgba(0,0,0,0.35)',
      'box-sizing: border-box',
    ].join(';') + ';';
    document.documentElement.appendChild(hintEl);

    function updateOverlay() {
      var el = currentTarget;
      if (!el || el === overlay || el === labelEl || el === document.documentElement || el === document.body) {
        overlay.style.display = 'none';
        return;
      }
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        overlay.style.display = 'none';
        return;
      }

      overlay.style.display = 'block';
      overlay.style.top = rect.top + 'px';
      overlay.style.left = rect.left + 'px';
      overlay.style.width = rect.width + 'px';
      overlay.style.height = rect.height + 'px';

      var selector = getSelectorPath(el, 6);
      var matches = countSelectorMatch(selector);
      var suffix = matches > 1 ? ' · 匹配 ' + matches + ' 个' : '';
      labelEl.textContent =
        describe(el) + ' (' + Math.round(rect.width) + '×' + Math.round(rect.height) + ')' + suffix;

      // 顶部空间不足时把标签挪到选框下方，避免被视口裁掉
      labelEl.style.top = rect.top < 26 ? (rect.height + 4) + 'px' : '-24px';
    }

    function onPointerMove(e) {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el !== overlay && el !== labelEl && el !== hintEl) {
        if (el !== currentTarget) {
          currentTarget = el;
          drillStack = [];
          updateOverlay();
        }
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup(null);
        return;
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'ArrowUp') {
        var parent = currentTarget ? currentTarget.parentElement : null;
        if (parent && parent !== document.documentElement && parent !== document.body) {
          drillStack.unshift(currentTarget);
          currentTarget = parent;
          updateOverlay();
        }
        return;
      }

      if (drillStack.length) {
        currentTarget = drillStack.shift();
        updateOverlay();
      }
    }

    function onClick(e) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      var target = currentTarget || document.elementFromPoint(e.clientX, e.clientY);
      if (!target) {
        cleanup(null);
        return;
      }
      cleanup(buildPayload(target));
    }

    function buildPayload(target) {
      var rect = target.getBoundingClientRect();
      var selectorPath = getSelectorPath(target, 8);
      return {
        url: window.location.href,
        pageTitle: document.title || 'Untitled Page',
        tagName: target.tagName.toLowerCase(),
        id: target.id || '',
        className: typeof target.className === 'string' ? target.className.trim() : '',
        selectorPath: selectorPath,
        selectorMatchCount: countSelectorMatch(selectorPath),
        outerHtml: getCleanOuterHtml(target),
        textContent: (target.innerText || target.textContent || '').trim().slice(0, 500),
        // 视口坐标（CSS 像素）：渲染层据此到主进程裁剪该元素的渲染截图
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        computedStyles: collectComputedStyles(target),
        ancestors: collectAncestors(target, 6),
        siblings: collectSiblings(target),
        timestamp: Date.now(),
      };
    }

    /**
     * 结束本次拾取。
     * payload 为对象时回传该结果，为 null 表示用户取消 —— 两者都通过 resolve 交给渲染层，
     * 不再依赖 console 哨兵串，页面包装 console.log 也不会影响拾取。
     */
    function cleanup(payload) {
      if (done) return;
      done = true;
      window.__echoly_inspect_active = false;
      window.__echoly_cleanup_inspect = null;
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      try { overlay.remove(); } catch (e) { /* ignore */ }
      try { hintEl.remove(); } catch (e) { /* ignore */ }
      // executeJavaScript 只对可序列化的返回值负责，统一以 JSON 字符串回传更稳
      try {
        resolve(payload ? JSON.stringify(payload) : null);
      } catch (e) {
        resolve(null);
      }
    }

    window.__echoly_cleanup_inspect = cleanup;

    document.addEventListener('pointermove', onPointerMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
  });
})();
`;

/**
 * 取消元素拾取。
 * 主动让注入脚本 resolve(null)，使渲染层那次 await 立即收尾，不留下悬挂的 Promise。
 */
export const CANCEL_INSPECT_SCRIPT = `
(function() {
  if (typeof window.__echoly_cleanup_inspect === 'function') {
    try { window.__echoly_cleanup_inspect(null); } catch (e) { /* ignore */ }
  }
  window.__echoly_cleanup_inspect = null;
  window.__echoly_inspect_active = false;
})();
`;

/**
 * SPA 路由变化监听。
 *
 * 首次注入时给 history.pushState / replaceState 打补丁，并挂一个 hook；
 * 之后每次调用返回一个 Promise，在「下一次路由变化」时 resolve 出当前 href。
 * 渲染层拿到结果后再注入一次即完成重新武装，属于一次性订阅 + 续订的模式。
 *
 * 与元素拾取同理，回传不再走 console.log 哨兵串：页面一旦包装 console.log，
 * 哨兵就会丢，且会污染用户自己的控制台。
 */
export const ROUTE_SYNC_SCRIPT = `
(function() {
  if (!window.__echoly_route_hook_installed__) {
    window.__echoly_route_hook_installed__ = true;
    window.__echoly_route_hook = null;

    var fire = function() {
      var hook = window.__echoly_route_hook;
      if (typeof hook === 'function') {
        window.__echoly_route_hook = null;
        try { hook(); } catch (e) { /* ignore */ }
      }
    };

    try {
      var origPush = history.pushState;
      history.pushState = function() {
        var res = origPush.apply(this, arguments);
        fire();
        return res;
      };
      var origReplace = history.replaceState;
      history.replaceState = function() {
        var res = origReplace.apply(this, arguments);
        fire();
        return res;
      };
    } catch (e) { /* ignore */ }

    window.addEventListener('popstate', fire);
    window.addEventListener('hashchange', fire);
  }

  return new Promise(function(resolve) {
    var settled = false;
    window.__echoly_route_hook = function() {
      if (settled) return;
      settled = true;
      resolve(window.location.href);
    };
  });
})();
`;
