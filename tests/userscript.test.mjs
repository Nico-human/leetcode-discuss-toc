import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../leetcode-discuss-toc.user.js', import.meta.url), 'utf8');
const wait = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));
const article = (content, extra = '') => `<main id="main-content"><h1>测试文章</h1>
  <div class="markdown-content_markdown__test Body_markdown__test">${content}</div>${extra}</main>`;

function page(t, { body = article('<h2>第一章</h2><h3>基础</h3><h4>例题</h4><h2>第二章</h2>'),
  width = 1440, height = 768, reduced = false, url = 'https://leetcode.cn/discuss/post/1001/test/',
  header = '<div class="test-header" style="position:fixed;top:0"><nav>力扣</nav></div>',
  storageBlocked = false, previousPanelOpen, controlledFrames = false, openPanel = true } = {}) {
  const dom = new JSDOM(`<!doctype html><html class="light"><body>
    ${header}${body}</body></html>`, {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window: w } = dom;
  t.after(() => { w.__leetcodeDiscussToc__?.destroy(); w.close(); });
  let animationTime = 0;
  let nextFrameId = 0;
  const pendingFrames = new Map();
  if (controlledFrames) {
    w.requestAnimationFrame = callback => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      return id;
    };
    w.cancelAnimationFrame = id => pendingFrames.delete(id);
  }
  function advance(duration = 1000) {
    if (!controlledFrames) return;
    for (let remaining = duration; remaining > 0; remaining -= 16) {
      animationTime += Math.min(remaining, 16);
      for (const [id, callback] of [...pendingFrames]) {
        if (pendingFrames.delete(id)) callback(animationTime);
      }
    }
  }
  Object.defineProperty(w, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(w, 'innerHeight', { value: height, configurable: true });
  w.matchMedia = query => ({ matches: query.includes('reduced-motion') && reduced,
    media: query, addEventListener() {}, removeEventListener() {} });
  if (previousPanelOpen !== undefined) {
    w.localStorage.setItem('lc-discuss-toc:panel-open', String(previousPanelOpen));
  }
  if (storageBlocked) Object.defineProperty(w, 'localStorage', {
    get() { throw new w.DOMException('Storage blocked', 'SecurityError'); },
  });
  let scrollY = 0;
  const jumps = [];
  const geometry = w.Element.prototype.getBoundingClientRect;
  w.Element.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute('data-test-height')) {
      return w.DOMRect.fromRect({
        x: Number(this.dataset.testLeft || 0),
        y: Number(this.dataset.testTop || 0) - (this.dataset.testFlow === 'true' ? scrollY : 0),
        width: Number(this.dataset.testWidth || width), height: Number(this.dataset.testHeight),
      });
    }
    if (this.classList.contains('test-header') || this.tagName === 'NAV' && this.closest('.test-header')) {
      return w.DOMRect.fromRect({ x: 0, y: 0, width, height: 50 });
    }
    if (/^H[1-6]$/.test(this.tagName)) {
      const index = [...w.document.querySelectorAll('h1,h2,h3,h4,h5,h6')].indexOf(this);
      return w.DOMRect.fromRect({ x: 20, y: Number(this.dataset.top || (index + 1) * 500) - scrollY,
        width: 700, height: 32 });
    }
    return geometry.call(this);
  };
  w.Element.prototype.scrollIntoView = function (options) {
    jumps.push({ target: this, options, margin: this.style.scrollMarginTop });
    scrollY += this.getBoundingClientRect().top - Number.parseFloat(this.style.scrollMarginTop || '0');
    w.document.dispatchEvent(new w.Event('scroll'));
  };
  w.eval(source);
  // Existing outline regressions exercise the expanded panel. Initial collapsed
  // state and real hover/focus transitions are covered explicitly below.
  if (openPanel) w.document.getElementById('lc-discuss-toc')?.shadowRoot.querySelector('.launcher').click();
  const shadow = () => w.document.getElementById('lc-discuss-toc')?.shadowRoot;
  const links = () => [...(shadow()?.querySelectorAll('.heading-link') || [])];
  const visible = () => links().filter(link => !link.parentElement.hidden).map(link => link.textContent);
  const movePage = y => { scrollY = y; w.document.dispatchEvent(new w.Event('scroll')); };
  return { w, shadow, links, visible, jumps, advance, movePage, run: () => w.eval(source),
    get animationTime() { return animationTime; },
    get pendingFrames() { return pendingFrames.size; },
    get articleScrollY() { return scrollY; },
    async scroll(y) {
      movePage(y);
      if (controlledFrames) advance();
      else await wait(35);
    },
    async navigate(path, content) {
      w.history.pushState({}, '', path);
      w.document.querySelector('#main-content').outerHTML = content;
      await wait();
    },
  };
}

function longArticle() {
  return article(Array.from({ length: 12 }, (_, index) => {
    const chapter = index + 1;
    const top = index * 1000;
    return `<h2 data-top="${top + 100}">第${chapter}章</h2>`
      + `<h3 data-top="${top + 200}">§${chapter}.1 基础</h3>`
      + `<h4 data-top="${top + 300}">§${chapter}.1.1 细节</h4>`
      + `<h3 data-top="${top + 400}">§${chapter}.2 进阶</h3>`;
  }).join(''));
}

// jsdom has no layout. Model a short, independently scrollable outline whose
// row positions change as sections are folded, just as they do in a browser.
function outlineViewport(p, height = 128) {
  const root = p.shadow();
  const navigation = root.querySelector('.navigation');
  const visibleRows = () => [...root.querySelectorAll('.row')].filter(row => !row.hidden);
  Object.defineProperties(navigation, {
    clientHeight: { get: () => height },
    clientTop: { get: () => 0 },
    scrollHeight: { get: () => Math.max(height, visibleRows().length * 32 + 10) },
  });
  let scrollTop = 0;
  const samples = [];
  Object.defineProperties(navigation, {
    scrollTop: {
      get() { return scrollTop = Math.max(0, Math.min(scrollTop, navigation.scrollHeight - height)); },
      set(value) {
        scrollTop = Math.max(0, Math.min(Number(value), navigation.scrollHeight - height));
        samples.push({ time: p.animationTime, top: scrollTop });
      },
    },
    scrollSamples: { value: samples },
  });
  const previousGeometry = p.w.Element.prototype.getBoundingClientRect;
  p.w.Element.prototype.getBoundingClientRect = function () {
    if (this === navigation) return p.w.DOMRect.fromRect({ x: 1000, y: 180, width: 280, height });
    if (this.classList.contains('row') && this.getRootNode() === root) {
      if (this.hidden) return p.w.DOMRect.fromRect();
      return p.w.DOMRect.fromRect({ x: 1000, y: 180 + visibleRows().indexOf(this) * 32 - navigation.scrollTop,
        width: 260, height: 32 });
    }
    return previousGeometry.call(this);
  };
  return navigation;
}

