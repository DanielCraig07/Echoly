import { describe, expect, it } from 'vitest';
import {
  CONTENT_GUARD_OPTIONS,
  REASONING_GUARD_OPTIONS,
  SERVER_TRIM_OPTIONS,
  RepetitionGuard,
  detectTrailingRepeat,
  repetitionChannelLabel,
  trimTrailingRepeats,
} from '../src/repetitionGuard';

/** 把长文本按固定宽度切成流式 delta，模拟 SSE 的碎块投递。 */
function streamInChunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * 造一个「内部不存在任何短周期」的块。
 *
 * 这是复现盲区的关键：如果拿一句本身包含重复小片段的文本去测，检测器会命中那个
 * 小周期而不是整块的周期，于是「块长 600」这种用例会假通过。这里用线性同余发生器
 * 从字符池里取字符，并断言整块不是任何更短周期的重复。
 */
function aperiodicBlock(len: number, seed = 1): string {
  const pool = '丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥甲乙';
  let out = '';
  let s = seed >>> 0;
  while (out.length < len) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out += pool[(s >>> 8) % pool.length];
  }
  out = out.slice(0, len);
  for (let p = 1; p < len; p++) {
    if (len % p) continue;
    if (out.slice(0, p).repeat(len / p) === out) return aperiodicBlock(len, seed + 1);
  }
  return out;
}

/** 逐块喂入并返回首次命中位置（未命中返回 null）。 */
function feedUntilHit(text: string, opts: unknown, chunk = 8): number | null {
  const guard = new RepetitionGuard(opts as never);
  for (let i = 0; i < text.length; i += chunk) {
    if (guard.feed(text.slice(i, i + chunk))) return guard.chars;
  }
  return null;
}

describe('detectTrailingRepeat', () => {
  it('命中「同一句话重复多遍」的后缀周期', () => {
    const sentence = '让我再确认一下这个函数的参数是否完整。';
    const text = `前面对话的铺垫内容。${sentence.repeat(6)}`;
    const hit = detectTrailingRepeat(text);
    expect(hit).not.toBeNull();
    expect(hit!.period).toBe(sentence.length);
    expect(hit!.repeats).toBe(6);
  });

  it('命中「几句话成组重复」的后缀周期', () => {
    const block = '第一步先读取配置。\n第二步校验参数。\n第三步执行写入。\n';
    const text = `开始分析。\n${block.repeat(5)}`;
    const hit = detectTrailingRepeat(text);
    expect(hit).not.toBeNull();
    expect(hit!.period).toBe(block.length);
    expect(hit!.repeats).toBeGreaterThanOrEqual(5);
  });

  it('对正常文本不误报', () => {
    const text =
      '先读取 packages/llm/src/index.ts，确认 chatStream 的循环结构；' +
      '再检查 packages/agent/src/index.ts 里的重试分支；' +
      '最后把结论写入报告。';
    expect(detectTrailingRepeat(text)).toBeNull();
  });

  it('对重复的分隔线不误报（纯符号片段）', () => {
    const text = `正文内容一段。\n${'='.repeat(120)}`;
    expect(detectTrailingRepeat(text, { minRepeats: 3 })).toBeNull();
  });

  it('重复次数不足阈值时不命中', () => {
    const sentence = '这句话只重复了三次。';
    expect(detectTrailingRepeat(`${'前言'.repeat(200)}${sentence.repeat(3)}`)).toBeNull();
  });

  it('命中周期最小的那个片段（重复次数最多）', () => {
    const text = '甲'.repeat(300);
    const hit = detectTrailingRepeat(text, { minPeriod: 4, minRepeats: 4 });
    expect(hit).not.toBeNull();
    expect(hit!.period).toBe(4);
  });
});

describe('trimTrailingRepeats', () => {
  it('只保留第一份重复片段', () => {
    const sentence = '这是一句会重复的话。';
    const text = sentence.repeat(6);
    const hit = detectTrailingRepeat(text)!;
    expect(trimTrailingRepeats(text, hit)).toBe(sentence);
  });
});

