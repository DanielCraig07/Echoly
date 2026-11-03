/**
 * Claude Code 扩展的标识。
 *
 * 有三个地方要「认出它」，共用这一份，别各写各的：
 * - 详情页：它是平台专属构建，安装要走注册表里本机那一份（见 decidePlatformDownload）；
 * - 右侧面板的「Claude」标签：渲染的就是这个扩展贡献的侧栏视图；
 * - 主进程的专用安装通道（那边有自己的常量，跨进程没法共用）。
 *
 * 以前 id 这个串在详情页里单独声明过一次，视图 id 又在面板组件里当默认参数写了一遍 ——
 * 这就是「改一处漏一处」的标准形态。
 */

/** 扩展 id（注册表里的 `publisher.name`）。 */
export const CLAUDE_CODE_ID = 'Anthropic.claude-code';

/**
 * 该扩展贡献的侧栏 webview 视图 id。
 *
 * 取自它 package.json 的 `contributes.views.claude-sidebar[0].id`，
 * 也是 `extension:webview-registered` 事件里会出现的那个 viewId。
 */
export const CLAUDE_CODE_VIEW_ID = 'claudeVSCodeSidebar';
