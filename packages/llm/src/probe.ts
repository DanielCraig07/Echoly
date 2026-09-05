import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '@deepseek-ide/shared';
import { probeLlm } from './index.js';

async function main() {
  const baseUrl = process.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL;
  const model = process.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
  const apiKey = process.env.LLM_API_KEY ?? '';
  console.log(`Probing LLM at ${baseUrl} model=${model}`);
  const result = await probeLlm({ baseUrl, model, apiKey });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
