/**
 * 扩展详情页「说明文档」的验证脚本。
 *
 * 为什么需要它：详情页原来只拼一条 `/{version}/file/README.md`。
 * 对**平台专属**扩展（Claude Code 就是）这条是 404 —— 注册表把这类扩展的文件
 * 挂在平台路径下（`/api/Anthropic/claude-code/alpine-arm64/{v}/file/README.md`），
 * 而且只为当前版本保留，带上别的版本号同样 404。
 * 于是界面上显示「注册表没有提供这个扩展的说明文档」—— 而它其实有。
 *
 * 这个脚本会真的去注册表抓一遍，并把三条候选的返回码打出来，
 * 让人一眼看出是「注册表确实没有」还是「我们抓错了地址」。
 *
 * 用法：npm run verify:readme [publisher.name]
 */

import { buildReadmeCandidates, parseOpenVsxDetail } from '../packages/vscode-shim/src/openVsx';

const args = process.argv.slice(2);
// `--registry <url>` 用来照内网镜像；位置参数放扩展 id。
const registryFlag = args.indexOf('--registry');
const registry =
  (registryFlag >= 0 ? args[registryFlag + 1] : undefined) ??
  process.env.ECHOLY_REGISTRY ??
  'https://open-vsx.org';
// `--registry` 后面那一个参数是它的值，不算位置参数
const valueIndex = registryFlag >= 0 ? registryFlag + 1 : -1;
const extensionId =
  args.find((arg, i) => !arg.startsWith('--') && i !== valueIndex) ?? 'Anthropic.claude-code';

async function main() {
  const [namespace, name] = extensionId.split('.');
  if (!namespace || !name) throw new Error(`扩展 id 不合法：${extensionId}`);

  const res = await fetch(`${registry}/api/${namespace}/${name}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`注册表返回 ${res.status}`);
  const detail = parseOpenVsxDetail(await res.json(), registry);
  if (!detail) throw new Error('注册表返回的数据无法解析');

  console.log(
    `→ ${detail.id}@${detail.version}` +
      `${detail.targetPlatform ? `（平台专属：${detail.targetPlatform}）` : '（通用构建）'}`,
  );

  const candidates = buildReadmeCandidates(registry, detail.id, detail.version, detail.readmeUrl);
  for (const url of candidates) {
    const attempt = await fetch(url);
    const text = attempt.ok ? await attempt.text() : '';
    console.log(`${attempt.status}  ${String(text.length).padStart(7)} 字节  ${url}`);
    if (attempt.ok && text.trim()) {
      const preview = text.trim().split('\n').slice(0, 4).join('\n');
      console.log(`✓ 详情页能拿到正文，开头是：\n${preview}`);
      return;
    }
  }
  throw new Error('三条候选都没拿到正文 —— 这个扩展的注册表条目确实没有 README');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
