import { describe, expect, it } from 'vitest';
import { MessageQueue } from '../src/main/agentService';

const msg = (id: string) => ({ id, content: `内容 ${id}` });

describe('MessageQueue', () => {
  it('refuses a push for a run that was never opened', () => {
    const q = new MessageQueue();
    // 未开启 = 该轮已经结束了。返回 false 让调用方改走「新起一轮」，
    // 而不是把用户刚敲的内容丢进一个不存在的队列。
    expect(q.push('unknown', msg('a'))).toBe(false);
  });

  it('returns queued messages in submission order and empties the queue', () => {
    const q = new MessageQueue();
    q.open('r1');
    q.push('r1', msg('a'));
    q.push('r1', msg('b'));
    expect(q.drain('r1').map((m) => m.id)).toEqual(['a', 'b']);
    expect(q.drain('r1')).toEqual([]);
  });

  it('keeps accepting pushes after a drain — the run is still in flight', () => {
    const q = new MessageQueue();
    q.open('r1');
    q.push('r1', msg('a'));
    q.drain('r1');
    // 若 drain 删掉了这个键，用户在这之后追加的消息会被误判成「该轮已结束」
    expect(q.push('r1', msg('b'))).toBe(true);
    expect(q.drain('r1').map((m) => m.id)).toEqual(['b']);
  });

  it('drains one message exactly once', () => {
    const q = new MessageQueue();
    q.open('r1');
    q.push('r1', msg('a'));
    const first = q.drain('r1');
    const second = q.drain('r1');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('hands back undelivered messages when the run closes', () => {
    const q = new MessageQueue();
    q.open('r1');
    q.push('r1', msg('a'));
    q.push('r1', msg('b'));
    expect(q.close('r1').map((m) => m.id)).toEqual(['a', 'b']);
    // 关闭后这个 runId 不应再接受消息
    expect(q.push('r1', msg('c'))).toBe(false);
  });

  it('closing after a drain reports nothing pending', () => {
    const q = new MessageQueue();
    q.open('r1');
    q.push('r1', msg('a'));
    q.drain('r1');
    expect(q.close('r1')).toEqual([]);
  });

  it('isolates concurrent runs', () => {
    const q = new MessageQueue();
    q.open('r1');
    q.open('r2');
    q.push('r1', msg('a'));
    q.push('r2', msg('b'));
    expect(q.drain('r1').map((m) => m.id)).toEqual(['a']);
    expect(q.close('r2').map((m) => m.id)).toEqual(['b']);
    expect(q.drain('r1')).toEqual([]);
  });
});
