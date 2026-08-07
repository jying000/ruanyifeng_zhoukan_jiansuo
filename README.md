# 阮一峰周刊检索

搜索《科技爱好者周刊》（[ruanyf/weekly](https://github.com/ruanyf/weekly)）里提到的工具、文章、资源……输入关键字即可定位到 [ruanyifeng.com](https://www.ruanyifeng.com/blog/weekly/) 对应期数的内容。

- 索引粒度：**每条资源条目**（如「工具」「文章」「资源」中的每一个条目）。
- 覆盖范围：**2023 年起至上一期**的周刊，最新一期请去周刊原文阅读。
- **不索引**：`封面图` 栏目，以及 `言论` 及其之后的内容（`文档信息` / `相关文章` / `留言`）。
- 结果点击后跳转到 ruanyifeng.com 对应期数页面。

> 说明：ruanyifeng.com 的文章标题不带锚点（`<h2>` 无 `id`），因此深链定位到该期页面顶部；结果卡片会明确展示「栏目」与条目文本，方便快速定位。所有内容版权归原作者所有。

## 本地运行


```bash
npm install
```


### 本检索每周定时更新周刊索引，请大家直接拉取本开源index.json后无需手动再执行以下命令，避免对阮老师周刊造成流量冲击。

~~node scripts/build.mjs          # 增量构建（仅新增、且发布日期 <= 上一个周五的期号）~~

~~node scripts/build.mjs --full   # 全量重建（清空后从 2023 起重新索引，不受上一个周五约束）~~

构建产物为 `site/index.json`（同时作为浏览器检索数据与增量状态）。本地预览：

```bash
cd site && python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```
## 技术要点

- 期号→URL 映射来自 ruanyifeng.com 周刊归档页（权威、含发布日期），避免猜测日期导致 404。
- 内容解析使用 GitHub raw Markdown（`raw.githubusercontent.com`，免鉴权、不限速）。
- 中文检索：自定义 tokenizer 将 CJK 文本拆为「单字 + bigram」，英文/数字保持整词，配合 MiniSearch 的 `prefix` / `fuzzy` 实现友好的中英文混合搜索。
