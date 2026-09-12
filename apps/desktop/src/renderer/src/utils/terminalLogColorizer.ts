/**
 * 终端运行日志类型背景色渲染引擎 (类似 Grep Console)
 * 智能识别应用程序日志与构建日志：
 * 1. 应用程序输出（如 "2026-09-12 11:57:03 EmbeddedLeaderService.java INFO ..."、"[main] INFO ..."）
 * 2. Maven 构建日志（如 "[INFO] Scanning for projects..."）
 * 3. 退出状态码与异常堆栈（BUILD SUCCESS, BUILD FAILURE, Exception in thread...）
 * 注入带语义背景色与前景色 ANSI 样式，大幅提升日志可读性
 */
export function colorizeTerminalLogs(data: string): string {
  if (!data || typeof data !== 'string') return data;
  if (data.includes('\x1b[48;2;')) return data; // 避免重复注入背景色

  // 1. 匹配带时间戳或类名的应用程序日志行，例如：
  // "2026-09-12 11:57:03 EmbeddedLeaderService.java INFO Received confirmation..."
  // "2026-09-12 11:57:03.123 [main] INFO com.tsingtec.service - ..."
  // "2026-09-12T11:57:03.123+08:00 INFO ..."
  // "11:57:03.123 [main] WARN ..."
  const APP_TIMESTAMP_LOG_REGEX =
    /(^|[\r\n])((?:\x1b\[[0-9;]*m)*(?:\d{4}[-/.]\d{2}[-/.]\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:[+-]\d{2}:?\d{2}|Z)?|\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)(?:\x1b\[[0-9;]*m)*)([^\r\n]{0,120}?\s+)(?:\[)?\b(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE|SEVERE)\b(?:\])?([^\r\n]*)?/g;

  let result = data.replace(
    APP_TIMESTAMP_LOG_REGEX,
    (_match, lineBreak: string, timestamp: string, middle: string, level: string, rest: string = '') => {
      const cleanMiddle = middle.trim();
      const lead = cleanMiddle ? `${timestamp} ${cleanMiddle} ` : `${timestamp} `;
      const lvl = level.toUpperCase();

      if (lvl === 'INFO') {
        const badge = '\x1b[48;2;18;52;98m\x1b[38;2;147;197;253m\x1b[1m INFO \x1b[0m';
        return `${lineBreak}${lead}${badge}${rest}`;
      }
      if (lvl === 'WARN' || lvl === 'WARNING') {
        const badge = '\x1b[48;2;120;65;0m\x1b[38;2;253;224;71m\x1b[1m WARN \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;253;230;138m${rest}\x1b[0m` : '';
        return `${lineBreak}${lead}${badge}${coloredRest}`;
      }
      if (lvl === 'ERROR' || lvl === 'FATAL' || lvl === 'SEVERE') {
        const badge = '\x1b[48;2;153;27;27m\x1b[38;2;255;255;255m\x1b[1m ERROR \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;252;165;165m${rest}\x1b[0m` : '';
        return `${lineBreak}${lead}${badge}${coloredRest}`;
      }
      if (lvl === 'DEBUG') {
        const badge = '\x1b[48;2;65;35;95m\x1b[38;2;216;180;254m\x1b[1m DEBUG \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;216;180;254m${rest}\x1b[0m` : '';
        return `${lineBreak}${lead}${badge}${coloredRest}`;
      }
      if (lvl === 'TRACE') {
        const badge = '\x1b[48;2;45;45;55m\x1b[38;2;161;161;170m\x1b[1m TRACE \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;161;161;170m${rest}\x1b[0m` : '';
        return `${lineBreak}${lead}${badge}${coloredRest}`;
      }
      return _match;
    },
  );

  // 2. 匹配以 [thread/logger] 开头但没有时间戳的日志行，如 "[main] INFO ..."
  const THREAD_LOG_REGEX =
    /(^|[\r\n])((?:\x1b\[[0-9;]*m)*\[[A-Za-z0-9_$. -]{2,60}\]\s+)(?:\[)?\b(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE|SEVERE)\b(?:\])?([^\r\n]*)?/g;

  result = result.replace(
    THREAD_LOG_REGEX,
    (_match, lineBreak: string, threadPrefix: string, level: string, rest: string = '') => {
      const lvl = level.toUpperCase();
      if (lvl === 'INFO') {
        const badge = '\x1b[48;2;18;52;98m\x1b[38;2;147;197;253m\x1b[1m INFO \x1b[0m';
        return `${lineBreak}${threadPrefix}${badge}${rest}`;
      }
      if (lvl === 'WARN' || lvl === 'WARNING') {
        const badge = '\x1b[48;2;120;65;0m\x1b[38;2;253;224;71m\x1b[1m WARN \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;253;230;138m${rest}\x1b[0m` : '';
        return `${lineBreak}${threadPrefix}${badge}${coloredRest}`;
      }
      if (lvl === 'ERROR' || lvl === 'FATAL' || lvl === 'SEVERE') {
        const badge = '\x1b[48;2;153;27;27m\x1b[38;2;255;255;255m\x1b[1m ERROR \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;252;165;165m${rest}\x1b[0m` : '';
        return `${lineBreak}${threadPrefix}${badge}${coloredRest}`;
      }
      if (lvl === 'DEBUG') {
        const badge = '\x1b[48;2;65;35;95m\x1b[38;2;216;180;254m\x1b[1m DEBUG \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;216;180;254m${rest}\x1b[0m` : '';
        return `${lineBreak}${threadPrefix}${badge}${coloredRest}`;
      }
      if (lvl === 'TRACE') {
        const badge = '\x1b[48;2;45;45;55m\x1b[38;2;161;161;170m\x1b[1m TRACE \x1b[0m';
        const coloredRest = rest ? `\x1b[38;2;161;161;170m${rest}\x1b[0m` : '';
        return `${lineBreak}${threadPrefix}${badge}${coloredRest}`;
      }
      return _match;
    },
  );

  return result
    // 3. [INFO] 蓝底白字/浅蓝
    .replace(/(?:^|(?<=[\r\n]))(?:\x1b\[[0-9;]*m)?\[INFO\](?:\x1b\[[0-9;]*m)?/g, '\x1b[48;2;18;52;98m\x1b[38;2;147;197;253m\x1b[1m INFO \x1b[0m')
    // 4. [WARNING] / [WARN] 琥珀黄底黑字/深黄
    .replace(/(?:^|(?<=[\r\n]))(?:\x1b\[[0-9;]*m)?\[WARNING\](?:\x1b\[[0-9;]*m)?/g, '\x1b[48;2;120;65;0m\x1b[38;2;253;224;71m\x1b[1m WARN \x1b[0m')
    .replace(/(?:^|(?<=[\r\n]))(?:\x1b\[[0-9;]*m)?\[WARN\](?:\x1b\[[0-9;]*m)?/g, '\x1b[48;2;120;65;0m\x1b[38;2;253;224;71m\x1b[1m WARN \x1b[0m')
    // 5. [ERROR] 红底白字
    .replace(/(?:^|(?<=[\r\n]))(?:\x1b\[[0-9;]*m)?\[ERROR\](?:\x1b\[[0-9;]*m)?/g, '\x1b[48;2;153;27;27m\x1b[38;2;255;255;255m\x1b[1m ERROR \x1b[0m')
    // 6. [DEBUG] 紫底浅紫字
    .replace(/(?:^|(?<=[\r\n]))(?:\x1b\[[0-9;]*m)?\[DEBUG\](?:\x1b\[[0-9;]*m)?/g, '\x1b[48;2;65;35;95m\x1b[38;2;216;180;254m\x1b[1m DEBUG \x1b[0m')
    // 7. BUILD SUCCESS / BUILD FAILURE 横幅背景
    .replace(/(?:^|(?<=[\r\n]))BUILD SUCCESS\b/g, '\x1b[48;2;22;101;52m\x1b[38;2;240;253;244m\x1b[1m  BUILD SUCCESS  \x1b[0m')
    .replace(/(?:^|(?<=[\r\n]))BUILD FAILURE\b/g, '\x1b[48;2;153;27;27m\x1b[38;2;255;255;255m\x1b[1m  BUILD FAILURE  \x1b[0m')
    // 8. 执行完成退出码背景徽章
    .replace(/\[Process finished with exit code 0\]/g, '\x1b[48;2;22;101;52m\x1b[38;2;240;253;244m\x1b[1m [Process finished with exit code 0] \x1b[0m')
    .replace(/\[Process finished with exit code ([1-9]\d*)\]/g, '\x1b[48;2;153;27;27m\x1b[38;2;254;242;242m\x1b[1m [Process finished with exit code $1] \x1b[0m')
    // 9. Java 异常突出显示
    .replace(/(?:^|(?<=[\r\n]))(Exception in thread [^\r\n]+)/g, '\x1b[48;2;120;25;25m\x1b[38;2;255;255;255m\x1b[1m EXCEPTION \x1b[0m\x1b[38;2;252;165;165m $1\x1b[0m')
    .replace(/(?:^|(?<=[\r\n]))(Caused by: [^\r\n]+)/g, '\x1b[48;2;90;20;20m\x1b[38;2;255;255;255m\x1b[1m CAUSED BY \x1b[0m\x1b[38;2;252;165;165m $1\x1b[0m');
}
