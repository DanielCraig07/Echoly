import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '@deepseek-ide/shared';
import { probeEmbedding, probeLlm } from './index.js';

async function main() {
  const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL;
  const model = process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY ?? '';
  console.log(`Probing LLM at ${baseUrl} model=${model}`);
  const result = await probeLlm({ baseUrl, model, apiKey });
  console.log(JSON.stringify(result, null, 2));

  // embedding 单独探一次。网关很可能「对话通道开着、embedding 通道没开」，
  // 这正是语义检索改用本地模型的原因 —— 把两件事分开报，
  // 才不会让「没有 embedding 通道」被一句笼统的「连接失败」盖过去。
  // 这一项只作参考，不参与退出码：它在自建网关上失败是**预期行为**。
  const embeddingBaseUrl = process.env.EMBEDDING_BASE_URL ?? baseUrl;
  const embeddingModel = process.env.EMBEDDING_MODEL || undefined;
  const embeddingApiKey = process.env.EMBEDDING_API_KEY ?? apiKey;
  console.log(
    `Probing embeddings at ${embeddingBaseUrl}${embeddingModel ? ` model=${embeddingModel}` : ''}`,
  );
  const embedding = await probeEmbedding({
    baseUrl: embeddingBaseUrl,
    apiKey: embeddingApiKey,
    model: embeddingModel,
  });
  console.log(JSON.stringify(embedding, null, 2));

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
