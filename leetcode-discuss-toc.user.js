// ==UserScript==
// @name         力扣讨论 · 文章目录
// @namespace    local.leetcode-discuss-toc
// @version      1.0.5
// @description  为力扣讨论文章生成可搜索、可折叠、自动高亮的多级目录，点击即可跳转。
// @match        https://leetcode.cn/*
// @run-at       document-idle
// @grant        window.onurlchange
// @noframes
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
  let panelOpen = true;
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
      close: 'm6 6 12 12M6 18 18 6',
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
    panelOpen = open;
    if (!ui) return;
    ui.panel.hidden = !open;
    ui.launcher.hidden = open;
    ui.launcher.setAttribute('aria-expanded', String(open));
    if (!open) stopFollowing();
    if (focus) (open ? ui.search : ui.launcher).focus({ preventScroll: true });
    if (open) {
      followPaused = false;
      requestActiveUpdate();
    }
  }

  function handleEscape(event) {
    if (event.key !== 'Escape' || event.isComposing || !panelOpen || !ui) return;
    event.preventDefault();
    // Keep focus in the article when Escape was pressed outside the panel.
    setPanelOpen(false, Boolean(ui.shadow.activeElement));
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

    const panel = element('aside', { class: 'panel', 'aria-label': '文章目录' });
    const header = element('div', { class: 'header' });
    const brand = element('div', { class: 'brand' });
    const mark = element('span', { class: 'mark' });
    mark.append(icon('list'));
    const heading = element('strong', {}, '文章目录');
    brand.append(mark, heading);
    const close = button('收起目录', 'icon-button');
    close.append(icon('close'));
    header.append(brand, close);

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
    const escape = button('Esc 收起目录', 'escape-button');
    escape.setAttribute('aria-keyshortcuts', 'Escape');
    escape.append(element('kbd', {}, 'Esc'), element('span', {}, '收起'));
    footer.append(element('span', { class: 'footer-dot' }),
      element('span', {}, '点击章节跳转'), escape);
    panel.append(header, articleTitle, tools, navigation, footer);
    const launcher = button('展开文章目录', 'launcher', '');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.append(icon('list'), element('span', {}, '目录'));
    shadow.append(style, panel, launcher);
    document.body.append(host);
    ui = { shadow, panel, launcher, articleTitle, search, foldAll, list, empty, navigation };

    // These listeners are owned by the shadow tree, and disappear with the host.
    close.addEventListener('click', () => setPanelOpen(false, true));
    escape.addEventListener('click', () => setPanelOpen(false, true));
    launcher.addEventListener('click', () => setPanelOpen(true, true));
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
    let bottom = 0;
    for (const candidate of document.querySelectorAll('header,nav,[role="banner"]')) {
      for (let node = candidate, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
        const rect = node.getBoundingClientRect();
        const position = getComputedStyle(node).position;
        if ((position === 'fixed' || position === 'sticky')
          && rect.top <= 1 && rect.bottom > 0 && rect.bottom < window.innerHeight / 3
          && rect.width > window.innerWidth / 3) {
          bottom = Math.max(bottom, rect.bottom);
          break;
        }
      }
    }
    topInset = Math.ceil(bottom) + 16;
    if (host) host.style.setProperty('top', `${Math.max(24, topInset + 14)}px`, 'important');
    for (const { element: node } of entries) {
      if (!savedMargins.has(node)) savedMargins.set(node, {
        value: node.style.getPropertyValue('scroll-margin-top'),
        priority: node.style.getPropertyPriority('scroll-margin-top'),
      });
      node.style.setProperty('scroll-margin-top', `${topInset}px`);
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
      entry.parent?.children.push(entry);
      stack.push(entry);
      return entry;
    });
    activeEntry = null;
    visibleActiveEntry = null;
    if (!ui) mount();
    const title = document.querySelector('#main-content h1, main h1')?.textContent.trim()
      || document.title.replace(/ - 讨论.*$/, '');
    ui.articleTitle.textContent = title;
    ui.articleTitle.title = title;
    ui.list.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const entry of entries) {
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
    if (followPaused || !panelOpen || !visible || ui.search.value.trim()) { stopFollowing(); return; }

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
    if (reducedMotion?.matches) {
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
    if (destroyed || !ui || followPaused || !panelOpen || ui.search.value.trim() || followTarget === null) {
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
    });
  }

  function unmount() {
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
    collapsed.clear();
  }

  function refresh() {
    if (destroyed) return;
    const changedPath = path !== location.pathname;
    path = location.pathname;
    if (changedPath) {
      unmount();
      panelOpen = true;
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
    :host { all: initial; --bg:#fff; --ink:#253044; --muted:#7d8796; --line:#e9edf2;
      --soft:#f6f8fa; --accent:#bc6400; --active:#fff3e4; --hover:#f0f3f6;
      font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
      color:var(--ink); text-align:left; }
    :host([data-theme="dark"]) { --bg:#25272b; --ink:#e1e5ec; --muted:#9ca5b3;
      --line:#3a3e45; --soft:#2d3036; --accent:#ffbd73; --active:#453321; --hover:#343840; }
    *,*::before,*::after { box-sizing:border-box; }
    [hidden] { display:none !important; }
    button,input { font:inherit; color:inherit; }
    button { cursor:pointer; border:0; }
    button:focus-visible,input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    svg { width:18px; height:18px; flex:none; }
    .panel { display:flex; flex-direction:column; width:min(288px,calc(100vw - 32px));
      max-height:calc(100vh - 120px); max-height:calc(100dvh - 120px); background:var(--bg);
      border:1px solid var(--line); border-radius:16px; box-shadow:0 12px 44px #17223516;
      overflow:hidden; }
    .header,.article-title,.tools { flex-shrink:0; }
    .header { display:flex; align-items:center; justify-content:space-between; padding:16px 14px 8px 16px; }
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
    .heading-link[aria-current] { color:var(--accent); background:var(--active); }
    .empty { padding:24px 8px; text-align:center; font-size:12px; color:var(--muted); }
    .footer { display:flex; flex:none; align-items:center; gap:6px; border-top:1px solid var(--line);
      padding:10px 16px; font-size:10px; color:var(--muted); }
    .footer-dot { width:5px; height:5px; border-radius:50%; background:var(--accent); opacity:.65; }
    .escape-button { display:flex; align-items:center; gap:5px; margin-left:auto; padding:2px 5px;
      color:var(--muted); background:transparent; border-radius:4px; font-size:10px; }
    .escape-button:hover { color:var(--ink); background:var(--hover); }
    .escape-button kbd { font:inherit; }
    .launcher { display:flex; align-items:center; gap:7px; border:1px solid var(--line); border-radius:11px;
      background:var(--bg); color:var(--ink); padding:11px 13px; box-shadow:0 5px 24px #17223518; }
    .launcher svg { color:var(--accent); }
    .launcher:hover { background:var(--soft); }
    @media (max-width:700px) { .panel { width:min(310px,calc(100vw - 32px)); } }
    @media (prefers-reduced-motion:reduce) { .branch svg { transition:none; } }
  `;

  window[INSTANCE_KEY] = { destroy };
  pageObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  listen(document, 'scroll', requestActiveUpdate, { capture: true, passive: true });
  listen(window, 'keydown', handleEscape, { capture: true });
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