function assertFollowed(p, title) {
  p.advance();
  const link = p.shadow().querySelector('[aria-current]');
  assert.equal(link?.textContent, title);
  assert.equal(link.parentElement.hidden, false);
  const row = link.parentElement.getBoundingClientRect();
  const viewport = p.shadow().querySelector('.navigation').getBoundingClientRect();
  assert.ok(row.top >= viewport.top - 1, '当前目录项位于目录视口内');
  assert.ok(row.bottom <= viewport.bottom + 1, '当前目录项没有被目录底部裁切');
}

function branchStates(p) {
  return [...p.shadow().querySelectorAll('.branch')].map(branch => [
    branch.parentElement.querySelector('.heading-link').textContent,
    branch.getAttribute('aria-expanded'),
  ]);
}

function hover(p, inside) {
  p.w.document.getElementById('lc-discuss-toc').dispatchEvent(new p.w.MouseEvent(
    inside ? 'mouseenter' : 'mouseleave',
  ));
}

async function closePanel(p) {
  // The default fixture opens by keyboard/click. Entering switches back to
  // pointer interaction, then leaving exercises the actual auto-close timer.
  hover(p, true);
  hover(p, false);
  await wait();
}

test('初始收缩为每个一级目录项对应的方块，保留右侧位置且不抢正文焦点', t => {
  const p = page(t, { openPanel: false });
  const host = p.w.document.getElementById('lc-discuss-toc');
  const rail = p.shadow().querySelector('.launcher');
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.equal(rail.hidden, false);
  assert.equal(rail.getAttribute('aria-expanded'), 'false');
  assert.equal(rail.getAttribute('aria-controls'), 'lc-toc-panel');
  assert.equal(rail.querySelectorAll('.preview-marker').length, 2);
  assert.equal(p.links().length, 4);
  assert.equal(rail.textContent, '');
  assert.equal(host.style.top, '80px');
  assert.equal(host.style.right, '16px');
  assert.equal(p.w.document.activeElement, p.w.document.body);
});

test('方块按目录层级识别一级项，兼容未使用 h1 及跳级子标题，完整目录仍保留所有标题', t => {
  const p = page(t, { openPanel: false,
    body: article('<h3>甲</h3><h5>跳级小节</h5><h6>细节</h6><h3>乙</h3>') });
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 2);
  hover(p, true);
  assert.deepEqual(p.visible(), ['甲', '跳级小节', '细节', '乙']);
});

test('异步增加子标题不增加方块，提升为一级项或移除时同步更新数量', async t => {
  const p = page(t, { openPanel: false });
  const body = p.w.document.querySelector('.Body_markdown__test');
  body.insertAdjacentHTML('beforeend', '<h3>新增子标题</h3>');
  await wait();
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 2);
  assert.equal(p.links().length, 5);
  const chapter = p.w.document.createElement('h2');
  chapter.textContent = '新增一级标题';
  body.lastChild.replaceWith(chapter);
  await wait();
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 3);
  chapter.remove();
  await wait();
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 2);
});

test('悬停方块自动展开，移出完整目录后自动收缩，正文位置和焦点不变', async t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(p.shadow().querySelector('.launcher').inert, true);
  assert.equal(p.w.document.activeElement, p.w.document.body);
  hover(p, false);
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.equal(p.shadow().querySelector('.launcher').inert, false);
  assert.equal(p.articleScrollY, 0);
  assert.equal(p.jumps.length, 0);
});

test('滑入和滑出保留两层 DOM，立即切换交互权限，不使用 display none 打断过渡', async t => {
  const p = page(t, { openPanel: false });
  const host = p.w.document.getElementById('lc-discuss-toc');
  const panel = p.shadow().querySelector('.panel');
  const rail = p.shadow().querySelector('.launcher');
  assert.equal(panel.hidden, false);
  assert.equal(rail.hidden, false);
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.equal(rail.getAttribute('aria-hidden'), 'false');
  hover(p, true);
  assert.equal(host.dataset.open, 'true');
  assert.equal(panel.inert, false);
  assert.equal(rail.inert, true);
  assert.equal(panel.getAttribute('aria-hidden'), 'false');
  assert.equal(rail.getAttribute('aria-hidden'), 'true');
  hover(p, false);
  await wait();
  assert.equal(host.dataset.open, 'false');
  assert.equal(panel.inert, true);
  assert.equal(rail.inert, false);
  assert.equal(panel.getAttribute('aria-hidden'), 'true');
  assert.equal(panel.hidden, false);
  assert.equal(rail.hidden, false);
  assert.equal(p.shadow().querySelector('.panel'), panel);
});

test('滑出未结束时重新进入沿用原面板和搜索状态，并解除隐藏面板内的焦点', async t => {
  const p = page(t, { openPanel: false });
  const input = p.shadow().querySelector('input');
  hover(p, true);
  input.focus();
  input.value = '基础';
  input.dispatchEvent(new p.w.Event('input'));
  hover(p, false);
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.notEqual(p.shadow().activeElement, input);
  hover(p, true);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(p.shadow().querySelector('input'), input);
  assert.equal(input.value, '基础');
  assert.deepEqual(p.visible(), ['第一章', '基础']);
  assert.equal(p.articleScrollY, 0);
});

test('移出后快速重新进入取消收起，不会在目录内操作时闪回方块', async t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  hover(p, false);
  await wait(60);
  hover(p, true);
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  p.shadow().querySelector('.branch').dispatchEvent(new p.w.MouseEvent('mouseenter'));
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, false);
});

test('鼠标搜索后移出仍会收缩，再悬停保留搜索词与原有折叠状态', async t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  p.shadow().querySelector('.branch').click();
  const input = p.shadow().querySelector('input');
  input.focus();
  input.value = '基础';
  input.dispatchEvent(new p.w.Event('input'));
  hover(p, false);
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  hover(p, true);
  assert.equal(input.value, '基础');
  assert.deepEqual(p.visible(), ['第一章', '基础']);
  input.value = '';
  input.dispatchEvent(new p.w.Event('input'));
  assert.deepEqual(p.visible(), ['第一章', '第二章']);
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 2);
});

test('键盘聚焦方块可打开搜索，控件间切换保持展开，离开目录后收起', async t => {
  const p = page(t, { openPanel: false });
  p.shadow().querySelector('.launcher').focus();
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(p.shadow().activeElement, p.shadow().querySelector('input'));
  p.shadow().querySelector('.fold-all').focus();
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  const outside = p.w.document.querySelector('h1');
  outside.tabIndex = 0;
  outside.focus();
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.equal(p.w.document.activeElement, outside);
});

test('目录不再显示关闭叉、Esc 提示或 Esc 快捷键入口', t => {
  const p = page(t);
  assert.equal(p.shadow().querySelector('.header button'), null);
  assert.equal(p.shadow().querySelector('.escape-button,[aria-keyshortcuts="Escape"],[data-icon="close"]'), null);
  assert.doesNotMatch(p.shadow().querySelector('.panel').textContent, /\bEsc\b/);
  assert.equal(p.shadow().querySelector('.footer').textContent, '点击章节跳转');
});

