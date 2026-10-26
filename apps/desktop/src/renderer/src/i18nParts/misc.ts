/**
 * 其余零散组件（浏览器、搜索栏、会话、工作区弹窗等）的文案分片。
 *
 * 为什么字典要分片：i18n 铺开阶段有多个改动在并行加 key，
 * 全塞进 i18n.ts 同一个对象里几乎必然冲突。分片后「一个领域一个文件」，
 * 合并顺序集中在 i18n.ts 一处。
 */
export const miscDict: Record<string, { zh: string; en: string }> = {
  // ── 通用：弹窗右下角拖拽手柄 ──
  // 由 ModalResizeHandle 组件兜底；显式传 title 的调用点也复用同一条，避免两处文案漂移
  'common.resizeHandle': {
    zh: '拖动右下角调整大小 (支持上下左右)',
    en: 'Drag to resize (all directions)',
  },
  'common.closeEsc': { zh: '关闭 (Esc)', en: 'Close (Esc)' },

  // ══════════════════════════════════════════
  // 历史会话（SessionDrawer / SessionModal）
  // ══════════════════════════════════════════
  'session.historyTitle': { zh: '历史会话', en: 'Session History' },
  'session.close': { zh: '关闭', en: 'Close' },
  'session.loading': { zh: '加载中…', en: 'Loading…' },
  'session.empty': { zh: '暂无历史会话', en: 'No sessions yet' },
  'session.delete': { zh: '删除', en: 'Delete' },

  'session.deleteTitle': { zh: '删除历史会话', en: 'Delete Session' },
  'session.deleteIntro': {
    zh: '这条会话的全部对话记录将被永久删除，且**无法撤销**。',
    en: 'Every message in this session is permanently deleted and this **cannot be undone**.',
  },
  'session.confirmDelete': { zh: '确认删除', en: 'Delete' },
  'session.labelTitle': { zh: '标题', en: 'Title' },
  'session.labelTime': { zh: '时间', en: 'Time' },
  'session.labelTurns': { zh: '轮次', en: 'Turns' },
  'session.untitled': { zh: '（无标题）', en: '(Untitled)' },
  'session.unknown': { zh: '未知', en: 'Unknown' },
  'session.turnsCount': { zh: '{n} 轮', en: '{n} turns' },
  'session.turnsBadge': { zh: '💬 {n} 轮', en: '💬 {n} turns' },
  'session.countBadge': { zh: '{n} 条', en: '{n} items' },
  'session.emptyConversation': { zh: '（空对话）', en: '(Empty conversation)' },

  'session.new': { zh: '+ 新建会话', en: '+ New Session' },
  'session.searchPh': { zh: '搜索历史会话标题或内容…', en: 'Search session titles or content…' },
  'session.clear': { zh: '清空', en: 'Clear' },
  'session.noMatch': { zh: '没有匹配的会话', en: 'No matching sessions' },
  'session.renameTitle': { zh: '重命名会话', en: 'Rename session' },
  'session.deleteOneTitle': { zh: '删除会话', en: 'Delete session' },
  'session.renameSaveTitle': { zh: '保存名称 (Enter)', en: 'Save name (Enter)' },
  'session.renameCancelTitle': { zh: '取消 (Esc)', en: 'Cancel (Esc)' },

  'session.currentProject': { zh: '当前项目', en: 'Current Project' },
  'session.allProjects': { zh: '全部项目', en: 'All Projects' },
  'session.currentProjectCount': { zh: '当前项目 ({n})', en: 'Current Project ({n})' },
  'session.allProjectsCount': { zh: '全部项目 ({n})', en: 'All Projects ({n})' },
  'session.currentProjectTitle': {
    zh: '当前项目：{name} ({n} 条会话)',
    en: 'Current project: {name} ({n} sessions)',
  },
  'session.allProjectsTitle': {
    zh: '全部项目历史会话 ({n} 条)',
    en: 'Sessions across all projects ({n})',
  },
  'session.specificProject': { zh: '指定项目', en: 'Specific Project' },
  'session.specificProjectTitle': {
    zh: '选择具体项目（包含暂无历史会话的所有已知项目）',
    en: 'Choose a specific project (including known projects with no sessions)',
  },
  'session.dropdownHeader': {
    zh: '切换查看项目（所有项目均可选）',
    en: 'Switch project (any project can be selected)',
  },
  'session.projectCount': { zh: '{n} 个项目', en: '{n} projects' },
  'session.allProjectsGlobal': { zh: '全部项目 (全局)', en: 'All Projects (Global)' },
  'session.currentPrefix': { zh: '当前：{name}', en: 'Current: {name}' },
  'session.currentTag': { zh: '当前', en: 'Current' },

  // 顶部范围徽标
  'session.scopeAll': { zh: '全局会话 (全部项目)', en: 'All sessions (every project)' },
  'session.scopeCurrentNamed': { zh: '当前项目: {name}', en: 'Current project: {name}' },
  'session.scopeProject': { zh: '项目: {name}', en: 'Project: {name}' },
  'session.scopeHistory': { zh: '历史会话', en: 'Session History' },

  'session.emptyCurrent': {
    zh: '当前项目（{name}）暂无历史会话',
    en: 'No sessions in {name} yet',
  },
  'session.emptyProject': { zh: '项目 “{name}” 暂无历史会话', en: 'No sessions in "{name}" yet' },
  'session.viewAllProjects': {
    zh: '查看全部项目会话 ({n})',
    en: 'View sessions in all projects ({n})',
  },
  'session.viewCurrentProject': { zh: '查看当前项目 ({n})', en: 'View current project ({n})' },
  'session.emptyRecords': { zh: '暂无历史会话记录', en: 'No session history yet' },
  'session.unnamedProject': { zh: '未命名项目', en: 'Untitled Project' },

  // ══════════════════════════════════════════
  // 打开工作区（OpenWorkspaceModal）
  // ══════════════════════════════════════════
  'workspace.title': { zh: '打开工作区 (Open Workspace)', en: 'Open Workspace' },
  'workspace.desc': {
    zh: '选择工作区接入方式，或从历史记录秒级恢复上下文',
    en: 'Pick how to open a workspace, or restore context from history',
  },
  'workspace.recentTitle': { zh: '最近历史工程', en: 'Recent Projects' },
  'workspace.filterPh': { zh: '过滤工程名称或路径…', en: 'Filter by project name or path…' },
  'workspace.clearHistory': { zh: '清空记录', en: 'Clear History' },
  'workspace.emptyFiltered': {
    zh: '没有匹配的历史工作区',
    en: 'No matching recent workspaces',
  },
  'workspace.emptyRecent': { zh: '暂无最近打开历史记录', en: 'No recent workspaces yet' },
  'workspace.kindSsh': { zh: 'SSH', en: 'SSH' },
  'workspace.kindLocal': { zh: '本地', en: 'Local' },
  // 会话列表里工作区副标题的兜底文案（见 renderer/src/utils.ts 的 formatSessionWorkspaceLine）。
  // `badge` 复用 workspace.kindLocal：会话列表与最近列表上的「本地」是同一个词，
  // 拆成两条 key 迟早会只改一处。
  'session.wsUnbound': { zh: '未绑定工作区', en: 'No workspace' },
  'session.wsRemoteProject': { zh: '远程项目', en: 'Remote project' },
  'session.wsLocalProject': { zh: '本地项目', en: 'Local project' },
  // 技术栈徽章里只有这两个标识需要翻，具体语言名（Java/Go/…）两种语言写法相同。
  // 注意 TECH_STYLES 的**索引**仍是中文标识（会落盘、会被比较），翻的只是渲染出来的 label。
  'tech.generic': { zh: '通用', en: 'Generic' },
  'tech.directory': { zh: '目录', en: 'Folder' },
  'workspace.hintOpen': { zh: '打开', en: 'Open' },
  'workspace.hintRemote': { zh: '远程', en: 'Remote' },
  'workspace.hintClone': { zh: '克隆', en: 'Clone' },
  'workspace.hintWizard': { zh: '向导', en: 'Wizard' },
  'workspace.currentBadge': { zh: '正在使用', en: 'In Use' },
  'workspace.currentBadgeTitle': {
    zh: '当前正在使用的工作区',
    en: 'The workspace currently in use',
  },
  'workspace.copyPathOk': { zh: '已复制路径！', en: 'Path copied!' },
  'workspace.copyPath': { zh: '复制工作区路径', en: 'Copy workspace path' },
  'workspace.removeRecent': { zh: '从历史记录中移除', en: 'Remove from history' },
  'workspace.footerHint': {
    zh: '提示：点击任意条目立即无缝接入工作区',
    en: 'Tip: click any entry to open that workspace instantly',
  },

  // ══════════════════════════════════════════
  // SSH 连接（SshConnectModal）
  // ══════════════════════════════════════════
  'ssh.title': { zh: 'SSH 远程连接', en: 'SSH Remote Connection' },
  'ssh.descForm': {
    zh: '填写主机与认证信息；密码不会写入磁盘',
    en: 'Enter the host and credentials — the password is never written to disk',
  },
  'ssh.descList': {
    zh: '选择已有服务器（含 ~/.ssh/config），或添加新连接',
    en: 'Pick a saved server (including ~/.ssh/config) or add a new connection',
  },
  'ssh.removeProfileTitle': { zh: '删除此配置', en: 'Delete this profile' },
  'ssh.host': { zh: '主机', en: 'Host' },
  'ssh.port': { zh: '端口', en: 'Port' },
  'ssh.username': { zh: '用户名', en: 'Username' },
  'ssh.password': { zh: '密码（可选）', en: 'Password (optional)' },
  'ssh.passwordPh': { zh: '会话内有效，不落盘', en: 'Valid for this session, never saved to disk' },
  'ssh.keyPath': { zh: '私钥路径（可选）', en: 'Private key path (optional)' },
  'ssh.passphrase': { zh: '私钥口令', en: 'Key passphrase' },
  'ssh.optional': { zh: '可选', en: 'Optional' },
  'ssh.profileName': { zh: '配置名称', en: 'Profile name' },
  'ssh.profileNamePh': { zh: '显示名称', en: 'Display name' },
  'ssh.saveProfile': {
    zh: '保存连接配置（不含密码）',
    en: 'Save this connection (without the password)',
  },
  'ssh.openMacSettings': {
    zh: '打开 macOS「系统设置 - 本地网络」',
    en: 'Open macOS System Settings → Local Network',
  },
  'ssh.cancel': { zh: '取消', en: 'Cancel' },
  'ssh.addServer': { zh: '添加服务器', en: 'Add Server' },
  'ssh.backToList': { zh: '返回列表', en: 'Back to List' },
  'ssh.connecting': { zh: '连接中…', en: 'Connecting…' },
  'ssh.next': { zh: '下一步', en: 'Next' },

  'ssh.pickDirTitle': { zh: '选择远程工作区目录', en: 'Choose a Remote Workspace Folder' },
  'ssh.pickDirDesc': {
    zh: '浏览选择服务器目录，或通过路径栏直接定位后作为工作区打开',
    en: 'Browse the server for a folder, or type a path directly and open it as the workspace',
  },
  'ssh.remoteHostPath': { zh: '远程主机路径', en: 'Remote host path' },
  'ssh.gotoPathTitle': { zh: '跳转至该路径 (Enter)', en: 'Go to this path (Enter)' },
  'ssh.editPathHint': {
    zh: '双击此处或点击右侧按钮直接编辑路径',
    en: 'Double-click here or use the button on the right to edit the path',
  },
  'ssh.rootDir': { zh: '根目录 /', en: 'Root /' },
  'ssh.inputPathTitle': { zh: '直接输入路径', en: 'Type a path' },
  'ssh.parentDir': { zh: '上一级', en: 'Up One Level' },
  'ssh.parentDirTitle': { zh: '返回上一级目录', en: 'Go to the parent folder' },
  'ssh.homeTitle': {
    zh: '前往用户 Home 目录 (~)',
    en: 'Go to the user home directory (~)',
  },
  'ssh.showHiddenTitleOff': {
    zh: '已显示隐藏文件夹，点击隐藏',
    en: 'Hidden folders are shown — click to hide',
  },
  'ssh.showHiddenTitleOn': { zh: '显示隐藏文件夹 ({n})', en: 'Show hidden folders ({n})' },
  'ssh.hide': { zh: '隐藏', en: 'Hide' },
  'ssh.showHidden': { zh: '显示隐藏', en: 'Show Hidden' },
  'ssh.refreshDirTitle': { zh: '刷新当前目录', en: 'Refresh this folder' },
  'ssh.filterPh': { zh: '快速搜索子文件夹...', en: 'Filter subfolders...' },
  'ssh.clearSearch': { zh: '清除搜索', en: 'Clear search' },
  'ssh.dirCount': { zh: '共 {n} 个子目录', en: '{n} subfolders' },
  'ssh.dirCountMatch': { zh: ' (匹配 {matched}/{total})', en: ' ({matched} of {total})' },
  'ssh.reading': { zh: ' (读取中…)', en: ' (loading…)' },
  'ssh.readingList': { zh: '正在读取远程目录列表…', en: 'Reading the remote directory…' },
  'ssh.loadDirFailed': { zh: '读取远程目录失败', en: 'Failed to read the remote directory' },
  'ssh.emptyFiltered': {
    zh: '未找到与「{q}」匹配的文件夹',
    en: 'No folders match "{q}"',
  },
  'ssh.emptyHidden': {
    zh: '当前目录仅有 {n} 个系统/隐藏文件夹（已被隐藏）',
    en: 'This folder only contains {n} system/hidden folders (currently hidden)',
  },
  'ssh.emptyDir': { zh: '当前目录下无子文件夹', en: 'No subfolders in this folder' },
  'ssh.emptySubHidden': {
    zh: '可点击上方「显示隐藏」查看隐藏文件夹，或直接点击下方打开此目录',
    en: 'Use "Show Hidden" above to reveal hidden folders, or open this folder below',
  },
  'ssh.emptySub': {
    zh: '您可以直接点击下方「打开工作区」将当前路径作为工程打开',
    en: 'Click "Open Workspace" below to open the current path as a project',
  },
  'ssh.rowTitle': {
    zh: '单击选中，双击进入: {path}',
    en: 'Click to select, double-click to enter: {path}',
  },
  'ssh.rowTagHidden': { zh: '隐藏', en: 'Hidden' },
  'ssh.dblClickEnter': { zh: '双击进入', en: 'Double-click to enter' },
  'ssh.tipBar': {
    zh: '单击选中路径，双击可进入下级目录',
    en: 'Click to select a path, double-click to enter a subfolder',
  },
  'ssh.back': { zh: '返回', en: 'Back' },
  'ssh.target': { zh: '目标:', en: 'Target:' },
  'ssh.opening': { zh: '打开中…', en: 'Opening…' },
  'ssh.openBtn': { zh: '打开「{name}」', en: 'Open "{name}"' },

  'ssh.deleteTitle': { zh: '删除 SSH 配置', en: 'Delete SSH Profile' },
  'ssh.deleteIntro': {
    zh: '这条配置会从列表里移除，且无法撤销。**服务器上的文件不受影响。**',
    en: 'This profile is removed from the list and cannot be undone. **Files on the server are unaffected.**',
  },
  'ssh.detailHost': { zh: '主机', en: 'Host' },
  'ssh.detailUser': { zh: '用户', en: 'User' },
  'ssh.unknown': { zh: '未知', en: 'Unknown' },
  'ssh.notSpecified': { zh: '（未指定）', en: '(not specified)' },
  'ssh.confirmDelete': { zh: '确认删除', en: 'Delete' },

  // ══════════════════════════════════════════
  // 克隆仓库（CloneRepoModal）
  // ══════════════════════════════════════════
  'clone.title': { zh: 'Clone 远程仓库', en: 'Clone Remote Repository' },
  'clone.subtitle': {
    zh: '从 GitHub、GitLab、Gitee 或私有 Git 仓库克隆至本地，并立即打开为项目工作区',
    en: 'Clone from GitHub, GitLab, Gitee or a private Git repo, then open it as the workspace',
  },
  'clone.urlLabel': { zh: '仓库 URL (Repository URL)', en: 'Repository URL' },
  'clone.pasteFromClipboard': { zh: '从剪贴板粘贴', en: 'Paste from Clipboard' },
  'clone.pasteTitle': {
    zh: '尝试从系统剪贴板快速填入 URL',
    en: 'Try to fill the URL from the system clipboard',
  },
  'clone.urlPh': {
    zh: '例如: https://github.com/owner/repo.git 或 git@github.com:...',
    en: 'e.g. https://github.com/owner/repo.git or git@github.com:...',
  },
  'clone.presetHint': { zh: '快捷填入:', en: 'Quick fill:' },
  'clone.presetGitee': { zh: 'Gitee (码云)', en: 'Gitee' },
  'clone.projectNameLabel': { zh: '项目名:', en: 'Project:' },
  'clone.parentDirLabel': {
    zh: '目标存储文件夹 (Parent Directory)',
    en: 'Parent Directory',
  },
  'clone.parentDirHint': {
    zh: '将在该目录下自动创建项目文件夹',
    en: 'The project folder is created inside this directory',
  },
  'clone.parentDirPh': {
    zh: '点击右侧按钮选择或手动输入父目录',
    en: 'Pick a folder on the right, or type the parent directory',
  },
  'clone.browse': { zh: '浏览…', en: 'Browse…' },
  'clone.previewTitle': { zh: '📁 克隆后工作区路径预览:', en: '📁 Workspace path preview:' },
  'clone.previewAuto': {
    zh: '✓ 自动生成新目录',
    en: '✓ New folder created automatically',
  },
  'clone.branchLabel': {
    zh: '检出分支 / 标签 (Branch / Tag - 可选)',
    en: 'Checkout branch / tag (optional)',
  },
  'clone.branchHint': {
    zh: '留空默认拉取远程 HEAD 默认分支',
    en: 'Leave empty to use the remote default branch (HEAD)',
  },
  'clone.branchPh': {
    zh: '例如: main 或 master (留空自动拉取远程默认分支)',
    en: 'e.g. main or master (empty uses the remote default branch)',
  },
  'clone.branchPresetHint': { zh: '常用分支:', en: 'Common branches:' },
  'clone.clear': { zh: '清除', en: 'Clear' },
  'clone.failed': { zh: '克隆失败', en: 'Clone Failed' },
  'clone.suggest': {
    zh: '建议：请检查仓库 URL 是否正确、网络环境与代理配置，以及私有仓库的 SSH 密钥或访问权限。',
    en: 'Suggestion: check the repository URL, your network and proxy settings, and the SSH key or access rights for private repositories.',
  },
  'clone.terminalTitle': {
    zh: 'Terminal · Git Clone 进度与实时日志',
    en: 'Terminal · Git Clone progress & live log',
  },
  'clone.cloningStatus': { zh: '正在克隆中…', en: 'Cloning…' },
  'clone.logPlaceholder': {
    zh: '$ git clone --progress ...\n正在连接远程主机并检索仓库元数据...',
    en: '$ git clone --progress ...\nConnecting to the remote host and fetching repository metadata...',
  },
  'clone.hotkey': { zh: '💡 快捷键:', en: '💡 Shortcuts:' },
  'clone.cancel': { zh: '取消', en: 'Cancel' },
  'clone.cloneAction': { zh: '克隆', en: 'Clone' },
  'clone.cloning': { zh: '正在克隆…', en: 'Cloning…' },
  'clone.start': { zh: '开始克隆 (Clone)', en: 'Start Clone' },
  'clone.pickDirFailed': { zh: '选择目录失败: {msg}', en: 'Failed to pick a directory: {msg}' },
  'clone.errorDetail': {
    zh: 'Git 克隆发生错误，请检查仓库地址与访问权限',
    en: 'Git clone failed — check the repository URL and access rights',
  },
  'clone.errorException': { zh: '克隆操作遇到异常', en: 'The clone operation hit an exception' },

  // ══════════════════════════════════════════
  // 新建工程向导（NewProjectWizardModal）
  // ══════════════════════════════════════════
  'workspace.wizardTitle': {
    zh: '新建工程模板向导 (New Project Wizard)',
    en: 'New Project Wizard',
  },
  'workspace.wizardDesc': {
    zh: '选择技术栈、定义项目名称与存储位置，一键生成现代化工程标准模板',
    en: 'Pick a stack, name the project, choose a location — scaffold a modern project in one click',
  },
  'workspace.techSection': { zh: '选择技术栈 (TECHNOLOGY)', en: 'TECHNOLOGY' },
  'workspace.projectNameLabel': { zh: '项目名称 (Project Name)', en: 'Project Name' },
  'workspace.projectNameHint': {
    zh: '自动创建同名根目录',
    en: 'A root folder with the same name is created',
  },
  'workspace.projectNamePh': { zh: '例如: my-awesome-project', en: 'e.g. my-awesome-project' },
  'workspace.parentDirLabel': { zh: '存储位置 (Parent Directory)', en: 'Parent Directory' },
  'workspace.parentDirHint': {
    zh: '指定父级工程存放目录',
    en: 'Where the project folder will be created',
  },
  'workspace.parentDirPh': {
    zh: '例如: /Users/username/Projects',
    en: 'e.g. /Users/username/Projects',
  },
  'workspace.browse': { zh: '📁 浏览…', en: '📁 Browse…' },
  'workspace.willGenerateAt': {
    zh: '即将生成至: {path}',
    en: 'Will be created at: {path}',
  },
  'workspace.pickParentAndName': {
    zh: '请选择父目录与项目名',
    en: 'Choose a parent directory and a project name',
  },
  'workspace.scaffoldPreview': {
    zh: '工程生成结构预览 (Scaffold Preview):',
    en: 'Scaffold preview:',
  },
  'workspace.fileCount': { zh: '{n} 个文件', en: '{n} files' },
  'workspace.noParentDir': { zh: '[未选择上级目录]', en: '[no parent directory selected]' },
  'workspace.cancel': { zh: '取消', en: 'Cancel' },
  'workspace.creating': { zh: '生成中...', en: 'Creating...' },
  'workspace.openHere': { zh: '在当前窗口打开', en: 'Open in This Window' },
  'workspace.openNew': { zh: '在新窗口打开', en: 'Open in New Window' },
  'workspace.openHereTitle': {
    zh: '生成并在当前 IDE 窗口切换至该工程',
    en: 'Create the project and switch this IDE window to it',
  },
  'workspace.openNewTitle': {
    zh: '生成并在全新的 IDE 独立窗口中打开',
    en: 'Create the project and open it in a new IDE window',
  },
  'workspace.pickDirFailed': { zh: '选择目录失败', en: 'Failed to pick a directory' },
  'workspace.needParentDir': { zh: '请选择存储目录', en: 'Choose a storage directory' },
  'workspace.needParentDirDetail': {
    zh: '请指定工程将要创建的上级位置',
    en: 'Specify the parent directory where the project will be created',
  },
  'workspace.needProjectName': { zh: '请输入项目名称', en: 'Enter a project name' },
  'workspace.needProjectNameDetail': {
    zh: '项目名称不能为空',
    en: 'The project name cannot be empty',
  },
  'workspace.invalidProjectName': { zh: '项目名称不合法', en: 'Invalid project name' },
  'workspace.invalidProjectNameDetail': {
    zh: '项目名称包含非法字符，请勿包含斜杠或特殊符号',
    en: 'The project name contains invalid characters — avoid slashes and special symbols',
  },
  'workspace.createOk': { zh: '{name} 工程创建成功', en: '{name} project created' },
  'workspace.createOkDetail': { zh: '已生成在: {path}', en: 'Created at: {path}' },
  'workspace.createFailed': { zh: '创建工程失败', en: 'Failed to create the project' },

  // ══════════════════════════════════════════
  // 切换工作区（SwitchWorkspaceModal）
  // ══════════════════════════════════════════
  'workspace.switchTitle': { zh: '打开工作区', en: 'Open Workspace' },
  'workspace.switchSubtitle': {
    zh: '选择打开「{name}」的方式',
    en: 'Choose how to open "{name}"',
  },
  'workspace.openHereOption': { zh: '在当前窗口打开', en: 'Open in Current Window' },
  'workspace.openHereOptionDesc': {
    zh: '切换并替换当前工作区',
    en: 'Switch to this workspace, replacing the current one',
  },
  'workspace.openNewOption': { zh: '在新窗口打开', en: 'Open in New Window' },
  'workspace.openNewOptionDesc': {
    zh: '保留当前工程，在新窗口独立打开',
    en: 'Keep the current project and open this one in a new window',
  },

  // ══════════════════════════════════════════
  // 未保存更改（UnsavedChangesModal）
  // ══════════════════════════════════════════
  'workspace.untitledFile': { zh: '未命名 {name}', en: 'Untitled {name}' },
  'workspace.unsavedNewFile': { zh: '未保存的新建文件', en: 'Unsaved new file' },
  'workspace.saveChangesTitle': {
    zh: '是否保存对 “{name}” 的更改？',
    en: 'Save the changes to "{name}"?',
  },
  'workspace.saveChangesDesc': {
    zh: '如果不保存，您在此文件中所做的更改将会丢失。',
    en: "If you don't save, your changes to this file will be lost.",
  },
  'workspace.cancelCloseTitle': { zh: '取消关闭 (Esc)', en: 'Cancel closing (Esc)' },
  'workspace.cancelCloseHint': {
    zh: '取消关闭，继续编辑 (Esc)',
    en: 'Cancel closing and keep editing (Esc)',
  },
  'workspace.dontSave': { zh: '不保存', en: "Don't Save" },
  'workspace.dontSaveTitle': {
    zh: '不保存，直接关闭并放弃修改',
    en: 'Close without saving and discard the changes',
  },
  'workspace.saving': { zh: '保存中...', en: 'Saving...' },
  'workspace.saveTitle': {
    zh: '保存文件修改并关闭 (Enter)',
    en: 'Save the file and close (Enter)',
  },

  // ══════════════════════════════════════════
  // 内核搜索栏 / 命令面板（TopSearchBar）
  // ══════════════════════════════════════════
  'search.placeholderLineJump': {
    zh: '输入行号快速跳转… (当前文件: {path})',
    en: 'Type a line number to jump… (current file: {path})',
  },
  'search.placeholderLineJumpNoFile': {
    zh: '输入行号以跳转… (当前未打开活动文件)',
    en: 'Type a line number to jump… (no active file)',
  },
  'search.placeholderActions': {
    zh: '输入关键字搜索全局动作与命令…',
    en: 'Type to search global actions and commands…',
  },
  'search.placeholderCode': {
    zh: '搜索全文代码片段与符号…',
    en: 'Search code snippets and symbols…',
  },
  'search.placeholderFiles': {
    zh: '搜索文件… (输入 > 搜命令，@ 搜代码，: 跳行，Tab 切换)',
    en: 'Search files… (> for commands, @ for code, : to jump to a line, Tab to switch)',
  },
  'search.clearTitle': { zh: '清空搜索', en: 'Clear search' },
  'search.tabActions': { zh: '动作', en: 'Actions' },
  'search.tabFiles': { zh: '文件', en: 'Files' },
  'search.tabCode': { zh: '代码', en: 'Code' },
  'search.searchingAll': { zh: '正在全力搜索中…', en: 'Searching…' },
  'search.tagJump': { zh: '跳转', en: 'Jump' },
  'search.jumpToLineN': { zh: '跳转至第 {n} 行', en: 'Jump to line {n}' },
  'search.jumpHint': {
    zh: '输入目标行号并按回车… (例如 :42)',
    en: 'Type a target line and press Enter… (e.g. :42)',
  },
  'search.kbdJump': { zh: '↵ 跳转', en: '↵ to jump' },
  'search.noActiveFile': {
    zh: '当前未打开任何编辑文件，无法按行跳转',
    en: 'No file is open, so line jumping is unavailable',
  },
  'search.typeToFindFile': {
    zh: '键入文件名或路径片段快速定位文件',
    en: 'Type a file name or path fragment to locate a file',
  },
  'search.noMatch': { zh: '未找到匹配的结果', en: 'No matches found' },
  'search.openFileTitle': { zh: '打开文件 {path}', en: 'Open file {path}' },
  'search.matchesInFile': { zh: '{n} 处匹配', en: '{n} matches' },
  'search.kbdSelect': { zh: '选择', en: 'select' },
  'search.kbdRun': { zh: '执行', en: 'run' },
  'search.kbdSwitchMode': { zh: '模式切换', en: 'switch mode' },
  'search.kbdCommandTip': { zh: '输入 > 搜索全局命令', en: 'Type > to search commands' },
  'search.kbdCommand': { zh: '命令', en: 'command' },
  'search.kbdCodeTip': { zh: '输入 @ 搜索代码符号', en: 'Type @ to search code symbols' },
  'search.kbdCode': { zh: '代码', en: 'code' },
  'search.kbdLineTip': { zh: '输入 : 行号跳转', en: 'Type : to jump to a line' },
  'search.kbdLine': { zh: '跳行', en: 'line' },
  'search.kbdExit': { zh: '退出', en: 'exit' },
  'search.modeLineJump': { zh: '行号直达模式', en: 'Line jump mode' },
  'search.footerActions': { zh: '{n} 个动作指令', en: '{n} actions' },
  'search.footerFiles': { zh: '{n} 个文件匹配', en: '{n} matching files' },
  'search.footerCode': {
    zh: '{n} 个文件 · {m} 处匹配代码',
    en: '{n} files · {m} code matches',
  },

  // ══════════════════════════════════════════
  // 三方合并（ThreeWayMergeModal）
  // ══════════════════════════════════════════
  'merge.title': { zh: '三方合并编辑器 (3-Way Merge)', en: '3-Way Merge Editor' },
  'merge.resolvedCount': {
    zh: '{done}/{total} 冲突已解决',
    en: '{done}/{total} conflicts resolved',
  },
  'merge.acceptAllCurrentTitle': {
    zh: '全部采纳当前分支修改 (Accept All Current)',
    en: 'Accept all changes from the current branch',
  },
  'merge.acceptAllCurrent': { zh: '全部采纳当前', en: 'Accept All Current' },
  'merge.acceptAllIncomingTitle': {
    zh: '全部采纳传入分支修改 (Accept All Incoming)',
    en: 'Accept all changes from the incoming branch',
  },
  'merge.acceptAllIncoming': { zh: '全部采纳传入', en: 'Accept All Incoming' },
  'merge.keepBothTitle': { zh: '全部保留双方修改', en: 'Keep the changes from both sides' },
  'merge.keepBoth': { zh: '保留双方', en: 'Keep Both' },
  'merge.prevConflict': { zh: '上一处冲突', en: 'Previous conflict' },
  'merge.nextConflict': { zh: '下一处冲突', en: 'Next conflict' },
  'merge.closeTitle': { zh: '关闭三方合并视图', en: 'Close the 3-way merge view' },
  'merge.currentBranch': {
    zh: '当前分支 (Current / Ours - HEAD)',
    en: 'Current branch (Ours - HEAD)',
  },
  'merge.acceptThisSideTitle': {
    zh: '为当前冲突采纳此侧',
    en: 'Take this side for the current conflict',
  },
  'merge.acceptThisSide': { zh: '✓ 采纳此侧', en: '✓ Take This Side' },
  'merge.baseBranch': {
    zh: '基底版本 (Base / Common Ancestor)',
    en: 'Base version (common ancestor)',
  },
  'merge.acceptBaseTitle': {
    zh: '为当前冲突采纳基底',
    en: 'Take the base for the current conflict',
  },
  'merge.acceptBase': { zh: '✓ 采纳基底', en: '✓ Take Base' },
  'merge.incomingBranch': { zh: '传入分支 (Incoming / Theirs)', en: 'Incoming branch (Theirs)' },
  'merge.resultTitle': { zh: '最终合并结果 (Result)', en: 'Merged result' },
  'merge.resultHint': {
    zh: '可直接在此编辑器中二次手动微调',
    en: 'You can fine-tune the result right here',
  },
  'merge.currentChoice': {
    zh: '当前冲突 [{index}/{total}] 抉择：',
    en: 'Conflict [{index}/{total}] choice:',
  },
  'merge.choiceCurrent': { zh: '已选当前', en: 'Current' },
  'merge.choiceIncoming': { zh: '已选传入', en: 'Incoming' },
  'merge.choiceBoth': { zh: '保留双方', en: 'Both' },
  'merge.choiceBase': { zh: '已选基底', en: 'Base' },
  'merge.choiceUnresolved': { zh: '未抉择', en: 'Unresolved' },
  'merge.pendingNote': {
    zh: '⚠️ 尚有 {n} 处冲突未做选择，未选择处将保留原有冲突标记',
    en: '⚠️ {n} conflicts are still unresolved — those keep their original conflict markers',
  },
  'merge.allResolved': {
    zh: '✓ 所有冲突已全部完成抉择，可以安全写回文件',
    en: '✓ All conflicts resolved — safe to write back to the file',
  },
  'merge.cancel': { zh: '取消', en: 'Cancel' },
  'merge.saveAndFinish': { zh: '完成合并并保存文件', en: 'Finish Merge & Save' },
  'merge.noCurrentText': { zh: '// 当前冲突块无内容', en: '// no content on this side' },
  'merge.noBaseText': {
    zh: '// 共同祖先基底无文本差异或未启用 diff3',
    en: '// no base text differences, or diff3 is not enabled',
  },
  'merge.noIncomingText': { zh: '// 传入冲突块无内容', en: '// no content on the incoming side' },

  // ══════════════════════════════════════════
  // 文件提交历史（FileHistoryModal）
  // ══════════════════════════════════════════
  'history.title': { zh: '文件提交历史 (Git File History)', en: 'Git File History' },
  'history.searchPh': {
    zh: '搜索提交信息、作者或哈希 (支持 ↑↓ 选择，回车查看差异)...',
    en: 'Search message, author or hash (↑↓ to navigate, Enter for the diff)...',
  },
  'history.changeCount': { zh: '共 {n} 次变更', en: '{n} changes' },
  'history.loading': { zh: '正在获取文件历史记录...', en: 'Loading file history...' },
  'history.noCommittedHistory': {
    zh: '该文件暂无已提交的 Git 历史记录',
    en: 'This file has no committed Git history yet',
  },
  'history.fetchFailed': { zh: '获取文件历史失败', en: 'Failed to fetch file history' },
  'history.noMatch': { zh: '未找到匹配的提交记录', en: 'No matching commits' },
  'history.noHistory': { zh: '暂无提交历史', en: 'No commit history' },
  'history.noHistoryNote': {
    zh: '若此文件为新添加尚未 commit，或者刚执行 git init，则不会产生文件历史。',
    en: 'A file that was just added without a commit, or a repo right after git init, has no file history.',
  },
  'history.diffBtn': { zh: '比对差异 (Diff)', en: 'Diff' },
  'history.diffLoading': { zh: '加载中…', en: 'Loading…' },
  'history.commitDesc': { zh: '提交 {hash} - {path}', en: 'Commit {hash} - {path}' },
  'history.parentCommitTitle': { zh: '父提交 ({hash}^)', en: 'Parent commit ({hash}^)' },
  'history.commitTitle': { zh: '提交 {hash}', en: 'Commit {hash}' },
  'history.diffLoadFailed': {
    zh: '无法加载该提交的代码差异',
    en: 'Failed to load the diff for this commit',
  },
  'history.diffError': {
    zh: '获取提交差异发生异常',
    en: 'An error occurred while fetching the commit diff',
  },
  'history.footerHint': {
    zh: '提示：点击任意提交或按 Enter 可直接对比当前版本与该提交的文件 Diff',
    en: 'Tip: click a commit or press Enter to diff it against the working copy',
  },
  'history.escClose': { zh: 'Esc 关闭', en: 'Esc to close' },

  // ══════════════════════════════════════════
  // Composer 跨文件重构（ComposerModal）
  // ══════════════════════════════════════════
  'composer.title': { zh: 'Composer 跨文件重构器', en: 'Composer Multi-file Refactor' },
  'composer.rulesTip': {
    zh: '.echolyrules 规范已注入当前任务',
    en: '.echolyrules rules injected into this task',
  },
  'composer.placeholder': {
    zh: '描述您要执行的跨文件多模块修改，例如：将项目所有 API 请求重构成使用统一的 requestClient 拦截器，并补充完整 TypeScript 类型 (⌘↵ 发送)...',
    en: 'Describe the multi-file change you want, e.g. refactor every API call to use a shared requestClient interceptor and add the missing TypeScript types (⌘↵ to send)...',
  },
  'composer.hotkeyHint': {
    zh: '快捷键：按 ⌘↵ 提交执行 | Esc 取消',
    en: 'Shortcuts: ⌘↵ to run · Esc to cancel',
  },
  'composer.running': { zh: '重构中...', en: 'Refactoring...' },
  'composer.start': { zh: '开始重构', en: 'Start Refactoring' },
  'composer.statusInit': {
    zh: '正在初始化 Composer 跨文件重构任务...',
    en: 'Initializing the Composer refactor task...',
  },
  'composer.statusTool': { zh: '正在执行跨模块文件变更...', en: 'Applying cross-file changes...' },
  'composer.statusThinking': { zh: '思考与规划中...', en: 'Thinking and planning...' },
  'composer.statusStartFailed': {
    zh: '启动失败，请检查网络或配置',
    en: 'Failed to start — check your network or settings',
  },
  'composer.changedFiles': { zh: '涉及变更文件 ({n})', en: 'Changed files ({n})' },
  'composer.pendingReview': { zh: '({n} 待审查)', en: '({n} pending review)' },
  'composer.acceptAll': { zh: '✓ 全部采纳 (⌘↵)', en: '✓ Accept All (⌘↵)' },
  'composer.rejectAll': { zh: '✕ 全部放弃', en: '✕ Reject All' },
  'composer.emptyHint': {
    zh: '在上方输入要重构的需求，Composer 将跨越多个文件生成差异对比卡片',
    en: 'Describe the refactor above — Composer will produce diff cards across multiple files',
  },
  'composer.openFileTitle': {
    zh: '点击在编辑器中打开此文件',
    en: 'Click to open this file in the editor',
  },
  'composer.accepted': { zh: '已采纳', en: 'Accepted' },
  'composer.rejected': { zh: '已放弃', en: 'Rejected' },
  'composer.accept': { zh: '采纳', en: 'Accept' },
  'composer.reject': { zh: '放弃', en: 'Reject' },

  // ══════════════════════════════════════════
  // 问题与诊断（ProblemsPanel）
  // ══════════════════════════════════════════
  'problems.title': { zh: '诊断与问题 ({n})', en: 'Problems & Diagnostics ({n})' },
  'problems.filterAll': { zh: '全部', en: 'All' },
  'problems.filterError': { zh: '仅错误', en: 'Errors' },
  'problems.filterWarning': { zh: '仅警告', en: 'Warnings' },
  'problems.filterPh': { zh: '过滤消息或文件...', en: 'Filter messages or files...' },
  'problems.diagnoseAllTitle': {
    zh: '一键让 AI 批量诊断修复',
    en: 'Ask AI to diagnose and fix everything',
  },
  'problems.refreshTitle': { zh: '刷新诊断结果', en: 'Refresh diagnostics' },
  'problems.allGood': {
    zh: '未发现任何错误或警告，代码运行良好！',
    en: 'No errors or warnings — the code looks good!',
  },
  'problems.fileProblemCount': { zh: '({n} 个问题)', en: '({n} problems)' },
  'problems.fixTitle': {
    zh: '让 AI 针对此问题生成修复建议',
    en: 'Ask AI for a fix for this problem',
  },
  'problems.fix': { zh: '⚡️ AI 修复', en: '⚡️ AI Fix' },

  // ══════════════════════════════════════════
  // Claude 扩展面板（ClaudePanel / ClaudeChatPanel）
  // ══════════════════════════════════════════
  'ext.claudeLoading': { zh: '加载 Claude 插件...', en: 'Loading the Claude extension...' },
  'ext.claudeLoadUiFailed': { zh: '无法加载扩展界面', en: 'Failed to load the extension UI' },
  'ext.claudeLoadFailed': { zh: '加载失败', en: 'Failed to load' },
  'ext.claudeLoadFailedDetail': { zh: '加载失败: {msg}', en: 'Failed to load: {msg}' },
  'ext.claudeUnknownError': { zh: '未知错误', en: 'Unknown error' },
  'ext.claudeClose': { zh: '关闭', en: 'Close' },
  'ext.claudePreparing': { zh: '准备加载...', en: 'Preparing to load...' },
  'ext.claudeWaitingHtml': { zh: '等待加载 HTML 文件...', en: 'Waiting for the HTML file...' },
  'ext.claudeFileLabel': { zh: 'File: {name}', en: 'File: {name}' },
  'ext.claudeNotSet': { zh: '(未设置)', en: '(not set)' },
  'ext.claudeChatEmptyTitle': { zh: '开始与 Claude 对话', en: 'Start chatting with Claude' },
  'ext.claudeChatEmptyHint': {
    zh: '输入消息开始对话，Claude 将帮助你完成编程任务',
    en: 'Type a message to begin — Claude will help you with coding tasks',
  },
  'ext.claudeChatPlaceholder': {
    zh: '输入消息... (Enter 发送，Shift+Enter 换行)',
    en: 'Type a message... (Enter to send, Shift+Enter for a newline)',
  },
  'ext.claudeChatSend': { zh: '发送', en: 'Send' },
  'ext.claudeChatError': { zh: '错误: {msg}', en: 'Error: {msg}' },
  'ext.claudeChatSendFailed': { zh: '发送消息失败', en: 'Failed to send the message' },

  // ══════════════════════════════════════════
  // 终端 AI 命令生成条（TerminalAiKBar）
  // ══════════════════════════════════════════
  'terminalAi.placeholder': {
    zh: '向 AI 描述命令需求，例如: 查找占用 8080 端口的进程并杀死、拉取最新代码并合并...',
    en: 'Describe the command you need, e.g. find and kill the process on port 8080, pull the latest code and merge...',
  },
  'terminalAi.generating': { zh: '生成中...', en: 'Generating...' },
  'terminalAi.regenerate': { zh: '重新生成', en: 'Regenerate' },
  'terminalAi.generate': { zh: '生成 (↵)', en: 'Generate (↵)' },
  'terminalAi.copyTitle': { zh: '复制命令', en: 'Copy command' },
  // {enter} 与 {esc} 会渲染成 <kbd>，所以整句进字典、由 translateSegments 切出强调片段
  'terminalAi.runHint': {
    zh: '按 {enter} 执行，{esc} 退出',
    en: 'Press {enter} to run, {esc} to exit',
  },
  'terminalAi.insertTitle': {
    zh: '粘贴到终端中（不自动回车）',
    en: 'Insert into the terminal (without pressing Enter)',
  },
  'terminalAi.insert': { zh: '仅插入 (⇧↵)', en: 'Insert Only (⇧↵)' },
  'terminalAi.runTitle': { zh: '立即在终端中执行命令', en: 'Run the command in the terminal now' },
  'terminalAi.run': { zh: '立即执行 (↵)', en: 'Run Now (↵)' },
  'terminalAi.generateFailed': {
    zh: '生成终端命令失败，请重试',
    en: 'Failed to generate the command — please retry',
  },

  // ══════════════════════════════════════════
  // 内置浏览器（BrowserViewPane）
  // ══════════════════════════════════════════
  'browser.back': { zh: '后退 (Alt+Left)', en: 'Back (Alt+Left)' },
  'browser.forward': { zh: '前进 (Alt+Right)', en: 'Forward (Alt+Right)' },
  'browser.stop': { zh: '停止加载', en: 'Stop loading' },
  'browser.reload': { zh: '重新加载 (Cmd/Ctrl+R)', en: 'Reload (Cmd/Ctrl+R)' },
  'browser.home': {
    zh: '首页 (显示新标签页，不打开任何地址)',
    en: 'Home (show the new tab page, navigate nowhere)',
  },
  'browser.newTabTitle': { zh: '新建浏览器标签页', en: 'New browser tab' },
  'browser.addressPh': {
    zh: '输入网址或页面路由 (如 localhost:5173，按回车访问)...',
    en: 'Enter a URL or route (e.g. localhost:5173, press Enter to visit)...',
  },
  'browser.inspectActiveTitle': {
    zh: '正在选取元素 (点击页面任意元素，按 Esc 取消)',
    en: 'Picking an element (click any element, Esc to cancel)',
  },
  'browser.inspectIdleTitle': {
    zh: '检查元素：直接选取页面特定元素引用到聊天框',
    en: 'Inspect element: pick a specific element and reference it in the chat',
  },
  'browser.quotePageTitle': {
    zh: '将当前页面标签引用到聊天框',
    en: 'Reference this page in the chat',
  },
  'browser.devtoolsCloseTitle': {
    zh: '关闭下方 Google 控制台 (Chrome DevTools)',
    en: 'Close the Chrome DevTools console below',
  },
  'browser.devtoolsOpenTitle': {
    zh: '在下方展开 Google 控制台 (Chrome DevTools)',
    en: 'Open the Chrome DevTools console below',
  },
  'browser.devtoolsResizeTitle': {
    zh: '上下拖动调整控制台高度（按住并上下拖拽）',
    en: 'Drag up or down to resize the console',
  },
  'browser.passwordManagerSavedTitle': {
    zh: '密码管理器：此站点已保存 {n} 个账号密码 (点击查看/一键填入)',
    en: 'Password manager: {n} saved logins for this site (click to view / autofill)',
  },
  'browser.passwordManagerTitle': {
    zh: '密码管理器：查看与管理此站点保存的密码',
    en: 'Password manager: view and manage saved passwords for this site',
  },
  'browser.openExternalTitle': {
    zh: '在系统外部浏览器中打开',
    en: 'Open in the system browser',
  },
  'browser.inspectExited': { zh: '已退出元素选取模式', en: 'Element picking mode turned off' },
  'browser.inspectPrompt': {
    zh: '请点击页面中的目标元素进行引用 (↑/↓ 切换父/子级，Esc 退出)',
    en: 'Click the target element to reference it (↑/↓ for parent/child, Esc to exit)',
  },
  // 下面两条画在**被浏览页面的顶部**（由 buildInspectScript 注入的提示条与尺寸标签）。
  // 它们不在 React 树里，所以由渲染层取好文案再传进注入脚本。
  'browser.inspectHint': {
    zh: '元素选取中：点击引用 · ↑ 选父级 · ↓ 选子级 · Esc 取消',
    en: 'Picking element: click to reference · ↑ parent · ↓ child · Esc to cancel',
  },
  // 尺寸标签上的匹配数后缀，`{n}` 由注入脚本替换。整句进字典，不做 ' · 匹配 ' + n + ' 个' 拼接。
  'browser.inspectMatchCount': { zh: ' · 匹配 {n} 个', en: ' · {n} matches' },
  'browser.picked': { zh: '已拾取元素 {label}', en: 'Picked element {label}' },
  'browser.pickedWithDuplicate': {
    zh: '已拾取元素 {label} (选择器命中 {n} 个同类元素)',
    en: 'Picked element {label} ({n} similar elements match the selector)',
  },
  'browser.quotedPage': {
    zh: '已将标签页 "{title}" 引用至 AI 对话',
    en: 'Referenced tab "{title}" in the AI chat',
  },
  'browser.inspectBanner': {
    zh: '元素检查选取模式已开启：移动鼠标查看元素高亮，点击即可精准引用至聊天框',
    en: 'Element picking is on: move the mouse to highlight elements, click to reference one in the chat',
  },
  'browser.exitEsc': { zh: '退出 (Esc)', en: 'Exit (Esc)' },

  'browser.savePasswordTitle': { zh: '保存此网站的密码？', en: 'Save the password for this site?' },
  'browser.updatePasswordTitle': {
    zh: '更新此网站的密码？',
    en: 'Update the password for this site?',
  },
  'browser.closeTitle': { zh: '关闭', en: 'Close' },
  'browser.siteLabel': { zh: '站点：', en: 'Site:' },
  'browser.accountLabel': { zh: '用户名 / 账号', en: 'Username / account' },
  'browser.accountPh': {
    zh: '未识别到用户名，可手动输入',
    en: 'Username not detected — you can type it manually',
  },
  'browser.passwordLabel': { zh: '密码', en: 'Password' },
  'browser.notNow': { zh: '暂不', en: 'Not Now' },
  'browser.save': { zh: '保存', en: 'Save' },
  'browser.update': { zh: '更新', en: 'Update' },
  'browser.passwordSaved': { zh: '已保存该站点的账号密码', en: 'Saved the login for this site' },
  'browser.passwordUpdated': { zh: '已更新该站点的密码', en: 'Updated the password for this site' },
  'browser.savedPasswords': { zh: '已保存的密码 ({n})', en: 'Saved passwords ({n})' },
  'browser.currentSite': { zh: '当前站点：', en: 'Current site:' },
  'browser.noActivePage': { zh: '无活动网页', en: 'No active page' },
  'browser.noSavedCredentials': {
    zh: '当前站点尚未保存账号密码',
    en: 'No saved logins for this site yet',
  },
  'browser.unnamedAccount': { zh: '未命名账号', en: 'Unnamed account' },
  'browser.autofillTitle': { zh: '自动填入当前登录页', en: 'Autofill the current login form' },
  'browser.fill': { zh: '填入', en: 'Fill' },
  'browser.autofilled': { zh: '已自动填入账号 {name}', en: 'Autofilled account {name}' },
  'browser.deleteCredentialTitle': { zh: '删除此凭据', en: 'Delete this credential' },
  'browser.credentialDeleted': { zh: '已删除该账号凭据', en: 'Credential deleted' },
  'browser.passwordPrefix': { zh: '密码：', en: 'Password:' },
  'browser.show': { zh: '显示', en: 'Show' },
  'browser.hide': { zh: '隐藏', en: 'Hide' },

  'browser.newTabSubtitle': {
    zh: '输入网址或页面路由，按回车即可立即访问',
    en: 'Enter a URL or route and press Enter to visit it',
  },
  'browser.searchPh': {
    zh: '搜索或输入网址 (如 localhost:5173、:3000、域名等)...',
    en: 'Search or enter a URL (e.g. localhost:5173, :3000, a domain)...',
  },
  'browser.go': { zh: '前往', en: 'Go' },
  'browser.tilesHeader': { zh: '本地开发服务与常用磁贴', en: 'Local dev services & shortcuts' },
  'browser.tileTitle': { zh: '点击立即前往 {url} ({tip})', en: 'Click to open {url} ({tip})' },
  'browser.tileViteLabel': { zh: '⚡ 本地服务 (5173)', en: '⚡ Local service (5173)' },
  'browser.tileViteTip': { zh: 'Vite 开发服务', en: 'Vite dev server' },
  'browser.tileNodeLabel': { zh: '⚛️ 本地服务 (3000)', en: '⚛️ Local service (3000)' },
  'browser.tileNodeTip': { zh: 'Node / React 服务', en: 'Node / React server' },
  'browser.tileSpringLabel': { zh: '☕ 本地服务 (8080)', en: '☕ Local service (8080)' },
  'browser.tileSpringTip': { zh: 'Spring / 后端 API 服务', en: 'Spring / backend API server' },
  'browser.tileGoogleLabel': { zh: '🔍 Google 搜索', en: '🔍 Google Search' },
  'browser.tileGoogleTip': { zh: '搜索引擎', en: 'Search engine' },
  'browser.tileGithubLabel': { zh: '🐙 GitHub', en: '🐙 GitHub' },
  'browser.tileGithubTip': { zh: '代码托管与开源平台', en: 'Code hosting & open source platform' },

  'browser.loadFailTitle': { zh: '无法访问此网页', en: "This page can't be reached" },
  'browser.connectFailed': { zh: '无法连接到该地址', en: 'Cannot connect to this address' },
  // {url} 渲染成等宽的 <code>，所以整句进字典
  'browser.cannotConnect': { zh: '无法连接至 {url}', en: 'Cannot connect to {url}' },
  'browser.portTypoHint': {
    zh: '提示：端口可能是笔误（573 少输入了 1），当前机器活跃开发服务在 {port} 端口。',
    en: 'Tip: the port may be a typo (573 is missing a 1) — the active dev server on this machine is on port {port}.',
  },
  'browser.loadFailDetail': {
    zh: '{desc} ({code})。如果这是本地开发项目，请确认服务已在对应端口启动。',
    en: '{desc} ({code}). If this is a local project, make sure the service is running on that port.',
  },
  'browser.openActiveService': {
    zh: '立即打开活跃服务 (http://localhost:5173)',
    en: 'Open the active dev server (http://localhost:5173)',
  },
  'browser.retry': { zh: '重试加载当前地址', en: 'Retry this address' },
};
