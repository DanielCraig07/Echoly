/**
 * 统一日志模块（主进程）
 *
 * 使用 electron-log，按天轮转写入 userData/logs/main.log。
 * 在主进程顶部调用 `initLogging()` 一次，之后各处 import { log } 使用。
 */
import { app, crashReporter } from 'electron';
import electronLog from 'electron-log';

export function initLogging(): void {
  electronLog.initialize();
  electronLog.transports.file.level = 'info';
  electronLog.transports.file.maxSize = 5 * 1024 * 1024; // 5MB 轮转
  electronLog.transports.console.level = process.env.NODE_ENV === 'development' ? 'silly' : 'info';
  electronLog.transports.file.fileName = 'main.log';

  // 替换默认 console 实现，统一走日志
  console.log = (...args) => electronLog.info(...args);
  console.info = (...args) => electronLog.info(...args);
  console.warn = (...args) => electronLog.warn(...args);
  console.error = (...args) => electronLog.error(...args);
  console.debug = (...args) => electronLog.debug(...args);

  // 崩溃上报：落盘到系统 Crashpad，便于排查
  if (app.isPackaged) {
    app.setAppUserModelId('com.echoly.ide');
    try {
      crashReporter.start({
        productName: 'Echoly',
        companyName: 'Echoly',
        submitURL: '',
        uploadToServer: false,
      });
    } catch {
      // 无上传服务器时忽略，仅本地崩溃服务
    }
  }

  electronLog.info('Echoly logging initialized');
}

export const log = electronLog;
