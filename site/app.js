/* 阮一峰周刊检索 - 前端逻辑 */
(function () {
  'use strict';

  const SEARCH_FIELDS = ['itemTitle', 'snippet', 'section', 'issueTitle'];
  const $search = document.getElementById('search');
  const $results = document.getElementById('results');
  const $stats = document.getElementById('stats');

  let mini = null;
  let allItems = [];
  let activeSection = null;
  const sections = new Map(); // section -> count

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------
  async function load() {
    try {
      const res = await fetch('./index.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);

      // 真实下载进度：用 streaming reader 统计已接收字节 / Content-Length。
      const total = Number(res.headers.get('Content-Length')) || 0;
      let received = 0;
      const reader = res.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const pct = total ? Math.floor((received / total) * 100) : 0;
        showProgress(pct, total ? formatBytes(received) + ' / ' + formatBytes(total) : formatBytes(received));
      }
      const blob = new Uint8Array(received);
      let pos = 0;
      for (const c of chunks) { blob.set(c, pos); pos += c.length; }
      const text = new TextDecoder('utf-8').decode(blob);

      showProgress(100, formatBytes(received), '正在建立索引…');
      // 让「正在建立索引」先渲染一帧，避免被下面的同步建索引阻塞。
      await new Promise((r) => setTimeout(r, 0));

      const data = JSON.parse(text);
      allItems = data.items || [];
      buildIndex(allItems);
      renderStats();
      console.log('[debug] loaded items:', allItems.length, 'sample id:', allItems[0] && allItems[0].id);
      render([], false); // 首屏不显示默认内容，等待用户输入
    } catch (err) {
      $stats.textContent = '索引加载失败：' + err.message;
      $results.innerHTML = '<div class="empty">无法加载 index.json，请先运行构建脚本生成索引。</div>';
    }
  }

  function formatBytes(n) {
    if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  // 渲染进度条 + 文案到 #stats 区域。
  function showProgress(pct, detail, note) {
    const label = note || '正在下载索引…';
    $stats.innerHTML =
      '<div class="progress">' +
        '<div class="progress-bar" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<div class="progress-text">' + label + ' ' + pct + '%' +
        (detail ? ' <span class="progress-detail">(' + detail + ')</span>' : '') +
      '</div>';
  }

  // 中文分词：CJK 文本拆成「单字 + 相邻 bigram」，英文/数字保持整词。
  // 这样查询「围棋」会拆成 围/棋 两个 token（AND），可命中「学习下围棋」。
  function tokenize(text) {
    const tokens = [];
    const parts = String(text).split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
    const cjk = /[㐀-䶿一-鿿豈-﫿]/u;
    for (const part of parts) {
      if (cjk.test(part)) {
        const chars = [...part];
        for (const c of chars) if (c.trim()) tokens.push(c);
        for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1]);
      } else {
        tokens.push(part);
      }
    }
    return tokens;
  }

  function buildIndex(items) {
    mini = new MiniSearch({
      fields: SEARCH_FIELDS,
      storeFields: ['issueNumber', 'issueTitle', 'issueUrl', 'date', 'section', 'anchor', 'itemTitle', 'itemUrl', 'snippet'],
      tokenize,
      searchOptions: {
        boost: { itemTitle: 3, section: 2, issueTitle: 1.5 },
        prefix: true,
        fuzzy: 0.2,
        combineWith: 'AND',
      },
    });
    mini.addAll(items);
  }

  function buildChips() {
    // chips 已移除：栏目筛选标签不再显示。
  }

  function renderStats(count) {
    const txt = `已索引 ${allItems.length} 条 · 覆盖 ${new Set(allItems.map((i) => i.issueNumber)).size} 期（2023.01 起）`;
    $stats.textContent = count == null ? txt : `匹配 ${count} 条 · ${txt}`;
  }

  // -------------------------------------------------------------------------
  // 搜索
  // -------------------------------------------------------------------------
  function runSearch(query) {
    // 输入少于 2 个字符时不筛选、不显示结果。
    if (query.length < 2) {
      render([]);
      renderStats();
      return;
    }
    const r = mini.search(query);
    // MiniSearch 的搜索结果默认已合并 storeFields，但保险起见按 id 回查原始条目。
    let items = r.map((x) => allItems.find((it) => it.id === x.id) || x);
    if (activeSection) items = items.filter((i) => i.section === activeSection);
    // 按期刊倒序（最新期在前），同期内保持原相对顺序。
    items.sort((a, b) => b.issueNumber - a.issueNumber);
    renderStats(items.length);
    render(items, true);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function highlight(text, query) {
    const safe = escapeHtml(text);
    if (!query) return safe;
    const terms = query.split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!terms.length) return safe;
    const re = new RegExp('(' + terms.join('|') + ')', 'gi');
    return safe.replace(re, '<mark>$1</mark>');
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  function render(items, searched) {
    if (!items.length) {
      $results.innerHTML = '<div class="empty">' +
        (searched ? '没有找到相关条目，换个关键词试试。' : '请至少输入 2 个字符开始查询。') +
        '</div>';
      return;
    }
    const query = $search.value.trim();
    const frag = document.createDocumentFragment();
    items.forEach((it, idx) => {
      frag.appendChild(renderCard(it, query, idx + 1));
    });
    $results.innerHTML = '';
    $results.appendChild(frag);
  }

  function renderCard(it, query, seq) {
    const card = document.createElement('article');
    card.className = 'card';

    const deepLink = it.anchor ? it.issueUrl + '#' + it.anchor : it.issueUrl;

    const top = document.createElement('div');
    top.className = 'card-top';
    top.innerHTML =
      `<span class="seq">${seq}</span>` +
      `<span class="badge">第 ${it.issueNumber} 期</span>` +
      `<a class="issue-title" href="${it.issueUrl}" target="_blank" rel="noopener">${highlight(it.issueTitle, query)}</a>` +
      `<span class="section-tag">${escapeHtml(it.section)}</span>`;
    card.appendChild(top);

    const titleLink = document.createElement('a');
    titleLink.className = 'item-title';
    titleLink.href = deepLink;
    titleLink.target = '_blank';
    titleLink.rel = 'noopener';
    titleLink.innerHTML = highlight(it.itemTitle, query);
    card.appendChild(titleLink);

    if (it.snippet) {
      const p = document.createElement('p');
      p.className = 'snippet';
      p.innerHTML = highlight(it.snippet, query);
      card.appendChild(p);
    }

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const left = document.createElement('span');
    left.className = 'card-date';
    left.textContent = it.date || '';
    foot.appendChild(left);
    if (it.itemUrl) {
      const res = document.createElement('a');
      res.className = 'open-resource';
      res.href = it.itemUrl;
      res.target = '_blank';
      res.rel = 'noopener';
      res.textContent = '打开资源原链接 ↗';
      foot.appendChild(res);
    }
    card.appendChild(foot);
    return card;
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------
  let timer = null;
  let composing = false; // 是否处于输入法组合（选词）阶段

  function scheduleSearch() {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch($search.value.trim()), 120);
  }

  $search.addEventListener('compositionstart', () => {
    composing = true;
  });
  $search.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch(); // 中文上屏后再筛选一次
  });
  $search.addEventListener('input', () => {
    if (composing) return; // 输入法选词阶段不触发搜索
    scheduleSearch();
  });

  load();
})();
