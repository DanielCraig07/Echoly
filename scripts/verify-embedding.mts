/**
 * 语义检索的「真模型」验证脚本（不是单测）。
 *
 * 单测覆盖的是「注入假模型 + 真实的 EmbeddingClient 与融合层」—— 它验的是我们的逻辑，
 * 验不到「真 onnx 模型能不能加载、输出对不对」。这个脚本补的就是那一段：
 * 真的按需下载一次 `Xenova/bge-small-zh-v1.5`、真的跑一次推理、检查向量维度与归一化，
 * 再用一组关键词完全不重合的候选看一眼排序。
 *
 * 用法：npm run verify:embedding
 * （第一次会下载约 25MB 权重，缓存在临时目录；之后几毫秒就能加载完）
 */

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 缓存到临时目录：校验脚本不该往仓库或用户目录里塞模型文件。 */
const CACHE_DIR = path.join(os.tmpdir(), 'echoly-verify-embedding');

function cosine(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

async function main(): Promise<number> {
  mkdirSync(CACHE_DIR, { recursive: true });

  // 先把缓存目录指过去。transformers 是同一个模块实例，下面 createLocalEmbedding
  // 内部的动态 import 会复用它，所以这里的设置是生效的。
  const transformers = (await import('@huggingface/transformers')) as unknown as {
    env: { cacheDir: string };
  };
  transformers.env.cacheDir = CACHE_DIR;

  const { createLocalEmbedding } = await import('../packages/llm/src/localEmbedding.js');

  const started = Date.now();
  const handle = await createLocalEmbedding({
    onProgress: (message) => console.log(`   ${message}`),
  });
  if (!handle.client) {
    console.error(`✗ 语义检索不可用：${handle.describe}`);
    console.error('  这只说明这台机器上拿不到模型，不代表功能被改坏了。');
    return 1;
  }
  console.log(`✓ 模型就绪（${Date.now() - started}ms）：${handle.describe}`);

  const query = '用户登录状态怎么保持';
  const candidates = [
    'function renewSession(req) { req.session.lastSeen = Date.now(); }',
    'function keepSessionAlive(sid) { return store.touch(sid); }',
    'body { background: #fff; margin: 0 auto; }',
    'git rebase --interactive HEAD~3',
  ];
  const [queryVector, ...candidateVectors] = await handle.client.embedTexts([query, ...candidates]);

  const dimension = queryVector.length;
  const norm = Math.sqrt(cosine(queryVector, queryVector));
  console.log(`✓ 维度 ${dimension}，范数 ${norm.toFixed(6)}`);
  if (dimension !== 512) {
    console.error(`✗ 维度不对：bge-small-zh-v1.5 应当是 512`);
    return 1;
  }
  // 范数必须是 1：下游（双路召回）直接拿点积当余弦用，没归一化的话相似度会算错
  if (Math.abs(norm - 1) > 1e-3) {
    console.error('✗ 向量没有归一化：下游按点积算余弦会得到错误结果');
    return 1;
  }

  const ranked = candidates
    .map((text, index) => ({ text, score: cosine(queryVector, candidateVectors[index]) }))
    .sort((a, b) => b.score - a.score);
  console.log(`\n查询：「${query}」`);
  for (const [index, item] of ranked.entries()) {
    console.log(`  ${index + 1}. ${item.score.toFixed(4)}  ${item.text}`);
  }

  // 只断言「最相关的那条排在最后一条之前」这个弱条件：
  // 实测（见 PLAN）中文查询对英文代码片段的余弦相似度挤在 0.32~0.41，
  // 无关片段偶尔会插进来。做更强的断言会变成一个经常无缘无故失败的脚本。
  const sessionScore = ranked.find((item) => item.text.includes('renewSession'))?.score ?? 0;
  const unrelatedScore = ranked.find((item) => item.text.includes('background'))?.score ?? 0;
  if (sessionScore <= unrelatedScore) {
    console.error('\n✗ 相关片段没有排在无关片段之前，语义检索的排序可能坏了');
    return 1;
  }
  console.log(
    '\n✓ 相关片段排在无关片段之前（分数区间窄是本模型的已知特性，融合层用 RRF 只看名次）',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('✗ 验证失败：', error);
    process.exit(1);
  });