describe('RepetitionGuard', () => {
  it('在流式碎块投递下能命中重复', () => {
    const sentence = '让我再确认一下这个函数的参数是否完整。';
    const lead =
      '正常的起始推理内容，先交代一下背景、已知条件与待确认的边界情况，' +
      '再逐步排查每一个可疑点，避免过早下结论导致返工。\n';
    const text = `${lead}${sentence.repeat(40)}`;
    const guard = new RepetitionGuard(REASONING_GUARD_OPTIONS);

    let fired = false;
    for (const delta of streamInChunks(text, 7)) {
      if (guard.feed(delta)) {
        fired = true;
        break;
      }
    }
    expect(fired).toBe(true);
    expect(guard.hit).not.toBeNull();
    expect(guard.hit!.repeats).toBeGreaterThanOrEqual(5);
  });

  it('只报告一次命中', () => {
    const lead =
      '这是一段足够长的铺垫内容，用来把总长度推过检测起始阈值，' +
      '这样后续的重复片段才会真正进入检测范围。\n';
    const text = `${lead}${'重复的内容片段需要足够长才能被识别出来。'.repeat(40)}`;
    const guard = new RepetitionGuard(REASONING_GUARD_OPTIONS);
    let fireCount = 0;
    for (const delta of streamInChunks(text, 5)) {
      if (guard.feed(delta)) fireCount++;
    }
    expect(fireCount).toBe(1);
  });

  it('长度不足 minChars 时不检测', () => {
    const guard = new RepetitionGuard({ minChars: 600 });
    let fired = false;
    for (const delta of streamInChunks('短'.repeat(100), 5)) {
      if (guard.feed(delta)) fired = true;
    }
    expect(fired).toBe(false);
  });

  it('正文通道的阈值比思考通道更保守', () => {
    expect(CONTENT_GUARD_OPTIONS.minRepeats!).toBeGreaterThan(REASONING_GUARD_OPTIONS.minRepeats!);
    expect(CONTENT_GUARD_OPTIONS.minPeriod!).toBeGreaterThan(REASONING_GUARD_OPTIONS.minPeriod!);
  });

  it('正常长回答不会触发正文熔断', () => {
    const paragraphs = [
      '# 实现方案\n\n本次改动涉及三个层面，下面逐一说明。\n',
      '## 一、请求侧加固\n\n在 buildBody 中补上 max_tokens 与惩罚项。\n',
      '## 二、检测侧\n\n在累积文本上做后缀周期检测。\n',
      '## 三、收尾策略\n\n熔断后保留首份内容并提示用户。\n',
      '综上，三层防护叠加后可以终止无限复读。\n',
    ];
    const text = paragraphs.join('\n');
    const guard = new RepetitionGuard(CONTENT_GUARD_OPTIONS);
    let fired = false;
    for (const delta of streamInChunks(text, 9)) {
      if (guard.feed(delta)) fired = true;
    }
    expect(fired).toBe(false);
  });
});

/**
 * 回归：maxPeriod 曾经是 240，于是「整段整段地重播」这种退化完全落在盲区里 ——
 * 长于 240 字符的块无论重复多少遍都检不出来，只能等 max_tokens 兜底，
 * 用户看到的就是几万字符的重复输出。真实环境里实测到过 232 字符的段落被连播 9 遍，
 * 离盲区只差 8 个字符。
 */
describe('RepetitionGuard 长块盲区（maxPeriod 回归）', () => {
  it('周期超过 240 字符的整块重播也能检出', () => {
    for (const len of [241, 300, 600, 1200]) {
      const block = aperiodicBlock(len, len * 13);
      const at = feedUntilHit(block.repeat(20), REASONING_GUARD_OPTIONS);
      expect(at, `块长 ${len} 未能检出`).not.toBeNull();
      // 下限是「必须攒够 minRepeats 份」，再加最多一个检测间隔。
      // 关键是它不随流长度增长 —— 旧实现这里是「永远检不出」。
      const floor = len * REASONING_GUARD_OPTIONS.minRepeats!;
      expect(at!).toBeLessThanOrEqual(floor + REASONING_GUARD_OPTIONS.checkEveryChars! * 2);
    }
  });

  it('1200 正好是新的上限边界：1200 可检出，1201 不再强求', () => {
    expect(
      feedUntilHit(aperiodicBlock(1200, 91).repeat(10), CONTENT_GUARD_OPTIONS, 12),
    ).not.toBeNull();
  });

  it('真实退化样本：232 字符段落连播 9 遍应被正文通道拦下', () => {
    const para =
      '我先把目前的线索按时间顺序捋一遍。最早出现的异常是在导入配置那一步，控制台提示字段缺失，' +
      '但同一个文件在另一台机器上却能正常加载，说明问题未必出在文件本身。接着我去翻了下变更记录，' +
      '发现昨天有人调整过默认值的合并顺序，把用户配置放在了内置默认之前，这会导致部分字段被旧值覆盖。' +
      '为了确认这个猜测，我把合并逻辑单独抽出来跑了一遍，结果印证了上面的判断，被覆盖的正好都是新增字段。';
    // 阈值调整前 minChars=1200，这段重复 5 遍（1160 字符）根本进不了检测范围
    const at = feedUntilHit(para.repeat(9), CONTENT_GUARD_OPTIONS, 12);
    expect(at).not.toBeNull();
    expect(at!).toBeLessThan(para.length * 9);
  });
});

