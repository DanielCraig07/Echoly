/**
 * 扩展列表的展示层换算。
 *
 * 抽成独立模块只为一件事：这些换算**错了不会报错**，只会显示成另一个数字或另一串字符
 * （下载量少一个数量级、`Anthropic.claude-code` 原样糊在标题上），
 * 没有断言就只能靠人眼。放在这里是为了能断言。
 */

/**
 * 下载量的紧凑写法：`34M` / `7.2M` / `410K`。
 *
 * 位数越少保留的小数越少：`7.2M` 有信息量，`34.0M` 的 `.0` 纯属噪音。
 * 未提供时返回空串 —— 让调用方决定「整个统计区不显示」，而不是显示一个 `0`。
 */
export function formatDownloadCount(count: number | undefined): string {
  if (count === undefined || !Number.isFinite(count) || count < 0) return '';
  if (count >= 1_000_000) {
    const millions = count / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
  }
  return String(Math.round(count));
}

/** 评分显示：`4.5` 保留一位，整数不带 `.0`；没有评分返回空串。 */
export function formatRating(rating: number | undefined): string {
  if (rating === undefined || !Number.isFinite(rating) || rating <= 0) return '';
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

/** 从 `publisher.name` 里取发布者。没有分隔点时整体当作发布者，不猜。 */
export function publisherOf(extensionId: string): string {
  const dot = extensionId.indexOf('.');
  return dot > 0 ? extensionId.slice(0, dot) : extensionId;
}

/**
 * 把扩展 id 变成能读的标题。
 *
 * 已安装列表拿到的是**只有 id 的字符串**（`Anthropic.claude-code`），
 * 直接铺在标题位置会变成一屏幕机器名。这里取 `.` 之后那一段，把 `-`/`_` 换成空格、
 * 每个词首字母大写 —— `claude-code` → `Claude Code`。
 *
 * 刻意不做「已知扩展的别名表」：那种表会随着扩展更新而腐烂，
 * 而按 id 推导出来的结果永远和注册表本身一致。
 */
export function friendlyExtensionName(extensionId: string): string {
  const dot = extensionId.indexOf('.');
  const raw = dot >= 0 ? extensionId.slice(dot + 1) : extensionId;
  const words = raw.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return extensionId;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * 图标缺失时的首字母。
 *
 * 用标题首字符而不是 id 首字符：`Anthropic.claude-code` 的 `A` 对用户没有意义，
 * `Claude Code` 的 `C` 才有。非字母（中日韩文字、数字）原样返回。
 */
export function iconInitial(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '?';
  return trimmed.charAt(0).toUpperCase();
}
