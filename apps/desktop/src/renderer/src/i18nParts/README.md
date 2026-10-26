# i18n 字典分片

`i18n.ts` 里的 `DICT` 是**主表**（骨架期就定下的 key，如 `app.*` / `chat.*` / `settings.*`）。
本目录下的分片是各组件铺开 i18n 时新增的 key，按领域拆开，由 `i18n.ts` 合并进同一个 `DICT`。

为什么要拆：铺开阶段往往有多个改动同时在加 key，全塞进 `i18n.ts` 同一个对象里几乎必然冲突。
分片让「一个领域一个文件」，合并顺序集中在一处，冲突面从「整张字典」缩到「一行 import」。

## 加一个分片的步骤

1. 新建 `i18nParts/<领域>.ts`，导出 `export const <领域>Dict: Record<string, { zh: string; en: string }>`。
2. 在 `i18n.ts` 里 `import` 它，然后**两个地方**都要加：`DICT_PARTS`（给测试做重复检查用）
   和 `DICT`（真正生效的合并）。漏了后者，界面上会直接显示 key。
3. 跑 `npx vitest run apps/desktop/test/i18n.test.ts apps/desktop/test/i18nKeys.test.ts`。

合并顺序就是 `DICT` 里 `...` 的书写顺序，**同名的 key 后写的会静默覆盖先写的** ——
表现是「改了中文但界面没变」，而且在中文环境下完全不显眼。`i18n.test.ts` 里有一组
测试就是专门在合并之前按片两两比对，把这个覆盖揪出来。

## 新加 key 时的约定

- key 用 `<领域>.<语义>`，领域名与本目录文件名对应（如 `git.stageAll`）。主表已有的 key
  不要在新分片里重复定义。
- 中英两版都要写；漏英文在中文环境下完全看不出来，`test/i18n.test.ts` 会遍历真实字典把它揪出来。
  英文里混进中文同样会被抓（`[一-龥]`）。
- 一句话里带变量的，整句进字典并用 `{占位符}`，不要把句子拆成几段拼接 —— 中英语序不同
  （「在 3 个文件中找到了 12 个结果」↔ "Found 12 results in 3 files"）。
  句子中间要嵌 `<code>` 之类的元素时用 `translateSegments`。
- **动态拼出来的 key**（`t(\`tree.moveReject.${code}\`)`）静态扫不到，
  去 `apps/desktop/test/i18nKeys.test.ts` 的 `DYNAMIC_KEY_PREFIXES` 里补上前缀，
  否则「分片里的 key 都有引用」那条会开始误报。