test('收起时方块标记当前小节所属一级目录，不受目录折叠和搜索过滤影响', async t => {
  const p = page(t, { openPanel: false, body: longArticle(), controlledFrames: true });
  await p.scroll(7234);
  const markedIndex = () => [...p.shadow().querySelectorAll('.preview-marker')]
    .findIndex(marker => marker.hasAttribute('data-current'));
  assert.equal(markedIndex(), 7);
  await p.scroll(7334);
  assert.equal(markedIndex(), 7, '同一章内切换子标题时保持同一个方块高亮');
  hover(p, true);
  p.shadow().querySelector('.fold-all').click();
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '第8章');
  assert.equal(markedIndex(), 7);
  const input = p.shadow().querySelector('input');
  input.value = '第1章';
  input.dispatchEvent(new p.w.Event('input'));
  hover(p, false);
  await wait();
  await p.scroll(2134);
  assert.equal(markedIndex(), 2);
  assert.equal(p.shadow().querySelectorAll('.preview-marker[data-current]').length, 1);
  assert.equal(p.shadow().querySelector('.panel').inert, true);
});

test('长目录收起时同步方块列和完整目录，不滚动正文', async t => {
  const p = page(t, { openPanel: false, body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  const rail = p.shadow().querySelector('.launcher');
  Object.defineProperty(rail, 'clientHeight', { value: 120 });
  rail.getBoundingClientRect = () => p.w.DOMRect.fromRect({ x: 1000, y: 80, width: 40, height: 120 });
  [...rail.children].forEach((marker, index) => {
    marker.getBoundingClientRect = () => p.w.DOMRect.fromRect({
      x: 1011, y: 92 + index * 24 - rail.scrollTop, width: 18, height: 8,
    });
  });
  await p.scroll(7234);
  assert.ok(rail.scrollTop > 0);
  const marker = rail.querySelector('[data-current]').getBoundingClientRect();
  assert.ok(marker.top >= 80 && marker.bottom <= 200);
  assert.ok(navigation.scrollTop > 0);
  assertFollowed(p, '§8.1.1 细节');
  assert.equal(p.articleScrollY, 7234);
  assert.equal(p.jumps.length, 0);
});

test('待收起时站内切换文章，不会由旧定时器关闭新目录', async t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  hover(p, false);
  await p.navigate('/discuss/post/1002/next/', article('<h2>新章节</h2>'));
  hover(p, true);
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 1);
});

test('异步增删标题同步更新方块，不改变当前悬停展开状态', async t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  const body = p.w.document.querySelector('.Body_markdown__test');
  body.insertAdjacentHTML('beforeend', '<h2>追加章节</h2>');
  await wait();
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 3);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  body.lastChild.remove();
  await wait();
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 2);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
});

test('仅提取正文，包含 h4/h5/h6，排除文章大标题和评论', t => {
  const p = page(t, { body: article('<h2>章节</h2><h3>小节</h3><h4>细节</h4><h5>第五级</h5><h6>第六级</h6>',
    '<section><div class="markdown-content_markdown__test"><h2>评论里的标题</h2></div></section>') });
  assert.deepEqual(p.visible(), ['章节', '小节', '细节', '第五级', '第六级']);
  assert.equal(p.shadow().querySelector('.count,.status'), null);
  assert.doesNotMatch(p.shadow().querySelector('.panel').textContent, /个章节|个匹配|共\s*\d+\s*节/);
});

test('跳级标题仍组成正确层级，折叠后不影响后续同级章节', t => {
  const p = page(t, { body: article('<h2>甲</h2><h4>跳级小节</h4><h3>普通小节</h3><h2>乙</h2>') });
  assert.deepEqual([...p.shadow().querySelectorAll('.row')].map(row => row.style.getPropertyValue('--depth')),
    ['0', '1', '1', '0']);
  p.shadow().querySelector('.branch').click();
  assert.deepEqual(p.visible(), ['甲', '乙']);
  p.shadow().querySelector('.branch').click();
  assert.equal(p.visible().length, 4);
});

test('重复文字及重复 ID 按元素跳转，不会定位到另一个同名标题', t => {
  const p = page(t, { body: article('<h2 id="same">基础</h2><h2 id="same">基础</h2>') });
  const targets = p.w.document.querySelectorAll('.Body_markdown__test h2');
  p.links()[1].click();
  assert.equal(p.jumps[0].target, targets[1]);
});

test('点击标题平滑定位，并留出固定导航的 50px 和额外 16px', t => {
  const p = page(t);
  p.links()[2].click();
  assert.equal(p.jumps[0].options.behavior, 'smooth');
  assert.equal(p.jumps[0].options.block, 'start');
  assert.equal(p.jumps[0].margin, '66px');
  assert.equal(p.w.location.hash, '');
});

for (const [name, header] of [
  ['普通流语义导航', '<header data-test-height="64" data-test-flow="true"><nav>力扣</nav></header>'],
  ['相对定位的站点导航容器', '<div id="navbar-container" style="position:relative" '
    + 'data-test-height="64" data-test-flow="true">力扣</div>'],
]) {
  test(`${name}滚出再滚回时，目录实时避让顶部导航，跳转不多留普通流导航高度`, async t => {
    const p = page(t, { header, controlledFrames: true });
    const host = p.w.document.getElementById('lc-discuss-toc');
    assert.equal(host.style.top, '94px');
    assert.equal(host.style.getPropertyValue('--panel-top'), '94px');
    assert.equal(p.w.document.querySelector('.Body_markdown__test h2').style.scrollMarginTop, '16px');
    await p.scroll(32);
    assert.equal(host.style.top, '62px', '部分露出的导航按其当前底边避让');
    await p.scroll(128);
    assert.equal(host.style.top, '30px', '导航完全滚出后释放顶部空间');
    await p.scroll(0);
    assert.equal(host.style.top, '94px', '仅靠滚动事件即可重新避让');
    assert.equal(host.style.getPropertyValue('--panel-top'), '94px');
    p.links()[1].click();
    assert.equal(p.jumps[0].margin, '16px');
  });
}

test('固定导航存在正顶部偏移时，面板避让和标题跳转均采用其真实底边', t => {
  const p = page(t, { header: '<div id="leetcode-navbar" style="position:fixed;top:12px" '
    + 'data-test-top="12" data-test-height="64"><nav>力扣</nav></div>', controlledFrames: true });
  const host = p.w.document.getElementById('lc-discuss-toc');
  assert.equal(host.style.top, '106px');
  assert.equal(host.style.getPropertyValue('--panel-top'), '106px');
  p.links()[1].click();
  assert.equal(p.jumps[0].margin, '92px');
  p.advance();
  assert.equal(host.style.top, '106px');
});

