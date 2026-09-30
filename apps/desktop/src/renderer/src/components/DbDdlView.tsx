import Editor from '@monaco-editor/react';

export interface DbDdlViewProps {
  /** DDL 文本 */
  ddl: string;
  theme?: string;
}

/**
 * 表结构的 **DDL 原文**只读视图。
 *
 * 刻意**不复用**主编辑区的 Monaco 实例：主编辑区那个 `<Editor>` 会在标签切换时
 * `setModel` 复用同一个实例，而 `@monaco-editor/react` 在 `readOnly` 下更新 value 走的是
 * `setValue`（不是 executeEdits），`setValue` 会真实触发 `onDidChangeModelContent`，
 * 于是内容会经 onChange 回流到「上一次渲染时的 active 标签」——正是「查看表结构却改动了
 * 已打开代码文件」的根因。这里用独立组件 + 独立 JSX 位置渲染，切换标签时主编辑器整体卸载，
 * 从结构上杜绝两个编辑区共享实例；同时本组件不接收 onChange，DDL 永远只读。
 *
 * 本组件**没有自己的工具栏**：表名、DDL / 列清单切换、复制、刷新、应用都由外层
 * `DbStructureView` 统一提供 —— 否则标签里会套出两层工具栏，两排按钮各管一半的事。
 */
export function DbDdlView({ ddl, theme = 'vs-dark' }: DbDdlViewProps) {
  return (
    /*
     * 容器必须是**有确定高度**的 flex 项。
     *
     * Monaco 用 `automaticLayout` 时是按容器的 clientHeight 建布局的，而
     * `flex: 1` 在父级不是 flex 容器的情况下等于没写（`.editor-fill` 正是如此），
     * 高度会退化成内容高度；Monaco 内部是绝对定位，量出来就是接近 0 —— 屏幕上
     * 只剩几条被裁掉一半的行。所以这里显式 `height: '100%'`，
     * 并把 `minHeight: 0` 留着，防止外层的 flex 布局把这一项按内容撑开。
     */
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <Editor
          value={ddl}
          language="sql"
          theme={theme === 'light' ? 'vs' : 'vs-dark'}
          options={{
            readOnly: true,
            fontSize: 12.5,
            lineNumbers: 'on',
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            renderLineHighlight: 'line',
            occurrencesHighlight: 'off',
            selectionHighlight: false,
            scrollbar: { vertical: 'visible', horizontal: 'auto' },
          }}
        />
      </div>
    </div>
  );
}
