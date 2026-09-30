import React, { useCallback, useRef, useState } from 'react';
import {
  DbConfirmModal,
  type DbConfirmDetail,
  type DbConfirmInput,
} from '../components/DbConfirmModal';
import type { DbConfirmTone } from '../services/dbConfirmContent';

export interface DbConfirmRequest {
  title: string;
  /** Markdown 正文（`buildSqlConfirmMarkdown` 拼装） */
  content: string;
  /** 待删除对象的身份信息（名字 / 路径），渲染成正文下方的键值行 */
  details?: DbConfirmDetail[];
  tone?: DbConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 给出名称时要求用户原样输入才能确认 */
  requireTyping?: string;
  /** 顺带收集一个字符串（新建库名、重命名…） */
  input?: DbConfirmInput;
}

export interface DbConfirmHandle {
  /** 弹出确认框；确认时 resolve 输入框里的值（没有输入框则为空串），取消时 resolve null */
  confirm: (request: DbConfirmRequest) => Promise<string | null>;
  /** 挂在面板 JSX 里的节点 */
  modal: React.ReactNode;
  /**
   * 当前是否有确认框挂着。
   *
   * 外层 iframe / 弹窗常自带「Esc 关闭」的全局监听；不知道这一位的存在，
   * 用户在确认框上按 Esc 会**连整个弹窗一起关掉**，等于把「取消」当成了「放弃当前操作」。
   */
  isOpen: boolean;
}

/**
 * 把确认弹窗包成 `await confirm({...})` 的形式。
 *
 * 数据库面板里的这些确认都发生在**异步事件处理函数**里（`handleDropTable` 之类的
 * 流程中间），而不是渲染期。如果只给一个受控组件，每个调用点都得自己拆成
 * 「先 setState 挂起、再在回调里接着跑后半段」，八处调用点就是八份状态机。
 * 这里用一个 Promise + resolver 把弹窗的返回值接回原来的调用栈，
 * 调用点保持 `if (!(await confirm(...))) return;` 的直线写法。
 *
 * `modal` 节点需要挂在对应组件的 JSX 里。**每个使用它的组件必须有自己的一个实例** ——
 * 它是组件局部的 hook 状态，两处共用一个实例会让后一处把前一处的弹窗顶掉。
 */
export function useDbConfirm(): DbConfirmHandle {
  const [request, setRequest] = useState<DbConfirmRequest | null>(null);
  const resolverRef = useRef<((value: string | null) => void) | null>(null);

  const confirm = useCallback((next: DbConfirmRequest): Promise<string | null> => {
    // 上一次的确认框还挂着（理论上不该发生）：先按「取消」结掉，
    // 否则那个 await 会永远悬在那里，调用方的后续逻辑再也不会走
    resolverRef.current?.(null);
    setRequest(next);
    return new Promise<string | null>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(value);
  }, []);

  const modal = request ? (
    <DbConfirmModal
      isOpen
      title={request.title}
      content={request.content}
      details={request.details}
      tone={request.tone}
      confirmLabel={request.confirmLabel}
      cancelLabel={request.cancelLabel}
      requireTyping={request.requireTyping}
      input={request.input}
      onConfirm={(value) => settle(value)}
      onCancel={() => settle(null)}
    />
  ) : null;

  return { confirm, modal, isOpen: request !== null };
}