test('普通流导航与偏移 sticky 栏并存时，面板避让可见栏，阅读留白只计算遮挡栏', t => {
  const p = page(t, {
    header: '<header data-test-height="100">普通流站点导航</header>'
      + '<div style="position:sticky;top:12px" data-test-top="12" data-test-height="64">'
      + '<nav>固定工具栏</nav></div>',
    controlledFrames: true,
  });
  const host = p.w.document.getElementById('lc-discuss-toc');
  assert.equal(host.style.top, '130px');
  p.links()[1].click();
  assert.equal(p.jumps[0].margin, '92px');
});

test('多个固定或 sticky 顶部栏取最下方底边，避免只识别第一层导航', t => {
  const p = page(t, {
    header: '<header style="position:fixed;top:0" data-test-height="32">主导航</header>'
      + '<div id="navbar-container" style="position:sticky;top:32px" '
      + 'data-test-top="32" data-test-height="48">讨论导航</div>',
    controlledFrames: true,
  });
  assert.equal(p.w.document.getElementById('lc-discuss-toc').style.top, '110px');
  p.links()[0].click();
  assert.equal(p.jumps[0].margin, '96px');
});

test('不可见、离开视口、低位导航和高大侧栏不占据目录顶部空间', t => {
  const p = page(t, {
    header: '<header style="visibility:hidden" data-test-height="120">隐藏导航</header>'
      + '<header hidden data-test-height="110">未显示导航</header>'
      + '<nav data-test-top="-100" data-test-height="64">已移出视口</nav>'
      + '<nav data-test-top="400" data-test-height="32">页面下方导航</nav>'
      + '<nav data-test-height="640">高大侧栏</nav>'
      + '<nav data-test-height="100" data-test-width="200">窄侧栏</nav>',
    controlledFrames: true,
  });
  assert.equal(p.w.document.getElementById('lc-discuss-toc').style.top, '30px');
  p.links()[0].click();
  assert.equal(p.jumps[0].margin, '16px');
});

test('正文和 main 内部导航不被误识别为站点顶栏', t => {
  const p = page(t, {
    header: '',
    body: article('<nav style="position:fixed;top:0" data-test-height="120">正文内导航</nav>'
      + '<h2>章节</h2><h3>小节</h3>',
    '<header style="position:fixed;top:0" data-test-height="100">文章信息栏</header>'),
    controlledFrames: true,
  });
  assert.equal(p.w.document.getElementById('lc-discuss-toc').style.top, '30px');
  p.links()[0].click();
  assert.equal(p.jumps[0].margin, '16px');
});

test('顶栏几何变化更新目录避让时，手动浏览暂停状态不被解除', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true,
    header: '<div id="leetcode-navbar" style="position:fixed;top:0" '
      + 'data-test-height="50"><nav>力扣</nav></div>' });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  const header = p.w.document.getElementById('leetcode-navbar');
  header.style.top = '24px';
  header.dataset.testTop = '24';
  header.dataset.testHeight = '80';
  p.w.dispatchEvent(new p.w.Event('resize'));
  p.advance();
  assert.equal(p.w.document.getElementById('lc-discuss-toc').style.top, '134px');
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1 基础');
  p.movePage(7135);
  assertFollowed(p, '§8.1 基础');
});

test('面板最大高度使用当前顶部避让变量，并保留视口底部空间', async t => {
  const p = page(t, { height: 600, controlledFrames: true,
    header: '<header data-test-height="96" data-test-flow="true">站点导航</header>' });
  const host = p.w.document.getElementById('lc-discuss-toc');
  assert.equal(host.style.top, '126px');
  assert.equal(host.style.getPropertyValue('--panel-top'), host.style.top);
  // jsdom does not attach a sheet to styles inside a shadow root. Parse the
  // mounted UI's styles with its CSSOM instead of asserting userscript source.
  const mountedStyle = p.shadow().querySelector('style');
  const parsedStyle = p.w.document.createElement('style');
  parsedStyle.textContent = mountedStyle.textContent;
  p.w.document.head.append(parsedStyle);
  const panelRule = [...parsedStyle.sheet.cssRules].find(rule => rule.selectorText === '.panel');
  assert.ok(panelRule);
  assert.match(panelRule.style.getPropertyValue('max-height'),
    /^calc\(100dvh\s*-\s*var\(--panel-top,\s*80px\)\s*-\s*16px\)$/);
  await p.scroll(128);
  assert.equal(host.style.top, '30px');
  assert.equal(host.style.getPropertyValue('--panel-top'), host.style.top,
    '导航滚出后的高度限制使用同一个实时顶部偏移');
});

test('减少动态效果偏好使用即时跳转', t => {
  const p = page(t, { reduced: true });
  p.links()[0].click();
  assert.equal(p.jumps[0].options.behavior, 'instant');
});

test('搜索保留匹配项的祖先，清空后恢复原有折叠状态', t => {
  const p = page(t);
  p.shadow().querySelector('.branch').click();
  const search = p.shadow().querySelector('input');
  search.value = '例题';
  search.dispatchEvent(new p.w.Event('input'));
  assert.deepEqual(p.visible(), ['第一章', '基础', '例题']);
  search.value = '';
  search.dispatchEvent(new p.w.Event('input'));
  assert.deepEqual(p.visible(), ['第一章', '第二章']);
});

test('零搜索结果显示空状态，单个展开收起按钮可以恢复完整目录', t => {
  const p = page(t);
  const search = p.shadow().querySelector('input');
  search.value = '不存在的章节';
  search.dispatchEvent(new p.w.Event('input'));
  assert.equal(p.visible().length, 0);
  assert.equal(p.shadow().querySelector('.empty').hidden, false);
  search.value = '';
  search.dispatchEvent(new p.w.Event('input'));
  const toggle = p.shadow().querySelector('.fold-all');
  assert.equal(p.shadow().querySelectorAll('.tools button').length, 1);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.querySelector('svg').dataset.icon, 'expand');
  toggle.click();
  assert.deepEqual(p.visible(), ['第一章', '第二章']);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.querySelector('svg').dataset.icon, 'collapse');
  assert.equal(toggle.getAttribute('aria-label'), '全部展开');
  toggle.click();
  assert.equal(p.visible().length, 4);
  assert.equal(toggle.querySelector('svg').dataset.icon, 'expand');
});

test('部分章节收起后，总开关显示收起状态，点击可全部展开', t => {
  const p = page(t);
  p.shadow().querySelector('.branch').click();
  const toggle = p.shadow().querySelector('.fold-all');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.querySelector('svg').dataset.icon, 'collapse');
  toggle.click();
  assert.equal(p.visible().length, 4);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
});

test('搜索时不显示章节或匹配数量，并暂时禁用总开关', t => {
  const p = page(t);
  const input = p.shadow().querySelector('input');
  input.value = '例题';
  input.dispatchEvent(new p.w.Event('input'));
  assert.equal(p.shadow().querySelector('.fold-all').disabled, true);
  assert.doesNotMatch(p.shadow().querySelector('.panel').textContent, /个章节|个匹配|共\s*\d+\s*节/);
  input.value = '';
  input.dispatchEvent(new p.w.Event('input'));
  assert.equal(p.shadow().querySelector('.fold-all').disabled, false);
});

