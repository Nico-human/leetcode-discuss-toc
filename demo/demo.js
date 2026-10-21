'use strict';

const chapters = ['常用枚举技巧', '前缀和', '差分', '栈', '队列', '堆（优先队列）', '字典树', '并查集', '树状数组与线段树'];
const numerals = ['零', '一', '二', '三', '四', '五', '六', '七', '八'];
const article = document.getElementById('article');
let alternate = false;

function renderArticle() {
  article.replaceChildren();
  for (const [i, chapter] of (alternate ? ['链表', '二叉树', '回溯'] : chapters).entries()) {
    const heading = document.createElement('h2');
    heading.textContent = `${numerals[i]}、${chapter}`;
    heading.id = `chapter-${i}`;
    article.append(heading);
    const lead = document.createElement('p');
    lead.className = 'lead';
    lead.textContent = '从基础概念出发，通过练习掌握常见技巧。使用右侧目录快速定位感兴趣的章节。';
    article.append(lead);
    for (const [j, section] of ['基础', '进阶', '综合应用'].entries()) {
      const sub = document.createElement('h3');
      sub.textContent = `§${i}.${j + 1} ${section}`;
      sub.id = `section-${i}-${j}`;
      article.append(sub);
      if (j === 1) {
        const detail = document.createElement('h4');
        detail.textContent = `§${i}.${j + 1}.1 典型例题`;
        article.append(detail);
      }
      const list = document.createElement('ul');
      list.className = 'problem-list';
      for (let k = 1; k <= 4; k++) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.textContent = `${(i + 1) * 100 + j * 10 + k}. ${chapter}练习 ${k}`;
        link.href = `https://leetcode.cn/problemset/`;
        const tag = document.createElement('span');
        tag.className = 'tag'; tag.textContent = k < 3 ? '基础练习' : '思维拓展';
        item.append(link, tag); list.append(item);
      }
      article.append(list);
      if (j === 0) {
        const pre = document.createElement('pre');
        pre.textContent = 'def solve(nums):\n    result = 0\n    for value in nums:\n        result += value\n    return result';
        article.append(pre);
      }
    }
  }
}

document.getElementById('demo-follow').addEventListener('click', () => {
  const heading = [...article.querySelectorAll('h2')].at(-1);
  heading?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.getElementById('switch-article').addEventListener('click', () => {
  alternate = !alternate;
  history.pushState({}, '', `/discuss/post/${alternate ? '1002' : '1001'}/demo/`);
  document.querySelector('h1').textContent = alternate ? '链表、二叉树与回溯 · 学习题单' : '常用数据结构 · 学习题单';
  article.replaceChildren(document.createTextNode('正在加载文章…'));
  setTimeout(renderArticle, 250);
});
document.getElementById('add-heading').addEventListener('click', () => {
  const heading = document.createElement('h2');
  heading.textContent = '追加章节 · 动态加载';
  article.append(heading);
});
document.getElementById('toggle-theme').addEventListener('click', () => {
  document.documentElement.className = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
});
renderArticle();
