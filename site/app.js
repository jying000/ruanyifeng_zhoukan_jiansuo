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

  // 中文分词：CJK 文本拆成「相邻 bigram」，英文/数字保持整词（长度 ≥2 才保留）。
  // 关键：不产出单字 token。否则单字「中」「国」会独立匹配，导致搜「中国」时，
  // 只要文档里同时出现「中东」「中文」这类词就被误判命中（单字假阳性）。
  // 只保留 ≥2 字符的 token 后，搜「中国」只能命中真正的「中国」bigram，
  // 搜「中」/「国」这类单字因长度不足（<2）本就不会触发搜索。
  function tokenize(text) {
    const tokens = [];
    const parts = String(text).split(/[\s\p{P}\p{S}]+/u).filter(Boolean);
    const cjk = /[㐀-䶿一-鿿豈-﫿]/u;
    for (const part of parts) {
      if (cjk.test(part)) {
        const chars = [...part];
        // 只生成相邻 bigram（长度 ≥2），不再生成单字 token。
        for (let i = 0; i < chars.length - 1; i++) {
          const bg = chars[i] + chars[i + 1];
          if (bg.trim()) tokens.push(bg);
        }
      } else if (part.length >= 2) {
        // 英文/数字词：长度 ≥2 才保留，避免单字母/单数字碎片。
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
      // 这里的 searchOptions 只是默认值，runSearch 每次会按用户选择的精度覆盖。
      searchOptions: {
        boost: { itemTitle: 3, section: 2, issueTitle: 1.5 },
        prefix: true,
        fuzzy: 0,
        combineWith: 'AND',
      },
    });
    mini.addAll(items);
  }

  // 搜索精度：返回传给 mini.search 的 fuzzy 选项。
  //  - exact : 完全精确，短词不做任何模糊（避免 libai 误中 liubai）。
  //  - fuzzy : 全部词按 0.2 比例模糊，容忍错字/换位。
  function fuzzyFor(level) {
    return level === 'fuzzy' ? 0.2 : 0;
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
    const active = document.querySelector('.precision-opt.is-active');
    const level = (active && active.dataset.level) || 'exact';
    const r = mini.search(query, {
      fuzzy: fuzzyFor(level),
      prefix: true,
      combineWith: 'AND',
      boost: { itemTitle: 3, section: 2, issueTitle: 1.5 },
    });
    // MiniSearch 的搜索结果默认已合并 storeFields，但保险起见按 id 回查原始条目。
    let matched = r.map((x) => {
      const item = allItems.find((it) => it.id === x.id) || x;
      // 记录该条目命中了哪些内容字段（用于去重判断）。
      item._contentFields = contentHitFields(x.match);
      return item;
    });
    if (activeSection) matched = matched.filter((i) => i.section === activeSection);
    // 同刊去重：若一期中存在命中具体内容字段（itemTitle/snippet/section）的条目，
    // 则丢弃那些仅命中 issueTitle 的「虚命中」条目，避免整刊因标题含关键词而刷屏。
    const items = dedupeByIssue(matched);
    // 按期刊倒序（最新期在前），同期内保持原相对顺序。
    items.sort((a, b) => b.issueNumber - a.issueNumber);
    renderStats(items.length);
    render(items, true);
  }

  // 从 MiniSearch 的 match 字段中提取命中了哪些「内容字段」。
  const CONTENT_FIELDS = ['itemTitle', 'snippet', 'section'];
  function contentHitFields(match) {
    const hit = {};
    if (match) {
      for (const term in match) {
        for (const f of match[term]) {
          if (CONTENT_FIELDS.includes(f)) hit[f] = true;
        }
      }
    }
    return Object.keys(hit);
  }

  // 同刊去重：保留实体命中条目，折叠纯标题命中条目。
  function dedupeByIssue(matched) {
    const byIssue = new Map();
    for (const it of matched) {
      if (!byIssue.has(it.issueNumber)) byIssue.set(it.issueNumber, []);
      byIssue.get(it.issueNumber).push(it);
    }
    const out = [];
    for (const group of byIssue.values()) {
      const real = group.filter((it) => it._contentFields.length > 0);
      if (real.length > 0) {
        // 有实体命中：只保留实体命中条目，丢弃纯标题命中条目。
        out.push(...real);
      } else {
        // 整期都只命中标题：保留一条「本期汇总」折叠卡片。
        const rep = group[0];
        rep._collapsedIssue = group;
        out.push(rep);
      }
    }
    return out;
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
    let seq = 0;
    items.forEach((it) => {
      if (it._collapsedIssue) {
        frag.appendChild(renderCollapsedCard(it, query));
      } else {
        seq += 1;
        frag.appendChild(renderCard(it, query, seq));
      }
    });
    $results.innerHTML = '';
    $results.appendChild(frag);
  }

  // 整期都只命中标题时，渲染一张「本期汇总」折叠卡，可展开查看该期全部命中条目。
  function renderCollapsedCard(it, query) {
    const card = document.createElement('article');
    card.className = 'card card-collapsed';

    const top = document.createElement('div');
    top.className = 'card-top';
    top.innerHTML =
      `<span class="badge">第 ${it.issueNumber} 期</span>` +
      `<a class="issue-title" href="${it.issueUrl}" target="_blank" rel="noopener">${highlight(it.issueTitle, query)}</a>` +
      `<span class="collapsed-count">${it._collapsedIssue.length} 条均仅命中标题 · 点击展开</span>`;
    card.appendChild(top);

    const list = document.createElement('div');
    list.className = 'collapsed-list';
    list.hidden = true;
    it._collapsedIssue.forEach((sub) => {
      const row = document.createElement('a');
      row.className = 'collapsed-row';
      row.href = sub.anchor ? sub.issueUrl + '#' + sub.anchor : sub.issueUrl;
      row.target = '_blank';
      row.rel = 'noopener';
      row.innerHTML =
        `<span class="collapsed-row-title">${highlight(sub.itemTitle, query)}</span>` +
        `<span class="collapsed-row-section">${escapeHtml(sub.section)}</span>`;
      list.appendChild(row);
    });
    card.appendChild(list);

    top.style.cursor = 'pointer';
    top.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return; // 点击原站链接不触发折叠
      list.hidden = !list.hidden;
      card.classList.toggle('is-open', !list.hidden);
    });
    return card;
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
  // 切换搜索精度：更新按钮高亮，并用当前输入立即按新策略重搜。
  const precisionOpts = document.querySelectorAll('.precision-opt');
  precisionOpts.forEach((btn) => {
    btn.addEventListener('click', () => {
      precisionOpts.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      });
      if ($search.value.trim().length >= 2) runSearch($search.value.trim());
    });
  });

  load();
})();