test('长章节内没有可见标题时，仍高亮所属章节；向上滚动也正确', async t => {
  const p = page(t, { body: article('<h2 data-top="100">开头</h2><h2 data-top="10000">下一章</h2>') });
  await p.scroll(7000);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '开头');
  await p.scroll(10000);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '下一章');
  await p.scroll(0);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '开头');
});

test('页面到底时，无法滚到顶部的末尾标题仍可高亮', async t => {
  const p = page(t, { body: article('<h2 data-top="100">开头</h2><h2 data-top="2800">末尾</h2>') });
  const root = p.w.document.documentElement;
  Object.defineProperties(root, {
    scrollHeight: { value: 3000 },
    scrollTop: { value: 3000 - p.w.innerHeight, configurable: true },
  });
  await p.scroll(3000 - p.w.innerHeight);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '末尾');
});

test('异步加载正文后自动出现目录', async t => {
  const p = page(t, { body: '<main id="main-content"><p>加载中</p></main>' });
  assert.equal(p.shadow(), undefined);
  p.w.document.querySelector('main').innerHTML = '<div class="Body_markdown__test"><h2>异步章节</h2></div>';
  await wait();
  assert.deepEqual(p.visible(), ['异步章节']);
});

test('正文开始没有标题，后续追加标题也能被识别', async t => {
  const p = page(t, { body: article('<p>暂无章节</p>') });
  assert.equal(p.shadow(), undefined);
  p.w.document.querySelector('.Body_markdown__test').insertAdjacentHTML('beforeend', '<h2>新增</h2>');
  await wait();
  assert.deepEqual(p.visible(), ['新增']);
});

test('正文标题改名、增删后自动更新', async t => {
  const p = page(t);
  p.w.document.querySelector('.Body_markdown__test h2').firstChild.data = '新章节名';
  await wait();
  assert.equal(p.links()[0].textContent, '新章节名');
  p.w.document.querySelector('.Body_markdown__test h4').remove();
  await wait();
  assert.equal(p.links().length, 3);
});

test('更新代码块和评论不会重建目录或丢失搜索状态', async t => {
  const p = page(t, { body: article('<h2>章节</h2><pre><code>原代码</code></pre>',
    '<div class="comments">评论</div>') });
  const originalLink = p.links()[0];
  const search = p.shadow().querySelector('input');
  search.value = '章节';
  p.w.document.querySelector('code').textContent = '切换语言后的代码';
  p.w.document.querySelector('.comments').innerHTML = '<h2>新增评论标题</h2>';
  await wait();
  assert.equal(p.links()[0], originalLink);
  assert.equal(search.value, '章节');
  assert.equal(p.links().length, 1);
});

test('SPA 切换文章更新目录，并在离开文章页时清理', async t => {
  const p = page(t);
  await p.navigate('/discuss/post/1002/next/', article('<h2>新文章</h2>'));
  assert.deepEqual(p.visible(), ['新文章']);
  assert.equal(p.w.document.querySelectorAll('#lc-discuss-toc').length, 1);
  await p.navigate('/problemset/', '<main id="main-content"><h2>题库</h2></main>');
  assert.equal(p.shadow(), undefined);
  await p.navigate('/discuss/post/1003/third/', article('<h2>返回文章</h2>'));
  assert.deepEqual(p.visible(), ['返回文章']);
});

test('非文章页启动后，站内进入文章也能挂载', async t => {
  const p = page(t, { url: 'https://leetcode.cn/problemset/', body: '<main id="main-content">题库</main>' });
  assert.equal(p.shadow(), undefined);
  await p.navigate('/discuss/post/1004/demo/', article('<h2>进入文章</h2>'));
  assert.deepEqual(p.visible(), ['进入文章']);
});

test('URL hash 变化不会重置搜索和目录状态', async t => {
  const p = page(t);
  const link = p.links()[0];
  p.shadow().querySelector('input').value = '基础';
  p.w.history.pushState({}, '', '#existing-heading');
  p.w.dispatchEvent(new p.w.Event('urlchange'));
  await wait();
  assert.equal(p.links()[0], link);
  assert.equal(p.shadow().querySelector('input').value, '基础');
});

test('目录按钮引用过期时不跳转旧元素，随后更新新正文', async t => {
  const p = page(t);
  const oldLink = p.links()[0];
  p.w.document.querySelector('.Body_markdown__test').innerHTML = '<h2>替换后的标题</h2>';
  oldLink.click();
  assert.equal(p.jumps.length, 0);
  await wait();
  assert.deepEqual(p.visible(), ['替换后的标题']);
});

test('重复注入只保留一份实例，销毁后恢复标题原有样式', t => {
  const p = page(t, { body: article('<h2 style="scroll-margin-top:12px!important">章节</h2>') });
  p.run();
  assert.equal(p.w.document.querySelectorAll('#lc-discuss-toc').length, 1);
  p.w.__leetcodeDiscussToc__.destroy();
  const heading = p.w.document.querySelector('.Body_markdown__test h2');
  assert.equal(heading.style.scrollMarginTop, '12px');
  assert.equal(heading.style.getPropertyPriority('scroll-margin-top'), 'important');
  assert.equal(p.shadow(), undefined);
});

test('浏览器禁用存储时，目录仍然可正常使用', async t => {
  const p = page(t, { storageBlocked: true });
  p.links()[0].click();
  assert.equal(p.jumps.length, 1);
  await closePanel(p);
  assert.equal(p.shadow().querySelector('.launcher').inert, false);
});

test('窄屏及旧版展开偏好都默认显示方块，进入新文章也显示方块且章节未折叠', async t => {
  const p = page(t, { width: 390, previousPanelOpen: true, openPanel: false });
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  p.shadow().querySelector('.launcher').click();
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  await closePanel(p);
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  await p.navigate('/discuss/post/1005/mobile/', article('<h2>新文章</h2><h3>小节</h3>'));
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.deepEqual(p.visible(), ['新文章', '小节']);
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 1);
});

test('正文中的 Esc 不收起目录、不阻止默认行为，也不改变正文焦点', t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  const title = p.w.document.querySelector('h1');
  title.tabIndex = 0;
  title.focus();
  const escape = new p.w.KeyboardEvent('keydown', {
    key: 'Escape', bubbles: true, composed: true, cancelable: true,
  });
  assert.equal(title.dispatchEvent(escape), true);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(p.w.document.activeElement, title);
});

test('搜索框中的普通和组合输入 Esc 都不收起目录或抢占按键，移出仍自动收起', async t => {
  const p = page(t, { openPanel: false });
  hover(p, true);
  const input = p.shadow().querySelector('input');
  input.focus();
  input.value = '基础';
  input.dispatchEvent(new p.w.Event('input'));
  for (const isComposing of [false, true]) {
    const escape = new p.w.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, composed: true, cancelable: true, isComposing,
    });
    assert.equal(input.dispatchEvent(escape), true);
    assert.equal(escape.defaultPrevented, false);
    assert.equal(p.shadow().querySelector('.panel').inert, false);
    assert.equal(p.shadow().activeElement, input);
    assert.equal(input.value, '基础');
  }
  await closePanel(p);
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  hover(p, true);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(input.value, '基础');
});

