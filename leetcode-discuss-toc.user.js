// ==UserScript==
// @name         力扣讨论 · 文章目录
// @namespace    local.leetcode-discuss-toc
// @version      1.0.12
// @description  为力扣讨论文章生成悬停展开、可搜索、可折叠、自动高亮的多级目录，点击即可跳转。
// @source       https://github.com/Nico-human/leetcode-discuss-toc
// @supportURL   https://greasyfork.org/zh-CN/scripts/601597-%E5%8A%9B%E6%89%A3%E8%AE%A8%E8%AE%BA-%E6%96%87%E7%AB%A0%E7%9B%AE%E5%BD%95/feedback
// @supportURL   https://github.com/Nico-human/leetcode-discuss-toc/issues
// @match        https://leetcode.cn/discuss/post/*
// @match        https://leetcode.com/discuss/post/*
// @run-at       document-idle
// @grant        window.onurlchange
// @noframes
// @author       Nico-human
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const INSTANCE_KEY = '__leetcodeDiscussToc__';
  const HOST_ID = 'lc-discuss-toc';
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,h6';
  const ARTICLE_SELECTORS = [
    '#main-content [class*="Body_markdown__"]',
    'main article [class*="markdown-content_markdown"]',
    'main [class*="markdown-content_markdown"]',
    'article .markdown-body',
    'main .markdown-body',
  ];
  const DEBOUNCE_MS = 120;

  window[INSTANCE_KEY]?.destroy();

  let article = null;
  let entries = [];
  let activeEntry = null;
  let visibleActiveEntry = null;
  let previewActiveEntry = null;
  let host = null;
  let ui = null;
  let path = location.pathname;
  let debounceTimer = 0;
  let frame = 0;
  let followFrame = 0;
  let followTarget = null;
  let followLastTime = 0;
  let followExpectedTop = null;
  let followPaused = false;
  let routeTimer = 0;
  let destroyed = false;
  let topInset = 66;
  let panelOpen = false;
  let closeTimer = 0;
  let pointerInside = false;
  let keyboardFocus = false;
  let movingFocus = false;
  let collapsed = new Set();
  const savedMargins = new Map();
  const cleanups = [];
  const systemTheme = window.matchMedia?.('(prefers-color-scheme: dark)');
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  function listen(target, name, callback, options) {
    target.addEventListener(name, callback, options);
    cleanups.push(() => target.removeEventListener(name, callback, options));
  }

  function element(tag, attributes = {}, text = '') {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      node.setAttribute(key, value);
    }
    if (text) node.textContent = text;
    return node;
  }

  function button(label, className, text = '') {
    return element('button', {
      type: 'button', class: className, title: label, 'aria-label': label,
    }, text);
  }

  function icon(name) {
    const paths = {
      list: 'M4 5h16M4 12h16M4 19h10',
      search: 'm20 20-4.5-4.5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
      chevron: 'm9 5 7 7-7 7',
      expand: 'm8 9 4-4 4 4M8 15l4 4 4-4',
      collapse: 'm8 5 4 4 4-4M8 19l4-4 4 4',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('data-icon', name);
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    })) svg.setAttribute(key, value);
    const drawing = document.createElementNS(svg.namespaceURI, 'path');
    drawing.setAttribute('d', paths[name]);
    svg.append(drawing);
    return svg;
  }

  function setPanelOpen(open, focus = false) {
    clearTimeout(closeTimer);
    closeTimer = 0;
    const changed = panelOpen !== open;
    if (ui && open && changed) {
      // Finish pending article measurements while the panel is still offscreen.
      // Opening then only animates its horizontal position, never a catch-up scroll.
      followPaused = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      updateActiveEntry();
    }
    panelOpen = open;
    if (!ui) return;
    host.dataset.open = String(open);
    // Keep both surfaces laid out so CSS can interpolate in either direction.
    // Inert makes the inactive surface immediately unavailable to input/focus.
    ui.panel.inert = !open;
    ui.launcher.inert = open;
    ui.launcher.setAttribute('aria-expanded', String(open));
    if (!open) {
      keyboardFocus = false;
      syncCurrentEntry();
    }
    if (focus && open) {
      // Programmatic focus transfer should not trigger a second open request.
      movingFocus = true;
      ui.search.focus({ preventScroll: true });
      movingFocus = false;
    } else if (!open && ui.panel.contains(ui.shadow.activeElement)) {
      ui.shadow.activeElement.blur();
    }
    ui.panel.setAttribute('aria-hidden', String(!open));
    ui.launcher.setAttribute('aria-hidden', String(open));
  }

  function schedulePanelClose() {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = 0;
      if (!pointerInside && !keyboardFocus) setPanelOpen(false);
    }, 140);
  }

  function syncPreviewPosition() {
    if (!ui || panelOpen || !previewActiveEntry?.marker) return;
    const rail = ui.launcher;
    if (!rail.clientHeight) return;
    const marker = previewActiveEntry.marker.getBoundingClientRect();
    const viewport = rail.getBoundingClientRect();
    if (marker.top < viewport.top || marker.bottom > viewport.bottom) {
      rail.scrollTop += marker.top - viewport.top + marker.height / 2 - rail.clientHeight / 2;
    }
  }

  function syncTheme() {
    if (!host) return;
    const root = document.documentElement;
    const explicit = root.getAttribute('data-theme');
    const dark = root.classList.contains('dark') || explicit === 'dark'
      || (!root.classList.contains('light') && explicit !== 'light' && systemTheme?.matches);
    host.dataset.theme = dark ? 'dark' : 'light';
  }

  function mount() {
    host = element('div', { id: HOST_ID });
    // Inline !important protects the fixed host from website-wide div styles.
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('top', '80px', 'important');
    host.style.setProperty('right', '16px', 'important');
    host.style.setProperty('z-index', '2147483000', 'important');
    host.style.setProperty('color-scheme', 'light dark');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = element('style');
    style.textContent = STYLES;

    const panel = element('aside', { class: 'panel', id: 'lc-toc-panel', 'aria-label': '文章目录' });
    const header = element('div', { class: 'header' });
    const brand = element('div', { class: 'brand' });
    const mark = element('span', { class: 'mark' });
    mark.append(icon('list'));
    const heading = element('strong', {}, '文章目录');
    brand.append(mark, heading);
    header.append(brand);

    const articleTitle = element('div', { class: 'article-title' });
    const searchBox = element('div', { class: 'search-box' });
    const search = element('input', {
      type: 'search', placeholder: '搜索章节…', 'aria-label': '搜索章节',
      autocomplete: 'off', spellcheck: 'false',
    });
    searchBox.append(icon('search'), search);
    const tools = element('div', { class: 'tools' });
    const foldAll = button('全部收起', 'icon-button small fold-all');
    foldAll.setAttribute('aria-controls', 'lc-toc-outline');
    tools.append(searchBox, foldAll);
    const navigation = element('nav', { class: 'navigation', 'aria-label': '文章章节' });
    const list = element('ol', { class: 'outline', id: 'lc-toc-outline' });
    const empty = element('p', { class: 'empty', role: 'status' }, '没有匹配的章节');
    empty.hidden = true;
    navigation.append(list, empty);
    const footer = element('div', { class: 'footer' });
    footer.append(element('span', { class: 'footer-dot' }),
      element('span', {}, '点击章节跳转'));
    panel.append(header, articleTitle, tools, navigation, footer);
    const launcher = button('展开文章目录', 'launcher', '');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-controls', 'lc-toc-panel');
    launcher.title = '悬停展开文章目录';
    const panelViewport = element('div', { class: 'panel-viewport' });
    panelViewport.append(panel);
    shadow.append(style, panelViewport, launcher);
    document.body.append(host);
    ui = { shadow, panel, launcher, articleTitle, search, foldAll, list, empty, navigation };

    // These listeners are owned by the shadow tree, and disappear with the host.
    launcher.addEventListener('click', () => {
      keyboardFocus = !pointerInside;
      setPanelOpen(true, true);
    });
    host.addEventListener('mouseenter', () => {
      pointerInside = true;
      keyboardFocus = false;
      setPanelOpen(true);
    });
    host.addEventListener('mouseleave', () => {
      pointerInside = false;
      schedulePanelClose();
    });
    host.addEventListener('focusin', event => {
      if (movingFocus) return;
      keyboardFocus = !pointerInside;
      setPanelOpen(true, event.composedPath()[0] === launcher);
    });
    host.addEventListener('focusout', () => {
      // Focus may move between controls in the shadow tree. Check after the
      // browser has updated activeElement before treating it as an exit.
      const current = ui;
      queueMicrotask(() => {
        if (!current || ui !== current || current.shadow.activeElement) return;
        keyboardFocus = false;
        if (!pointerInside) schedulePanelClose();
      });
    });
    search.addEventListener('input', () => {
      if (!search.value.trim()) followPaused = false;
      filterEntries();
    });
    foldAll.addEventListener('click', () => {
      pauseFollowing();
      const branches = entries.filter(item => item.children.length);
      if (branches.some(item => collapsed.has(item.element))) collapsed.clear();
      else collapsed = new Set(branches.map(item => item.element));
      filterEntries();
    });
    navigation.addEventListener('wheel', pauseFollowing, { passive: true });
    navigation.addEventListener('pointerdown', pauseFollowing, { passive: true });
    navigation.addEventListener('touchstart', pauseFollowing, { passive: true });
    navigation.addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseFollowing();
    });
    navigation.addEventListener('scroll', () => {
      if (followFrame && followExpectedTop !== null
        && Math.abs(navigation.scrollTop - followExpectedTop) > 1) pauseFollowing();
    }, { passive: true });
    setPanelOpen(panelOpen);
    syncTheme();
  }

  function findArticle() {
    for (const selector of ARTICLE_SELECTORS) {
      const candidate = document.querySelector(selector);
      if (candidate && !candidate.closest('[hidden], [aria-hidden="true"]')) return candidate;
    }
    return null;
  }

  function collectHeadings(root) {
    if (!root) return [];
    return [...root.querySelectorAll(HEADING_SELECTOR)]
      .filter(node => !node.closest('[hidden], [aria-hidden="true"]')
        && getComputedStyle(node).display !== 'none')
      .map(node => ({
        element: node,
        text: (node.innerText || node.textContent).replace(/\s+/g, ' ').trim(),
        level: Number(node.tagName[1]),
      }))
      .filter(item => item.text);
  }

  function restoreMargins() {
    for (const [node, { value, priority }] of savedMargins) {
      if (value) node.style.setProperty('scroll-margin-top', value, priority);
      else node.style.removeProperty('scroll-margin-top');
    }
    savedMargins.clear();
  }

  function updateInsets() {
    let visibleBottom = 0;
    let fixedBottom = 0;
    const topRegion = Math.max(80, window.innerHeight / 3);
    const measured = new Set();
    for (const candidate of document.querySelectorAll('#leetcode-navbar,#navbar-container,header,nav,[role="banner"]')) {
      // Article navigation and comment pagination are not the site's top bar.
      if (candidate.closest('main,article') || article?.contains(candidate)) continue;
      for (let node = candidate, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
        if (measured.has(node)) continue;
        measured.add(node);
        const style = getComputedStyle(node);
        const fixed = style.position === 'fixed' || style.position === 'sticky';
        if (node !== candidate && !fixed) continue;
        const rect = node.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0'
          || rect.height <= 0 || rect.height > topRegion || rect.top >= topRegion
          || rect.bottom <= 0 || rect.width <= window.innerWidth / 3) continue;
        visibleBottom = Math.max(visibleBottom, rect.bottom);
        // In-flow bars need panel clearance only: they scroll away when jumping
        // to a heading, unlike fixed or sticky bars that obscure article content.
        if (fixed) fixedBottom = Math.max(fixedBottom, rect.bottom);
      }
    }
    topInset = Math.ceil(fixedBottom) + 16;
    const panelTop = `${Math.max(24, Math.ceil(visibleBottom) + 30)}px`;
    if (host) {
      if (host.style.top !== panelTop) host.style.setProperty('top', panelTop, 'important');
      if (host.style.getPropertyValue('--panel-top') !== panelTop) host.style.setProperty('--panel-top', panelTop);
    }
    for (const { element: node } of entries) {
      if (!savedMargins.has(node)) savedMargins.set(node, {
        value: node.style.getPropertyValue('scroll-margin-top'),
        priority: node.style.getPropertyPriority('scroll-margin-top'),
      });
      if (node.style.scrollMarginTop !== `${topInset}px`) {
        node.style.setProperty('scroll-margin-top', `${topInset}px`);
      }
    }
  }

  function render(headings) {
    stopFollowing();
    restoreMargins();
    const previous = collapsed;
    collapsed = new Set(headings.map(item => item.element).filter(node => previous.has(node)));
    const stack = [];
    entries = headings.map((item, index) => {
      while (stack.length && stack.at(-1).level >= item.level) stack.pop();
      const entry = { ...item, index, parent: stack.at(-1) || null, depth: stack.length, children: [] };
      entry.chapter = entry.parent?.chapter || entry;
      entry.parent?.children.push(entry);
      stack.push(entry);
      return entry;
    });
    activeEntry = null;
    visibleActiveEntry = null;
    previewActiveEntry = null;
    if (!ui) mount();
    const title = document.querySelector('#main-content h1, main h1')?.textContent.trim()
      || document.title.replace(/ - 讨论.*$/, '');
    ui.articleTitle.textContent = title;
    ui.articleTitle.title = title;
    ui.list.replaceChildren();
    ui.launcher.replaceChildren();
    const fragment = document.createDocumentFragment();
    const markers = document.createDocumentFragment();
    for (const entry of entries) {
      if (!entry.parent) {
        entry.marker = element('span', { class: 'preview-marker', 'aria-hidden': 'true' });
        markers.append(entry.marker);
      }
      const row = element('li', { class: `row${entry.depth === 0 ? ' chapter' : ''}` });
      row.style.setProperty('--depth', String(entry.depth));
      if (entry.children.length) {
        const toggle = button(`折叠 ${entry.text}`, 'branch', '');
        toggle.append(icon('chevron'));
        toggle.addEventListener('click', () => {
          pauseFollowing();
          if (collapsed.has(entry.element)) collapsed.delete(entry.element);
          else collapsed.add(entry.element);
          filterEntries();
        });
        entry.toggle = toggle;
        row.append(toggle);
      } else row.append(element('span', { class: 'branch-spacer', 'aria-hidden': 'true' }));
      const link = button(entry.text, 'heading-link', '');
      link.append(element('span', { class: 'label' }, entry.text));
      link.addEventListener('click', () => jump(entry));
      row.append(link);
      entry.row = row;
      entry.link = link;
      fragment.append(row);
    }
    ui.list.append(fragment);
    ui.launcher.append(markers);
    updateInsets();
    filterEntries();
    requestActiveUpdate();
  }

  function filterEntries() {
    if (!ui) return;
    const query = ui.search.value.trim().toLocaleLowerCase();
    const matched = new Set();
    if (query) {
      for (const entry of entries) {
        if (!entry.text.toLocaleLowerCase().includes(query)) continue;
        for (let node = entry; node; node = node.parent) matched.add(node);
      }
    }
    for (const entry of entries) {
      let hidden = query ? !matched.has(entry) : false;
      if (!query) for (let node = entry.parent; node; node = node.parent) {
        if (collapsed.has(node.element)) { hidden = true; break; }
      }
      entry.row.hidden = hidden;
      if (entry.toggle) {
        const expanded = Boolean(query) || !collapsed.has(entry.element);
        entry.toggle.setAttribute('aria-expanded', String(expanded));
        const label = `${expanded ? '折叠' : '展开'} ${entry.text}`;
        entry.toggle.setAttribute('aria-label', label);
        entry.toggle.title = label;
        // Search reveals ancestor branches; clear it before changing their fold state.
        entry.toggle.disabled = Boolean(query);
      }
    }
    ui.empty.hidden = !query || matched.size > 0;
    const branches = entries.filter(item => item.children.length);
    const expanded = Boolean(query) || branches.every(item => !collapsed.has(item.element));
    ui.foldAll.setAttribute('aria-expanded', String(expanded));
    ui.foldAll.replaceChildren(icon(expanded ? 'expand' : 'collapse'));
    const action = expanded ? '全部收起' : '全部展开';
    ui.foldAll.setAttribute('aria-label', action);
    ui.foldAll.title = `当前已${expanded ? '展开' : '收起'}，点击${action}`;
    ui.foldAll.disabled = Boolean(query) || !branches.length;
    syncCurrentEntry();
  }

  function jump(entry) {
    if (!entry.element.isConnected || !article?.contains(entry.element)) {
      scheduleRefresh();
      return;
    }
    updateInsets();
    followPaused = false;
    entry.element.scrollIntoView({
      behavior: reducedMotion?.matches ? 'instant' : 'smooth',
      block: 'start', inline: 'nearest',
    });
    setActive(entry, true);
  }

  function setActive(entry, reveal = false) {
    activeEntry = entry;
    if (reveal && entry && !ui.search.value.trim()) {
      let changed = false;
      for (let node = entry.parent; node; node = node.parent) {
        if (collapsed.delete(node.element)) changed = true;
      }
      if (changed) { filterEntries(); return; }
    }
    syncCurrentEntry();
  }

  function syncCurrentEntry() {
    if (!ui) return;
    const preview = activeEntry?.chapter || null;
    if (previewActiveEntry !== preview) {
      previewActiveEntry?.marker.removeAttribute('data-current');
      previewActiveEntry = preview;
      preview?.marker.setAttribute('data-current', '');
    }
    syncPreviewPosition();
    // The actual reading position is independent of the user's fold state.
    // A hidden subsection is represented by its nearest visible ancestor.
    const visibleAncestor = entry => {
      while (entry?.row.hidden) entry = entry.parent;
      return entry;
    };
    const visible = visibleAncestor(activeEntry);
    if (visibleActiveEntry !== visible) {
      visibleActiveEntry?.link.removeAttribute('aria-current');
      visibleActiveEntry = visible;
      visible?.link.setAttribute('aria-current', 'location');
    }
    if (followPaused || !visible || ui.search.value.trim()) { stopFollowing(); return; }

    const navigation = ui.navigation;
    const height = navigation.clientHeight;
    if (!height) { stopFollowing(); return; }
    const viewportTop = navigation.getBoundingClientRect().top + navigation.clientTop;
    const row = visible.row.getBoundingClientRect();
    let position = navigation.scrollTop + row.top - viewportTop + row.height / 2;
    const next = entries[activeEntry.index + 1];
    const nextVisible = visibleAncestor(next);
    if (next && nextVisible && nextVisible !== visible) {
      const start = activeEntry.element.getBoundingClientRect().top;
      const end = next.element.getBoundingClientRect().top;
      const progress = end > start ? Math.max(0, Math.min(1, (topInset - start) / (end - start))) : 0;
      const nextRow = nextVisible.row.getBoundingClientRect();
      const endPosition = navigation.scrollTop + nextRow.top - viewportTop + nextRow.height / 2;
      position += (endPosition - position) * progress;
    }
    // Map reading progress to a continuous point in the visible outline. Hidden
    // descendants share their visible ancestor's point without opening branches.
    const target = Math.max(0, Math.min(position - height * 0.45, navigation.scrollHeight - height));
    followTo(target);
  }

  function pauseFollowing() {
    // Keep manual outline browsing separate from reading-position updates.
    // Pending frames and layout changes may update the marker, but cannot scroll.
    followPaused = true;
    stopFollowing();
  }

  function stopFollowing() {
    if (followFrame) cancelAnimationFrame(followFrame);
    followFrame = 0;
    followTarget = null;
    followLastTime = 0;
    followExpectedTop = null;
  }

  function followTo(target) {
    const navigation = ui.navigation;
    // Hidden outlines stay exactly aligned without running an unseen animation.
    // Visible outlines keep the existing smooth reading-progress follow behavior.
    if (!panelOpen || reducedMotion?.matches) {
      stopFollowing();
      navigation.scrollTop = target;
      return;
    }
    followTarget = target;
    followExpectedTop = navigation.scrollTop;
    if (Math.abs(target - navigation.scrollTop) <= 1) {
      stopFollowing();
      return;
    }
    // Retarget an existing animation from its current position. Starting a new
    // native smooth scroll on every outer scroll event would repeatedly restart it.
    if (!followFrame) followFrame = requestAnimationFrame(animateFollowing);
  }

  function animateFollowing(time) {
    followFrame = 0;
    if (destroyed || !ui || followPaused || ui.search.value.trim() || followTarget === null) {
      stopFollowing();
      return;
    }
    const navigation = ui.navigation;
    const target = Math.max(0, Math.min(followTarget, navigation.scrollHeight - navigation.clientHeight));
    const distance = target - navigation.scrollTop;
    if (Math.abs(distance) <= 1) {
      navigation.scrollTop = target;
      stopFollowing();
      return;
    }
    const elapsed = followLastTime ? Math.min(50, Math.max(1, time - followLastTime)) : 1000 / 60;
    followLastTime = time;
    const step = distance * (1 - Math.exp(-elapsed / 80));
    // A minimum one-pixel step also converges in browsers that quantize scrollTop.
    navigation.scrollTop += Math.sign(distance) * Math.min(Math.abs(distance), Math.max(1, Math.abs(step)));
    followExpectedTop = navigation.scrollTop;
    followFrame = requestAnimationFrame(animateFollowing);
  }

  function requestActiveUpdate(event) {
    // Outline scrolling must never trigger a follow operation of its own.
    if (event && (event.target === host || ui?.shadow.contains(event.target))) return;
    // Only article scrolling resumes following after manual outline interaction;
    // resize, images, mutations, and unrelated inner scrollers retain the pause.
    // Do this before coalescing frames so a new scroll can resume a pending update.
    if (event?.type === 'scroll' && (event.target === document
      || event.target instanceof Element && event.target.contains(article))) followPaused = false;
    if (frame || !entries.length || destroyed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateActiveEntry();
    });
  }

  function updateActiveEntry() {
    updateInsets();
    let current = entries[0];
    // Read live positions, so images and math rendering cannot invalidate cached offsets.
    for (const entry of entries) {
      if (entry.element.getBoundingClientRect().top <= topInset + 4) current = entry;
    }
    // Near the end of a short article, the last heading cannot reach the top.
    // Use the actual scroll container, including nested article panes.
    let scroller = article?.parentElement;
    while (scroller) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(scroller).overflowY)
        && scroller.scrollHeight > scroller.clientHeight + 1) break;
      scroller = scroller.parentElement;
    }
    const documentScroller = document.scrollingElement || document.documentElement;
    scroller ||= documentScroller;
    const height = scroller === documentScroller ? window.innerHeight : scroller.clientHeight;
    const viewportBottom = scroller === documentScroller ? height : scroller.getBoundingClientRect().bottom;
    if (scroller.scrollHeight > height + 1 && scroller.scrollTop + height >= scroller.scrollHeight - 2
      && entries.at(-1).element.getBoundingClientRect().bottom <= viewportBottom) current = entries.at(-1);
    setActive(current);
  }

  function unmount() {
    clearTimeout(closeTimer);
    closeTimer = 0;
    pointerInside = false;
    keyboardFocus = false;
    panelOpen = false;
    stopFollowing();
    followPaused = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    restoreMargins();
    host?.remove();
    host = null;
    ui = null;
    entries = [];
    activeEntry = null;
    visibleActiveEntry = null;
    previewActiveEntry = null;
    collapsed.clear();
  }

  function refresh() {
    if (destroyed) return;
    const changedPath = path !== location.pathname;
    path = location.pathname;
    if (changedPath) {
      unmount();
      panelOpen = false;
      article = null;
    }
    if (!/^\/discuss\/post\/\d+(?:\/|$)/.test(path)) {
      if (host) unmount();
      article = null;
      return;
    }
    const nextArticle = findArticle();
    const headings = collectHeadings(nextArticle);
    const changed = nextArticle !== article || headings.length !== entries.length
      || headings.some((item, i) => item.element !== entries[i]?.element
        || item.text !== entries[i]?.text || item.level !== entries[i]?.level);
    article = nextArticle;
    if (!headings.length) {
      if (host) unmount();
      return;
    }
    if (changed || !host?.isConnected) render(headings);
  }

  function scheduleRefresh() {
    if (destroyed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
  }

  const pageObserver = new MutationObserver(records => {
    if (path !== location.pathname || (article && !article.isConnected) || (host && !host.isConnected)) {
      scheduleRefresh();
      return;
    }
    for (const record of records) {
      if (record.target === host) continue;
      if (article && article.contains(record.target)) {
        requestActiveUpdate();
        // Code tabs, formulas, and list updates do not change the outline.
        const targetHeading = record.target.nodeType === Node.ELEMENT_NODE
          ? record.target.closest(HEADING_SELECTOR) : record.target.parentElement?.closest(HEADING_SELECTOR);
        const changedHeadings = [...record.addedNodes, ...record.removedNodes].some(node =>
          node.nodeType === Node.ELEMENT_NODE
          && (node.matches(HEADING_SELECTOR) || node.querySelector(HEADING_SELECTOR)));
        if (targetHeading || changedHeadings) { scheduleRefresh(); return; }
      } else if (!article || !host) {
        // Only look for article content when it is absent; ignore ordinary comment activity.
        const relevant = [...record.addedNodes].some(node => node.nodeType === Node.ELEMENT_NODE
          && (node.matches(ARTICLE_SELECTORS.join(',')) || node.querySelector(ARTICLE_SELECTORS.join(','))));
        if (relevant) { scheduleRefresh(); return; }
      }
    }
  });

  const themeObserver = new MutationObserver(syncTheme);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearTimeout(debounceTimer);
    clearInterval(routeTimer);
    pageObserver.disconnect();
    themeObserver.disconnect();
    for (const cleanup of cleanups) cleanup();
    unmount();
    article = null;
    if (window[INSTANCE_KEY]?.destroy === destroy) delete window[INSTANCE_KEY];
  }

  const STYLES = `
    :host { all: initial; --panel-width:min(288px,calc(100vw - 32px));
      --bg:#f8fafb; --ink:#34383f; --muted:#858b94; --line:#e9edf2;
      --soft:#f1f4f6; --accent:#ec850d; --hover:#eef1f4; --marker:#e7e8ea;
      font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      color:var(--ink); text-align:left; }
    :host([data-theme="dark"]) { --bg:#25272b; --ink:#e1e5ec; --muted:#9ca5b3;
      --line:#3a3e45; --soft:#2d3036; --accent:#ffbd73; --hover:#343840; --marker:#50545c; }
    *,*::before,*::after { box-sizing:border-box; }
    [hidden] { display:none !important; }
    button,input { font:inherit; color:inherit; }
    button { cursor:pointer; border:0; }
    button:focus-visible,input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    svg { width:18px; height:18px; flex:none; }
    .panel-viewport { position:absolute; top:0; right:0; width:var(--panel-width);
      overflow:hidden; border-radius:8px; pointer-events:none; }
    .panel { display:flex; flex-direction:column; width:100%;
      max-height:calc(100vh - var(--panel-top,80px) - 16px);
      max-height:calc(100dvh - var(--panel-top,80px) - 16px); background:var(--bg);
      border:1px solid var(--line); border-radius:8px; box-shadow:0 4px 20px #1722350a;
      overflow:hidden; transform:translateX(100%); opacity:0; visibility:hidden; pointer-events:none;
      transition:transform .32s cubic-bezier(.22,.61,.36,1),opacity .24s ease,visibility 0s linear .32s; }
    :host([data-open="true"]) .panel { transform:translateX(0); opacity:1; visibility:visible;
      pointer-events:auto; transition-delay:0s; }
    .header,.article-title,.tools { flex-shrink:0; }
    .header { display:flex; align-items:center; padding:16px 16px 8px; }
    .brand { display:flex; align-items:center; gap:9px; }
    .brand strong { font-size:14px; font-weight:650; letter-spacing:.3px; }
    .mark { display:flex; color:var(--accent); }
    .article-title { margin:0 16px 14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      font-size:11px; color:var(--muted); }
    .icon-button { display:grid; place-items:center; width:26px; height:26px; padding:4px;
      border-radius:6px; color:var(--muted); background:transparent; }
    .icon-button:hover { color:var(--ink); background:var(--hover); }
    .icon-button.small { width:24px; height:24px; }
    .icon-button.small svg { width:15px; height:15px; }
    .search-box { display:flex; flex:1; min-width:0; align-items:center; gap:7px; padding:7px 9px;
      border:1px solid var(--line); background:var(--soft); border-radius:8px; color:var(--muted); }
    .search-box svg { width:15px; height:15px; }
    .search-box input { min-width:0; width:100%; border:0; outline:0; background:transparent; font-size:12px; }
    .search-box:focus-within { border-color:var(--accent); }
    .search-box input::placeholder { color:var(--muted); }
    .tools { display:flex; align-items:center; gap:8px; padding:0 14px 12px; }
    .fold-all { flex-shrink:0; }
    .fold-all:disabled { opacity:.45; cursor:default; }
    .navigation { min-height:0; overflow-y:auto; overscroll-behavior:contain; scroll-behavior:auto; padding:0 8px 10px;
      scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
    .outline { list-style:none; margin:0; padding:0; }
    .row { display:flex; align-items:flex-start; gap:1px; padding-left:calc(var(--depth) * 13px); border-radius:7px; }
    .row.chapter { margin-top:8px; }
    .row.chapter:first-child { margin-top:0; }
    .branch,.branch-spacer { width:20px; flex:0 0 20px; height:32px; }
    .branch { display:grid; place-items:center; background:transparent; color:var(--muted); padding:0; }
    .branch svg { width:12px; height:12px; transition:transform .15s; }
    .branch[aria-expanded="true"] svg { transform:rotate(90deg); }
    .branch:hover { color:var(--accent); }
    .branch:disabled { cursor:default; }
    .heading-link { flex:1; min-width:0; display:block; padding:7px 7px 7px 3px; text-align:left;
      line-height:1.55; background:transparent; border-radius:6px; font-size:12px; overflow-wrap:anywhere; }
    .chapter>.heading-link { font-weight:650; }
    .heading-link:hover { background:var(--hover); }
    .heading-link[aria-current] { color:var(--accent); }
    .empty { padding:24px 8px; text-align:center; font-size:12px; color:var(--muted); }
    .footer { display:flex; flex:none; align-items:center; gap:6px; border-top:1px solid var(--line);
      padding:10px 16px; font-size:10px; color:var(--muted); }
    .footer-dot { width:5px; height:5px; border-radius:50%; background:var(--accent); opacity:.65; }
    .launcher { display:flex; flex-direction:column; align-items:center; gap:16px; width:40px;
      max-height:calc(100vh - var(--panel-top,80px) - 16px);
      max-height:calc(100dvh - var(--panel-top,80px) - 16px);
      margin:0; padding:12px 11px; border:0; border-radius:4px; background:transparent;
      overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:none;
      opacity:1; visibility:visible; transition:opacity .18s ease,visibility 0s linear; }
    :host([data-open="true"]) .launcher { opacity:0; visibility:hidden; pointer-events:none;
      transition-delay:0s,.18s; }
    .launcher::-webkit-scrollbar { display:none; }
    .preview-marker { display:block; flex:0 0 8px; width:18px; border-radius:2px; background:var(--marker); }
    .preview-marker[data-current] { background:var(--accent); }
    @media (max-width:700px) { :host { --panel-width:min(310px,calc(100vw - 32px)); } }
    @media (prefers-reduced-motion:reduce) { .branch svg,.panel,.launcher { transition:none; } }
  `;

  window[INSTANCE_KEY] = { destroy };
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  listen(document, 'scroll', requestActiveUpdate, { capture: true, passive: true });
  listen(document, 'load', event => {
    if (event.target instanceof Node && article?.contains(event.target)) requestActiveUpdate();
  }, true);
  listen(window, 'resize', () => { updateInsets(); requestActiveUpdate(); });
  listen(window, 'popstate', scheduleRefresh);
  listen(window, 'pageshow', scheduleRefresh);
  listen(window, 'urlchange', scheduleRefresh);
  if (systemTheme?.addEventListener) listen(systemTheme, 'change', syncTheme);
  // Tampermonkey supplies urlchange. Other managers and the local demo use this
  // inexpensive URL-only fallback; it never periodically scans the DOM.
  if (!('onurlchange' in window)) {
    routeTimer = setInterval(() => { if (path !== location.pathname) scheduleRefresh(); }, 800);
  }
  refresh();
})();
