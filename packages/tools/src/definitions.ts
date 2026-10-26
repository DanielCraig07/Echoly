import type { ToolDefinition } from '@deepseek-ide/shared';

export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories under a relative path in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative directory path. Defaults to workspace root.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Optionally read a line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          offset: { type: 'integer', description: '1-based start line' },
          limit: { type: 'integer', description: 'Max number of lines to read' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file_lines',
      description:
        'Read a 1-based line range of a file (cheaper than read_file for large files). Returns numbered lines plus total line count.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          offset: { type: 'integer', description: '1-based start line (default 1)' },
          limit: { type: 'integer', description: 'Max number of lines to return (default 200)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a text file with full content. Prefer apply_patch for edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply surgical edits to an existing file. Prefer the `edits` array to make several independent ' +
        'replacements in one call. Each `old_text` must match the file exactly (including indentation) and ' +
        'must be unique in the file — if it occurs more than once the edit is rejected, so include enough ' +
        'surrounding context to disambiguate, or set `replace_all: true` to intentionally replace every ' +
        'occurrence. The single `old_text`/`new_text` form is still accepted as a shorthand for one edit.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: {
            type: 'string',
            description: 'Shorthand for a single edit. Must be unique in the file.',
          },
          new_text: { type: 'string', description: 'Replacement for `old_text`.' },
          edits: {
            type: 'array',
            description: 'Ordered list of independent replacements applied to the same file.',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string', description: 'Exact text to find in the file.' },
                new_text: {
                  type: 'string',
                  description: 'Replacement text (may be empty to delete).',
                },
                replace_all: {
                  type: 'boolean',
                  description:
                    'Replace every occurrence instead of requiring uniqueness. Default false.',
                },
              },
              required: ['old_text', 'new_text'],
            },
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Search file contents in the workspace using a regex or plain text pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          glob: { type: 'string', description: 'Optional glob filter, e.g. **/*.{ts,tsx}' },
          path: { type: 'string', description: 'Subdirectory to search' },
          case_insensitive: { type: 'boolean' },
          max_results: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description: 'Find files by glob pattern relative to workspace.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. **/*.ts' },
          max_results: { type: 'integer' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_symbols',
      description:
        'List code symbol declarations (class/interface/function/type/enum/struct) across the workspace. ' +
        'Use this to locate a definition by name when you do not know which file holds it.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Substring to match against symbol names. Omit to list all symbols.',
          },
          path: { type: 'string', description: 'Subdirectory to search' },
          max_results: { type: 'integer', description: 'Default 50' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codebase_search',
      description:
        'Semantic-ish natural-language search over the indexed codebase (function/class/doc chunks). ' +
        'Better than search_code when you are looking for behavior ("where is auth token refreshed") ' +
        'rather than an exact string. Requires the workspace index; returns the best-matching chunks.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language description of what you are looking for',
          },
          limit: { type: 'integer', description: 'Max chunks to return (default 20)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description:
        'Read the current compiler/linter errors and warnings for the workspace (LSP diagnostics). ' +
        'Call this after editing files to verify the change did not break the build, then fix what it reports.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Restrict to a single relative file path. Omit for the whole workspace.',
          },
          max_results: { type: 'integer', description: 'Default 100' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_path',
      description:
        'Delete a file or directory (recursively) inside the workspace. Requires user confirmation unless permission is allow_all.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path to delete' },
          recursive: {
            type: 'boolean',
            description: 'Set true to delete a directory and its contents.',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_path',
      description:
        'Move or rename a file/directory inside the workspace. Requires user confirmation unless permission is allow_all.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Existing relative path' },
          to: { type: 'string', description: 'Destination relative path' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_terminal',
      description:
        'Run a shell command inside the workspace. Prefer readonly commands. Destructive commands may require user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: {
            type: 'integer',
            description: 'Timeout in ms, default 300000 (5 min). Clamped to the range 5000–300000.',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        'Ask the user a confirmation or clarifying question before proceeding. Prefer short options for choices; user can also type a free-text answer.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['terminal', 'write', 'delete', 'other'],
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional quick-select choices shown above the chat input',
          },
          allow_input: {
            type: 'boolean',
            description: 'Allow free-text answer. Default true for clarifying questions.',
          },
        },
        required: ['title', 'detail'],
      },
    },
  },
];

export const READONLY_TOOL_NAMES = new Set([
  'list_dir',
  'read_file',
  'read_file_lines',
  'search_code',
  'search_symbols',
  'codebase_search',
  'get_diagnostics',
  'glob_files',
  'ask_user',
]);

/** 会产生文件系统副作用的工具：权限门控与运行后自检都以此为准。 */
export const WRITE_TOOL_NAMES = new Set(['write_file', 'apply_patch', 'delete_path', 'move_path']);

/**
 * 宿主注入的 MCP 工具：定义来自远端服务器，我们只知道名字和 schema。
 *
 * `readonlyNames` 必须由宿主显式给出：MCP 协议里没有任何字段能说明一个工具会不会改数据，
 * 所以「只读」是用户的声明而不是我们的推断。名字不在这个集合里的工具，
 * 在 Ask / Plan 模式下**不会**出现 —— 默认不放行，避免用户以为 Plan 模式一定安全。
 */
export interface McpToolSet {
  definitions: ToolDefinition[];
  readonlyNames: Iterable<string>;
}

export function toolsForMode(mode: 'ask' | 'plan' | 'agent', mcp?: McpToolSet): ToolDefinition[] {
  const mcpDefs = mcp?.definitions ?? [];
  if (mode === 'agent') return [...AGENT_TOOL_DEFINITIONS, ...mcpDefs];
  const readonlyExtra = new Set(mcp?.readonlyNames ?? []);
  return [...AGENT_TOOL_DEFINITIONS, ...mcpDefs].filter(
    (t) => READONLY_TOOL_NAMES.has(t.function.name) || readonlyExtra.has(t.function.name),
  );
}