test('同一篇文章异步更新不会重新打开收起的目录，重新加载脚本也显示方块', async t => {
  const p = page(t);
  await closePanel(p);
  p.w.document.querySelector('.Body_markdown__test').insertAdjacentHTML('beforeend', '<h2>异步标题</h2>');
  await wait();
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  p.run();
  assert.equal(p.shadow().querySelector('.panel').inert, true);
});

test('网站切换深浅色时同步主题', async t => {
  const p = page(t);
  assert.equal(p.w.document.getElementById('lc-discuss-toc').dataset.theme, 'light');
  p.w.document.documentElement.className = 'dark';
  await wait(15);
  assert.equal(p.w.document.getElementById('lc-discuss-toc').dataset.theme, 'dark');
});

test('备用正文选择器生效，空标题与隐藏标题不进入目录', t => {
  const p = page(t, { body: '<main><div class="markdown-content_markdown__new"><h1>正文一级</h1>'
    + '<h2> </h2><h2 hidden>隐藏</h2><h3>可见</h3></div>'
    + '<div class="markdown-content_markdown__new"><h2>评论</h2></div></main>' });
  assert.deepEqual(p.visible(), ['正文一级', '可见']);
});

test('标题内容作为文本展示，标题没有 ID 时也可以跳转', t => {
  const p = page(t, { body: article('<h2>&lt;img src=x onerror=alert(1)&gt;</h2>') });
  assert.equal(p.links()[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(p.shadow().querySelector('img'), null);
  p.links()[0].click();
  assert.equal(p.jumps[0].target.id, '');
});

test('全部展开时，目录跟随到第八章，只滚动目录且不改变正文位置或焦点', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  const title = p.w.document.querySelector('h1');
  title.tabIndex = 0;
  title.focus();
  await p.scroll(7134);
  assertFollowed(p, '§8.1 基础');
  assert.ok(navigation.scrollTop > 0);
  assert.equal(p.articleScrollY, 7134);
  assert.equal(p.jumps.length, 0, '跟随目录不能对正文或目录项调用 scrollIntoView');
  assert.equal(p.w.document.activeElement, title);
  await p.scroll(0);
  assertFollowed(p, '第1章');
  assert.equal(navigation.scrollTop, 0);
});

test('全部收起时，跟随并高亮当前小节所属的可见章节，保持全部收起', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  outlineViewport(p);
  p.shadow().querySelector('.fold-all').click();
  const before = branchStates(p);
  await p.scroll(7134);
  assertFollowed(p, '第8章');
  assert.deepEqual(branchStates(p), before);
  assert.equal(p.visible().length, 12);
  assert.equal(p.shadow().querySelector('.fold-all').getAttribute('aria-expanded'), 'false');
});

test('部分展开时跟随可见上级，手动折叠只更新高亮，正文再滚动后跟随当前小节', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.shadow().querySelector('[aria-label="折叠 第2章"]').click();
  p.shadow().querySelector('[aria-label="折叠 §8.1 基础"]').click();
  const before = branchStates(p);
  await p.scroll(7234);
  assertFollowed(p, '§8.1 基础');
  assert.deepEqual(branchStates(p), before);
  const stopped = navigation.scrollTop;
  p.shadow().querySelector('[aria-label="折叠 第8章"]').click();
  p.advance();
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '第8章');
  assert.equal(navigation.scrollTop, stopped);
  p.shadow().querySelector('[aria-label="展开 第8章"]').click();
  p.advance();
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1 基础');
  assert.equal(navigation.scrollTop, stopped);
  p.shadow().querySelector('[aria-label="展开 §8.1 基础"]').click();
  p.advance();
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1.1 细节');
  assert.equal(navigation.scrollTop, stopped);
  p.movePage(7235);
  assertFollowed(p, '§8.1.1 细节');
  assert.equal(p.shadow().querySelector('[aria-label="展开 第2章"]').getAttribute('aria-expanded'), 'false');
});

test('手动全部展开或收起保留目录浏览位置，正文再滚动后恢复跟随', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7234);
  navigation.scrollTop = 0;
  p.shadow().querySelector('.fold-all').click();
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '第8章');
  p.shadow().querySelector('.fold-all').click();
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1.1 细节');
  p.movePage(7235);
  assertFollowed(p, '§8.1.1 细节');
});

test('点击其他章节展开或收起不把目录拉回正文所在章节', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  // Direct click also covers keyboard activation without a preceding pointerdown.
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1 基础');
  p.shadow().querySelector('[aria-label="展开 第1章"]').click();
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.articleScrollY, 7134);
  assert.equal(p.jumps.length, 0);
  p.movePage(7135);
  assertFollowed(p, '§8.1 基础');
});

test('手动折叠后，已经排队的位置更新帧只更新高亮，不重新启动跟随', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7234);
  navigation.scrollTop = 64;
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  p.advance();
  assert.equal(navigation.scrollTop, 64);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1.1 细节');
  assert.equal(p.pendingFrames, 0);
  p.movePage(7235);
  assertFollowed(p, '§8.1.1 细节');
});

test('跟随动画中手动折叠会立即停止，展开后也保持停止，正文滚动后平滑恢复', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(64);
  assert.ok(navigation.scrollTop > 0);
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  const stopped = navigation.scrollTop;
  p.advance();
  assert.equal(navigation.scrollTop, stopped);
  p.shadow().querySelector('[aria-label="展开 第1章"]').click();
  p.advance();
  assert.equal(navigation.scrollTop, stopped);
  assert.equal(p.pendingFrames, 0);
  p.movePage(7135);
  p.advance(16);
  assert.equal(navigation.scrollTop, stopped, '恢复时只更新动画目标');
  assertFollowed(p, '§8.1 基础');
});

test('手动折叠后 resize、图片加载和正文变化只更新高亮，不抢占目录位置', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  p.advance();
  p.w.dispatchEvent(new p.w.Event('resize'));
  p.advance();
  assert.equal(navigation.scrollTop, 0, '窗口尺寸变化不恢复自动跟随');
  const body = p.w.document.querySelector('.Body_markdown__test');
  const image = p.w.document.createElement('img');
  body.append(image);
  await Promise.resolve();
  p.advance();
  image.dispatchEvent(new p.w.Event('load'));
  p.advance();
  assert.equal(navigation.scrollTop, 0, '图片加载不恢复自动跟随');
  body.append(p.w.document.createElement('p'));
  body.lastChild.textContent = '异步更新的正文段落';
  await Promise.resolve();
  p.advance();
  assert.equal(navigation.scrollTop, 0, '正文变化不恢复自动跟随');
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1 基础');
  p.movePage(7135);
  assertFollowed(p, '§8.1 基础');
});

