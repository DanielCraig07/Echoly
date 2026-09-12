import { describe, it, expect } from 'vitest';
import { colorizeTerminalLogs } from '../src/renderer/src/utils/terminalLogColorizer';

describe('colorizeTerminalLogs', () => {
  it('colorizes user exact application INFO log with blue background badge', () => {
    const raw =
      '2026-09-12 11:57:03 EmbeddedLeaderService.java INFO Received confirmation of leadership for leader akka://flink/user/rpc/resourcemanager_1 , session=d920d042-86e1-4a43-b513-6e540b60cbb7';
    const result = colorizeTerminalLogs(raw);

    // Must contain 24-bit blue background badge for INFO
    expect(result).toContain('\x1b[48;2;18;52;98m');
    expect(result).toContain(' INFO ');
    expect(result).toContain('EmbeddedLeaderService.java');
    expect(result).toContain('Received confirmation of leadership');
  });

  it('colorizes application WARN log with amber background badge and message highlight', () => {
    const raw =
      '2026-09-12 11:57:03 EmbeddedLeaderService.java WARN Connection timeout occurred';
    const result = colorizeTerminalLogs(raw);

    expect(result).toContain('\x1b[48;2;120;65;0m');
    expect(result).toContain(' WARN ');
    expect(result).toContain('Connection timeout occurred');
  });

  it('colorizes application ERROR log with crimson background badge and error message highlight', () => {
    const raw =
      '2026-09-12 11:57:03 EmbeddedLeaderService.java ERROR Fatal leader election failure';
    const result = colorizeTerminalLogs(raw);

    expect(result).toContain('\x1b[48;2;153;27;27m');
    expect(result).toContain(' ERROR ');
    expect(result).toContain('Fatal leader election failure');
  });

  it('colorizes application DEBUG log with purple background badge', () => {
    const raw =
      '2026-09-12 11:57:03 EmbeddedLeaderService.java DEBUG Heartbeat ping acknowledged';
    const result = colorizeTerminalLogs(raw);

    expect(result).toContain('\x1b[48;2;65;35;95m');
    expect(result).toContain(' DEBUG ');
  });

  it('colorizes logs with milliseconds and thread names', () => {
    const raw =
      '2026-09-12 11:57:03.456 [main] INFO com.tsingtec.service - Application started in 1.2s';
    const result = colorizeTerminalLogs(raw);

    expect(result).toContain('\x1b[48;2;18;52;98m');
    expect(result).toContain(' INFO ');
    expect(result).toContain('[main]');
  });

  it('colorizes thread-only logs without timestamps', () => {
    const raw = '[main] INFO org.apache.flink.runtime - Component initialized';
    const result = colorizeTerminalLogs(raw);

    expect(result).toContain('\x1b[48;2;18;52;98m');
    expect(result).toContain(' INFO ');
    expect(result).toContain('[main]');
  });

  it('colorizes standard Maven [INFO], [WARNING], [ERROR] build lines', () => {
    const mavenInfo = '[INFO] Scanning for projects...';
    expect(colorizeTerminalLogs(mavenInfo)).toContain('\x1b[48;2;18;52;98m');

    const mavenWarn = '[WARNING] Some problems were encountered';
    expect(colorizeTerminalLogs(mavenWarn)).toContain('\x1b[48;2;120;65;0m');

    const mavenError = '[ERROR] Failed to execute goal';
    expect(colorizeTerminalLogs(mavenError)).toContain('\x1b[48;2;153;27;27m');
  });

  it('colorizes BUILD SUCCESS, BUILD FAILURE and process exit badges', () => {
    expect(colorizeTerminalLogs('BUILD SUCCESS')).toContain('\x1b[48;2;22;101;52m');
    expect(colorizeTerminalLogs('BUILD FAILURE')).toContain('\x1b[48;2;153;27;27m');
    expect(colorizeTerminalLogs('[Process finished with exit code 0]')).toContain('\x1b[48;2;22;101;52m');
  });

  it('does not alter regular shell commands or inputs without log prefixes', () => {
    const cmd = 'git checkout main';
    expect(colorizeTerminalLogs(cmd)).toBe(cmd);
  });

  it('correctly handles and preserves multi-thousand character single-line logs without breaking newlines', () => {
    const prefix = '2026-09-12 12:11:48 CheckpointFailureManager.java INFO Failed to trigger checkpoint: ';
    const payload = 'task-sink-'.repeat(300); // 3000 chars
    const raw = `${prefix}${payload}`;
    const result = colorizeTerminalLogs(raw);

    // Should add the INFO badge
    expect(result).toContain('\x1b[48;2;18;52;98m\x1b[38;2;147;197;253m\x1b[1m INFO \x1b[0m');
    // Must contain entire long payload intact
    expect(result).toContain(payload);
    // Must not insert any unintended newlines
    expect(result.includes('\n')).toBe(false);
    expect(result.includes('\r')).toBe(false);
  });

  it('validates DEFAULT_SETTINGS includes terminalScrollback with 10000 lines', async () => {
    const { DEFAULT_SETTINGS } = await import('@deepseek-ide/shared');
    expect(DEFAULT_SETTINGS.terminalScrollback).toBe(10000);
  });
});

