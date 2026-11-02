/**
 * 把隐私模式落到进程环境上。
 *
 * 为什么走环境变量而不是层层传参：语义检索的开关本来就有一组环境变量
 * （`ECHOLY_EMBEDDING_*`），`CodebaseService` 的装配层直接读它们。
 * 设置页开关只是这组开关的另一个入口，共用同一个真相来源，
 * 才不会出现「设置页关了、环境变量又开着」这种自相矛盾的组合。
 *
 * 一个已知的时间差：已经加载好的语义模型不会因为开启隐私模式而被卸载
 * （模型在内存里，没有「卸载」这个概念），下次重新加载时才生效。
 * 影响仅限于「本来就要用的本地模型」——真正的联网下载是即时被拦住的。
 */
export function applyPrivacyModeEnv(privacyMode: boolean): void {
  if (privacyMode) {
    process.env.ECHOLY_EMBEDDING_OFFLINE = '1';
  } else {
    delete process.env.ECHOLY_EMBEDDING_OFFLINE;
  }
}