test('手动浏览目录后，无关页面区域滚动不恢复跟随，文章外层滚动才恢复', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  const unrelated = p.w.document.createElement('aside');
  p.w.document.body.append(unrelated);
  unrelated.dispatchEvent(new p.w.Event('scroll'));
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  p.movePage(7135);
  assertFollowed(p, '§8.1 基础');
});

for (const [name, event] of [
  ['滚轮', w => new w.WheelEvent('wheel', { deltaY: -100, bubbles: true, composed: true })],
  ['鼠标按下', w => new w.Event('pointerdown', { bubbles: true, composed: true })],
  ['触摸', w => new w.Event('touchstart', { bubbles: true, composed: true })],
  ['键盘', w => new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, composed: true })],
]) {
  test(`目录${name}操作暂停待执行跟随，尺寸变化不解除，正文滚动后恢复`, async t => {
    const p = page(t, { body: longArticle(), controlledFrames: true });
    const navigation = outlineViewport(p);
    await p.scroll(7134);
    p.movePage(7135);
    navigation.dispatchEvent(event(p.w));
    navigation.scrollTop = 0;
    p.w.dispatchEvent(new p.w.Event('resize'));
    p.advance();
    assert.equal(navigation.scrollTop, 0);
    p.movePage(7136);
    assertFollowed(p, '§8.1 基础');
  });
}

for (const [name, resume] of [
  ['重新打开目录', async p => {
    await closePanel(p);
    p.shadow().querySelector('.launcher').click();
  }],
  ['清空搜索', p => {
    const input = p.shadow().querySelector('input');
    input.value = '章';
    input.dispatchEvent(new p.w.Event('input'));
    input.value = '';
    input.dispatchEvent(new p.w.Event('input'));
  }],
  ['点击章节跳转', p => p.shadow().querySelector('[aria-label="§8.1 基础"]').click()],
]) {
  test(`手动折叠暂停后，${name}可以主动恢复跟随`, async t => {
    const p = page(t, { body: longArticle(), controlledFrames: true });
    const navigation = outlineViewport(p);
    await p.scroll(7134);
    navigation.scrollTop = 0;
    p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
    p.advance();
    assert.equal(navigation.scrollTop, 0);
    await resume(p);
    assertFollowed(p, '§8.1 基础');
  });
}

test('面板关闭时已同步完整目录，重新打开位置不变并保留原有收起状态', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.shadow().querySelector('.fold-all').click();
  await closePanel(p);
  const before = branchStates(p);
  await p.scroll(7234);
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.ok(navigation.scrollTop > 0);
  assertFollowed(p, '第8章');
  const beforeOpen = navigation.scrollTop;
  p.shadow().querySelector('.launcher').click();
  assert.equal(navigation.scrollTop, beforeOpen);
  assertFollowed(p, '第8章');
  assert.equal(navigation.scrollTop, beforeOpen);
  assert.deepEqual(branchStates(p), before);
});

test('初始方块状态下正文滚动即同步完整目录，无需启动隐藏动画队列', t => {
  const p = page(t, { openPanel: false, body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  const positions = [];
  for (const [y, title] of [[7134, '§8.1 基础'], [7234, '§8.1.1 细节'], [2134, '§3.1 基础']]) {
    p.movePage(y);
    p.advance(16);
    assert.equal(p.shadow().querySelector('.panel').inert, true);
    assert.equal(p.pendingFrames, 0);
    assertFollowed(p, title);
    positions.push(navigation.scrollTop);
  }
  assert.ok(positions[0] > 0);
  assert.ok(positions[1] > positions[0], '向下阅读时隐藏目录也向下同步');
  assert.ok(positions[2] < positions[1], '反向阅读时隐藏目录同步返回前面章节');
  assert.equal(p.articleScrollY, 2134);
  assert.equal(p.jumps.length, 0);
});

test('正文测量帧尚未执行就悬停时，滑入前已经定位且随后不再纵向追赶', t => {
  const p = page(t, { openPanel: false, body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7234);
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.pendingFrames, 1);
  hover(p, true);
  assert.equal(p.shadow().querySelector('.panel').inert, false);
  assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1.1 细节');
  assert.ok(navigation.scrollTop > 0, '开始横向滑入前落实最新章节的位置');
  const beforeReveal = navigation.scrollTop;
  navigation.scrollSamples.length = 0;
  assertFollowed(p, '§8.1.1 细节');
  assert.equal(navigation.scrollTop, beforeReveal);
  assert.ok(navigation.scrollSamples.every(sample => sample.top === beforeReveal), '滑入期间没有额外纵向位移');
  assert.equal(p.pendingFrames, 0);
  assert.equal(p.articleScrollY, 7234);
  assert.equal(p.jumps.length, 0);
});

test('手动暂停后重新悬停在滑入前恢复定位，不边滑入边播放跟随动画', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  await closePanel(p);
  assert.equal(navigation.scrollTop, 0, '收起动作保留手动暂停');
  hover(p, true);
  assert.ok(navigation.scrollTop > 0, '主动重新打开在滑入前恢复跟随');
  const beforeReveal = navigation.scrollTop;
  assertFollowed(p, '§8.1 基础');
  assert.equal(navigation.scrollTop, beforeReveal);
  assert.equal(p.shadow().querySelector('[aria-label="展开 第1章"]').getAttribute('aria-expanded'), 'false');
});

test('搜索期间收起和重新悬停均不抢占结果位置，清空后恢复同步', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  const input = p.shadow().querySelector('input');
  input.value = '章';
  input.dispatchEvent(new p.w.Event('input'));
  navigation.scrollTop = 64;
  await closePanel(p);
  await p.scroll(7134);
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  assert.equal(navigation.scrollTop, 64);
  hover(p, true);
  p.advance();
  assert.equal(navigation.scrollTop, 64);
  assert.equal(input.value, '章');
  input.value = '';
  input.dispatchEvent(new p.w.Event('input'));
  assertFollowed(p, '§8.1 基础');
});

test('手动暂停后收起仍保留位置，resize 和图片不解除，正文滚动才同步隐藏目录', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  p.shadow().querySelector('[aria-label="折叠 第1章"]').click();
  await closePanel(p);
  p.w.dispatchEvent(new p.w.Event('resize'));
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  const image = p.w.document.createElement('img');
  p.w.document.querySelector('.Body_markdown__test').append(image);
  await Promise.resolve();
  image.dispatchEvent(new p.w.Event('load'));
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  assert.equal(p.shadow().querySelector('.panel').inert, true);
  await p.scroll(7135);
  assert.ok(navigation.scrollTop > 0);
  assertFollowed(p, '§8.1 基础');
  assert.equal(p.shadow().querySelector('[aria-label="展开 第1章"]').getAttribute('aria-expanded'), 'false');
  assert.equal(p.articleScrollY, 7135);
  assert.equal(p.jumps.length, 0);
});

