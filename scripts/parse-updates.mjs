/**
 * parse-updates.mjs
 *
 * 解析 DeepSeek API 更新日志页面 (https://api-docs.deepseek.com/zh-cn/updates) 的 HTML，
 * 提取所有更新条目。页面是一个静态 Docusaurus 站点，更新条目以 <h2> 块组织：
 *
 *   <h2 ... id="时间-2026-07-31">时间: 2026-07-31<a ...>#</a></h2>
 *   <h3 ... id="deepseek-v4-flash-更新">DeepSeek-V4-Flash 更新<a ...>#</a></h3>
 *   <p>...正文...</p>
 *
 * 解析要点（已实测验证）：
 *   1. 按 <h2 切分 HTML 后，第一个块（index 0）是 <head> + 导航栏，
 *      其中也包含日期字符串（Docusaurus 内嵌页面数据的 script JSON），必须跳过。
 *   2. 每条记录的日期正则 /时间[:：]\s*(\d{4}-\d{2}-\d{2})/ 同时过滤掉
 *      TOC 等不含"时间"字样的其他 <h2> 块。
 *   3. 不使用任何 HTML 解析库（cheerio/jsdom 等），纯正则实现。
 *
 * @param {string} html 页面原始 HTML（UTF-8）
 * @returns {{date: string, title: string, body: string}[]} 更新条目数组
 */

export function parseUpdates(html) {
  const blocks = html.split('<h2');
  const entries = [];

  // blocks[0] 是 document head + 导航（含内嵌日期，属于页面数据而非真实条目），
  // 因此一律从下标 1 开始遍历，跳过它。
  for (const block of blocks.slice(1)) {
    // 提取条目的日期，匹配不上的块（如 TOC 里的其他 <h2>）直接过滤掉
    const date = block.match(/时间[:：]\s*(\d{4}-\d{2}-\d{2})/);
    if (!date) continue;

    // 提取标题 <h3>...</h3>，去掉标签得到纯文本；没有 <h3> 时兜底为占位标题
    const titleTag = block.match(/<h3[^>]*>(.*?)<\/h3>/s);
    const title = titleTag
      ? titleTag[1].replace(/<[^>]+>/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
      : '(无标题)';

    // 正文 = <h3> 结束之后的所有内容，去掉所有 HTML 标签与实体、压缩空白
    const body = block
      .slice(titleTag ? titleTag.index + titleTag[0].length : 0)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    entries.push({ date: date[1], title, body });
  }

  return entries;
}
