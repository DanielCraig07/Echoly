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
const MENTION_TOKENS = [/@Git\b/gi, /@Terminal\b/gi, /@Problems\b/gi, /@Web\b/gi];

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
