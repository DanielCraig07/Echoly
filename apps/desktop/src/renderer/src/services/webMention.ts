/**
 * `@Web` 提及的纯文本逻辑。
 *
 * 单独拆出来的理由很实际：`specialMentions.ts` 在模块顶层 import 了 monaco
 * （它要读 Monaco markers 来做 `@Problems`），而 monaco 是打包器解析的 ESM 包，
 * 在 node 测试环境里 import 不进来。把这几个纯函数放在这里，
 * 它们就能脱离 monaco 被直接测 —— 而这几条判断恰恰是 `@Web` 里唯一会出错的部分。
 */

/**
 * 特殊提及正文之外的所有 `@Xxx` 标记。
 *
 * 只摘掉这几个**已知的特殊提及**，不碰其它含 `@` 的文本（比如 `@types/node`、
 * 邮箱地址、装饰器）—— 那些是用户真正的检索词的一部分。
 */
const MENTION_TOKENS = [/@Git\b/gi, /@Terminal\b/gi, /@Problems\b/gi, /@Web\b/gi, /@Docs\b/gi];

/** 单次检索词的字符上限。太长会被搜索引擎截断，也没法当查询串用。 */
const MAX_WEB_QUERY_CHARS = 200;

export function extractWebQuery(prompt: string): string {
  let text = prompt;
  for (const token of MENTION_TOKENS) text = text.replace(token, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_WEB_QUERY_CHARS);
}

/**
 * 联网意图的正文。
 *
 * 这里**不预抓搜索结果**：`web_search` 已经是一颗有 SSRF 防护、逐跳校验重定向、
 * 边读边卡字节上限的成熟工具（见 `tools/web.ts` 与 `main/webService.ts`），
 * 在渲染层另开一条取数路径等于把那套防护再做一遍，而漏掉任何一条都很难发现。
 * 所以这里只负责把意图讲清楚，并**在联网关闭时明确告知** ——
 * 否则模型会去调一个不可用的工具，用户看到的是一句含糊的失败。
 */
export function buildWebMentionContent(query: string, webEnabled: boolean): string {
  const asked = query || '（没有写明检索词，请根据对话上下文判断该查什么）';
  if (!webEnabled) {
    return `--- 联网检索请求 ---\n用户希望联网检索：${asked}\n但当前联网已关闭（设置页的联网开关，或隐私模式）。web_search / fetch_url 不可用，请不要调用它们，直接说明无法联网，并只用已有知识回答。`;
  }
  return `--- 联网检索请求 ---\n用户希望联网检索：${asked}\n请用 web_search 工具检索，需要读全文时再用 fetch_url；回答中给出你实际参考的链接。`;
}

/**
 * `@Docs`：把「有哪些文档源可用」讲清楚，让 Agent 直接去 `search_docs`。
 *
 * 与 `@Web` 同样是「传达意图」而不是「预抓内容」：文档源的清单与缓存都在主进程，
 * 渲染层再取一遍只会多一份可能过期的副本。真正要避免的失败是
 * 「用户 @Docs 了，但 Agent 不知道有文档源可用，于是去 web_search 乱搜」。
 */
export function buildDocsMentionContent(sources: readonly { name: string; url: string }[]): string {
  if (sources.length === 0) {
    return `--- 文档源检索请求 ---\n用户希望查文档，但**尚未配置任何文档源**。请告知用户去「设置 → 文档源」添加站点地址（例如 https://docs.example.com），也可以先用 web_search 临时查。`;
  }
  const list = sources.map((source) => `- ${source.name}：${source.url}`).join('\n');
  return `--- 文档源检索请求 ---\n用户希望查文档。已配置的文档源：\n${list}\n请用 search_docs 检索，拿到链接后用 read_doc 读全文（read_doc 只能读上面这些站点的同源地址）。`;
}