/**
 * 回归：minChars 曾经是 600 / 1200，短输出完全不做检测，
 * 于是「短回答里同一句话重复几十遍」会作为一次成功的回答交付给用户。
 */
describe('RepetitionGuard 短输出检测（minChars 回归）', () => {
  it('不足 400 字符的正文里整句复读也能检出', () => {
    const sentence = '让我重新检查一下这段逻辑是否正确。';
    // 17 字符 × 20 遍 = 340 字符，旧阈值（1200）下完全不可见
    const text = sentence.repeat(20);
    expect(text.length).toBeLessThan(400);
    const at = feedUntilHit(text, CONTENT_GUARD_OPTIONS, 4);
    expect(at).not.toBeNull();
  });

  it('极短文本仍然不检出，避免把正常短答当退化', () => {
    expect(feedUntilHit('好的。'.repeat(10), CONTENT_GUARD_OPTIONS)).toBeNull();
  });
});

describe('SERVER_TRIM_OPTIONS', () => {
  it('服务端判定复读时，能把几万字符的重复尾部裁成一份', () => {
    const block = aperiodicBlock(1500, 7);
    const text = block.repeat(30); // 45000 字符
    const hit = detectTrailingRepeat(text, SERVER_TRIM_OPTIONS);
    expect(hit).not.toBeNull();
    const trimmed = trimTrailingRepeats(text, hit!);
    expect(trimmed.length).toBeLessThan(block.length * 2);
  });

  it('放松到极限也不会误伤正常长文', () => {
    const normal =
      '本次改动涉及请求侧、检测侧与收尾策略三个层面。\n' +
      '请求侧补齐 max_tokens 与惩罚项；检测侧在累积文本上做后缀周期检测；\n' +
      '收尾侧在命中后保留首份内容并提示用户，而不是把退化文本回灌上下文。\n';
    expect(detectTrailingRepeat(normal, SERVER_TRIM_OPTIONS)).toBeNull();
  });
});

describe('repetitionChannelLabel', () => {
  it('两条内容通道各有中文提示', () => {
    expect(repetitionChannelLabel('reasoning')).toBe('思考过程');
    expect(repetitionChannelLabel('content')).toBe('回答正文');
  });
});

/**
 * 工具参数**故意**不接入复读检测，这个测试把这个决定钉住。
 *
 * 写文件类工具的 arguments 合法地就经常是重复内容（重复的 fixture、日志样本、
 * 表格行、mock 数据）。实测中这些载荷与真退化的 (周期, 重复次数) 分布完全重叠，
 * 任何阈值都会误伤。误熔断意味着一次合法的文件写入被静默截断 —— 比让退化参数
 * 跑到 max_tokens 后由 JSON 解析失败兜底严重得多。
 */
describe('工具参数不接入复读检测（有意为之）', () => {
  it('合法的重复载荷不应触发正文通道的阈值', () => {
    const payloads = [
      JSON.stringify({ path: 'fixture.txt', content: 'aaaaaaaaaaaaaaaaaaaa\n'.repeat(30) }),
      JSON.stringify({ path: 'sample.log', content: '[INFO] heartbeat ok\n'.repeat(60) }),
      JSON.stringify({
        path: 'mock.json',
        content: JSON.stringify(Array.from({ length: 80 }, () => ({ ok: true, code: 200 }))),
      }),
      JSON.stringify({
        path: 't.md',
        content: Array.from({ length: 100 }, () => '| x | y |').join('\n'),
      }),
    ];
    // 这些载荷其实**会**被检测器命中 —— 这正是它们不能接进 tool_args 通道的原因。
    // 测试记录这一事实，防止有人日后「顺手」把它接回去。
    const hitCount = payloads.filter((p) => feedUntilHit(p, CONTENT_GUARD_OPTIONS) !== null).length;
    expect(hitCount).toBeGreaterThan(0);
  });

  it('apply_patch / i18n 这类合法参数则完全不会命中', () => {
    const patch = JSON.stringify({
      path: 'a.ts',
      patch: Array.from({ length: 40 }, (_, i) => ` context line ${i} unchanged`).join('\n'),
    });
    expect(feedUntilHit(patch, CONTENT_GUARD_OPTIONS)).toBeNull();
  });
});
