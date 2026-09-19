import fs from 'node:fs';
import path from 'node:path';

export interface RulesResult {
  ok: boolean;
  content?: string | null;
  filename?: string;
}

export class RulesService {
  private cache = new Map<string, { content: string; mtime: number; filename: string }>();

  /**
   * 自动探测并获取工作区根目录下的规则文件内容
   * 优先顺序: .echolyrules -> .cursorrules
   */
  async getRules(workspaceRoot?: string | null): Promise<RulesResult> {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      return { ok: true, content: null };
    }

    try {
      const echolyRulesPath = path.join(workspaceRoot, '.echolyrules');
      const cursorRulesPath = path.join(workspaceRoot, '.cursorrules');

      let targetPath: string | null = null;
      let filename = '.echolyrules';

      if (fs.existsSync(echolyRulesPath)) {
        targetPath = echolyRulesPath;
        filename = '.echolyrules';
      } else if (fs.existsSync(cursorRulesPath)) {
        targetPath = cursorRulesPath;
        filename = '.cursorrules';
      }

      if (!targetPath) {
        return { ok: true, content: null, filename: '.echolyrules' };
      }

      const stat = await fs.promises.stat(targetPath);
      const cached = this.cache.get(targetPath);
      if (cached && cached.mtime === stat.mtimeMs) {
        return { ok: true, content: cached.content, filename };
      }

      const content = await fs.promises.readFile(targetPath, 'utf8');
      this.cache.set(targetPath, { content, mtime: stat.mtimeMs, filename });

      return { ok: true, content, filename };
    } catch (err) {
      console.warn('[RulesService] Failed to load rules file:', err);
      return { ok: false, content: null };
    }
  }

  /**
   * 根据当前工作区的技术栈特征（识别 pom.xml、package.json、CMakeLists.txt、requirements.txt、go.mod 等），
   * 自动生成针对该项目深度定制的 .echolyrules 规则规范
   */
  generateTemplateRules(workspaceRoot?: string | null): string {
    if (!workspaceRoot) {
      return `# .echolyrules
# Echoly 项目级 AI 规则规范 (通用工程模板)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 代码规范
- 代码风格简洁现代，模块化设计，注释默认使用中文；
- 保持函数与组件的高内聚、低耦合，避免过度抽象；
- 遵循当前技术栈官方推荐的最佳实践与命名规范。

## 交互与工作流
- 保持向后兼容性与系统稳定性；
- 关键重构或破坏性变更需进行验证并主动提示。
`;
    }

    try {
      const exists = (file: string) => fs.existsSync(path.join(workspaceRoot, file));

      // 1. Java / Maven / Gradle
      if (exists('pom.xml') || exists('build.gradle') || exists('build.gradle.kts')) {
        return `# .echolyrules
# Echoly 项目级 AI 规则规范 (针对 Java / Spring Boot 项目定制)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 架构与分层设计
- 遵循阿里巴巴 Java 开发手册与 Spring Boot 3 规范；
- 严格遵循标准的 Controller -> Service -> Repository / Mapper 分层设计，保持高内聚低耦合；
- 实体类 (Entity) 与数据传输对象 (DTO/VO) 职责分离，入参校验优先使用 JSR-303/380 注解；
- 核心公共方法提供清晰的 Javadoc 注释，标明输入、输出与潜在异常。

## 异常与安全性
- 异常统一由全局异常处理器 (@RestControllerAdvice) 兜底，严禁捕获 Throwable 或编写空 catch 块；
- 数据库操作严格使用预编译参数绑定 (如 MyBatis #{} 或 JPA) 防 SQL 注入；
- 日志输出对敏感数据进行脱敏。

## 构建与依赖
- 严格遵循项目已配置的 Maven / Gradle 依赖版本，杜绝随意引入未评审的第三方过时库。
`;
      }

      // 2. Python
      if (exists('requirements.txt') || exists('pyproject.toml') || exists('Pipfile') || exists('setup.py')) {
        return `# .echolyrules
# Echoly 项目级 AI 规则规范 (针对 Python 项目定制)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 编码与类型规范
- 遵循 PEP 8 风格指南，代码整洁且语义化；
- 核心函数与公共 API 必须包含明确的 Type Hints (类型提示) 与标准格式 Docstrings；
- 优先采用 Python 3.10+ 现代语法特性 (如 match-case、管道联合类型 X | Y)。

## 架构与工程规范
- 模块组织清晰，业务逻辑与数据访问层分离；
- 异步操作严密遵循 asyncio 最佳实践，避免阻塞主事件循环；
- 异常处理精细化，严禁无意义的全局裸 except:。
`;
      }

      // 3. C / C++
      if (exists('CMakeLists.txt') || exists('Makefile') || exists('compile_commands.json')) {
        return `# .echolyrules
# Echoly 项目级 AI 规则规范 (针对 Modern C/C++ 项目定制)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 现代 C++ 规范
- 严格遵循 Modern C++ (C++17/20) 标准与 RAII 资源生命周期管理哲学；
- 杜绝使用裸指针 (raw pointer) 负责对象生命周期，优先使用 std::unique_ptr 或 std::shared_ptr；
- 只读对象传参优先采用 const 引用 (const T&)，小对象或右值按值/移动语义传递。

## 安全与异常
- 避免未定义行为 (UB)、悬空引用与内存越界访问；
- 头文件采用 #pragma once 或规范 include guard，仅对外暴露必要声明。
`;
      }

      // 4. Go
      if (exists('go.mod')) {
        return `# .echolyrules
# Echoly 项目级 AI 规则规范 (针对 Go 项目定制)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 编码规范
- 严格遵循 Effective Go 与 Go 官方编码规范；
- 显式错误处理：检查每一个返回的 err，禁止使用 _ 忽略未处理的 error；
- 涉及并发或超时操作必须显式传递 context.Context，并作为函数首位入参。

## 并发安全
- 严防 Goroutine 泄漏，channel 发送/接收与 WaitGroup 必须有明确退出条件；
- 优先面向接口编程，保持接口体积小巧专注。
`;
      }

      // 5. Rust
      if (exists('Cargo.toml')) {
        return `# .echolyrules
# Echoly 项目级 AI 规则规范 (针对 Rust 项目定制)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 编码与安全规范
- 充分利用 Rust 所有权与借用检查机制，保证内存与并发绝对安全；
- 生产代码杜绝非必要的 unwrap()，优先使用 ? 操作符与 Result/Option 组合子；
- 遵循 Rust API Guidelines，优先实现标准库常用 trait。
`;
      }

      // 6. TypeScript / React / 前端
      if (exists('package.json') || exists('tsconfig.json')) {
        return `# .echolyrules
# Echoly 项目级 AI 规则规范 (针对 TypeScript / 前端项目定制)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 编码规范
- 采用 TypeScript 严格模式，避免使用 any，为核心函数与组件定义清晰的 Props / Interface；
- 组件遵循单一职责，UI 与业务状态解耦，优先使用纯函数与自定义 Hooks；
- 变量与函数命名语义化，注释默认使用中文说明核心业务逻辑。

## 性能与最佳实践
- 避免不必要的深层组件重渲染，复杂计算合理使用 useMemo / useCallback；
- 严格防范潜在的内存泄漏与未清理的副作用订阅。
`;
      }
    } catch {}

    return `# .echolyrules
# Echoly 项目级 AI 规则规范 (通用工程模板)
# AI 在代码补全、行内编辑 (⌘K)、对话重构及 Composer (⌘I) 时将遵循本规范

## 代码规范
- 代码风格简洁现代，模块化设计，注释默认使用中文；
- 保持函数与组件的高内聚、低耦合，避免过度抽象；
- 遵循当前技术栈官方推荐的最佳实践与命名规范。

## 交互与工作流
- 保持向后兼容性与系统稳定性；
- 关键重构或破坏性变更需进行验证并主动提示。
`;
  }

  /**
   * 保存或更新 .echolyrules 文件
   */
  async saveRules(content: string, workspaceRoot?: string | null): Promise<{ ok: boolean }> {
    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
      return { ok: false };
    }

    try {
      const finalContent = content.trim() ? content : this.generateTemplateRules(workspaceRoot);
      const targetPath = path.join(workspaceRoot, '.echolyrules');
      await fs.promises.writeFile(targetPath, finalContent, 'utf8');
      const stat = await fs.promises.stat(targetPath);
      this.cache.set(targetPath, { content: finalContent, mtime: stat.mtimeMs, filename: '.echolyrules' });
      return { ok: true };
    } catch (err) {
      console.error('[RulesService] Failed to save rules file:', err);
      return { ok: false };
    }
  }
}