test('隐藏目录按当前小节的可见祖先同步，重新打开保留部分折叠和方块数量', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.shadow().querySelector('[aria-label="折叠 第2章"]').click();
  p.shadow().querySelector('[aria-label="折叠 第8章"]').click();
  const before = branchStates(p);
  await closePanel(p);
  await p.scroll(7234);
  assertFollowed(p, '第8章');
  const beforeReveal = navigation.scrollTop;
  hover(p, true);
  assertFollowed(p, '第8章');
  assert.equal(navigation.scrollTop, beforeReveal);
  assert.deepEqual(branchStates(p), before);
  assert.equal(p.shadow().querySelectorAll('.preview-marker').length, 12);
});

test('搜索期间不抢占结果滚动位置，清空后跟随正文当前章节', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  const input = p.shadow().querySelector('input');
  input.focus();
  input.value = '章';
  input.dispatchEvent(new p.w.Event('input'));
  navigation.scrollTop = 64;
  await p.scroll(7134);
  assert.equal(navigation.scrollTop, 64);
  assert.equal(input.value, '章');
  assert.equal(p.shadow().activeElement, input);
  input.value = '';
  input.dispatchEvent(new p.w.Event('input'));
  assertFollowed(p, '§8.1 基础');
});

test('手动滚动目录不会被拉回，正文再次滚动后即使章节未变也重新跟随', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  navigation.scrollTop = 0;
  navigation.dispatchEvent(new p.w.Event('scroll', { bubbles: true, composed: true }));
  await wait(35);
  assert.equal(navigation.scrollTop, 0);
  await p.scroll(7135);
  assertFollowed(p, '§8.1 基础');
});

test('正文停止滚动且动画结束后，目录不自行漂移', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  await p.scroll(7134);
  const before = navigation.scrollTop;
  p.advance();
  assert.equal(navigation.scrollTop, before);
  assertFollowed(p, '§8.1 基础');
});

test('目录通过多个动画帧渐进移动，不在第一帧直接跳到目标', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(16);
  assert.equal(navigation.scrollTop, 0, '定位帧只更新目标，不瞬移目录');
  p.advance(16);
  const firstStep = navigation.scrollTop;
  assert.ok(firstStep > 0);
  p.advance();
  assert.ok(firstStep < navigation.scrollTop / 2);
  assert.ok(new Set(navigation.scrollSamples.map(sample => sample.top)).size > 8);
  assertFollowed(p, '§8.1 基础');
  assert.equal(p.articleScrollY, 7134);
  assert.equal(p.jumps.length, 0);
});

test('同一小节内持续滚动正文时，目录也连续移动，不依赖标题切换', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  const positions = [];
  for (const y of [7234, 7244, 7254, 7264, 7274]) {
    await p.scroll(y);
    positions.push(navigation.scrollTop);
    assert.equal(p.shadow().querySelector('[aria-current]').textContent, '§8.1.1 细节');
  }
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] > positions[i - 1]);
  assert.ok(positions.at(-1) - positions[0] < 32, '按段落进度插值，而非跳过整行');
});

test('快速反向滚动时从当前位置改追新目标，不排队播放旧动画', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(96);
  assert.ok(navigation.scrollTop > 0);
  p.movePage(2134);
  p.advance(32);
  const start = navigation.scrollTop;
  navigation.scrollSamples.length = 0;
  p.advance();
  let previous = start;
  for (const sample of navigation.scrollSamples) {
    assert.ok(sample.top <= previous, '反向后持续向新目标移动');
    previous = sample.top;
  }
  assertFollowed(p, '§3.1 基础');
  assert.equal(p.pendingFrames, 0);
});

test('全部收起时，在章节末尾也平滑向下一个可见章节移动，且不展开分支', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.shadow().querySelector('.fold-all').click();
  const before = branchStates(p);
  await p.scroll(7484);
  const first = navigation.scrollTop;
  await p.scroll(7584);
  assert.ok(navigation.scrollTop > first);
  assertFollowed(p, '第8章');
  assert.deepEqual(branchStates(p), before);
});

test('面板收起时落实未完成的跟随目标，隐藏期间同步新章节且打开后位置不变', async t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(64);
  const partial = navigation.scrollTop;
  await closePanel(p);
  const closed = navigation.scrollTop;
  assert.ok(closed > partial, '收起后直接落实剩余目标');
  p.advance();
  assert.equal(navigation.scrollTop, closed);
  p.movePage(2134);
  p.advance(16);
  const synchronized = navigation.scrollTop;
  assert.ok(synchronized < closed);
  assert.equal(p.pendingFrames, 0);
  p.shadow().querySelector('.launcher').click();
  assert.equal(navigation.scrollTop, synchronized);
  assertFollowed(p, '§3.1 基础');
  assert.equal(navigation.scrollTop, synchronized);
});

test('开始搜索会取消进行中的动画，清空后重新平滑跟随', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(64);
  const input = p.shadow().querySelector('input');
  input.value = '章';
  input.dispatchEvent(new p.w.Event('input'));
  const stopped = navigation.scrollTop;
  p.advance();
  assert.equal(navigation.scrollTop, stopped);
  input.value = '';
  input.dispatchEvent(new p.w.Event('input'));
  navigation.scrollSamples.length = 0;
  assert.equal(navigation.scrollTop, stopped);
  assertFollowed(p, '§8.1 基础');
  assert.ok(navigation.scrollSamples.length > 5);
});

test('减少动态效果时保持即时定位，不启动跟随动画', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true, reduced: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(16);
  assert.ok(navigation.scrollTop > 0);
  assert.equal(p.pendingFrames, 0);
  assertFollowed(p, '§8.1 基础');
});

test('销毁实例会取消未完成的跟随动画', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(64);
  const stopped = navigation.scrollTop;
  p.w.__leetcodeDiscussToc__.destroy();
  p.advance();
  assert.equal(navigation.scrollTop, stopped);
  assert.equal(p.pendingFrames, 0);
  assert.equal(p.shadow(), undefined);
});

test('手动滚动目录会取消动画，正文再次滚动时恢复跟随', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  const navigation = outlineViewport(p);
  p.movePage(7134);
  p.advance(64);
  navigation.dispatchEvent(new p.w.WheelEvent('wheel', { deltaY: -100, bubbles: true, composed: true }));
  navigation.scrollTop = 0;
  p.advance();
  assert.equal(navigation.scrollTop, 0);
  p.movePage(7135);
  assertFollowed(p, '§8.1 基础');
});

test('连续外层滚动只更新一个跟随动画的目标，不创建重复动画队列', t => {
  const p = page(t, { body: longArticle(), controlledFrames: true });
  outlineViewport(p);
  for (let y = 3234; y <= 7334; y += 100) {
    p.movePage(y);
    p.advance(16);
    assert.ok(p.pendingFrames <= 2, '最多一个位置更新帧和一个动画帧');
  }
  p.advance();
  assert.equal(p.pendingFrames, 0);
  assertFollowed(p, '§8.2 进阶');
});
