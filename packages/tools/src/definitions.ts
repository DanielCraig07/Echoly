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
        'Apply a structured patch to an existing file by replacing old_text with new_text (first occurrence).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
        },
        required: ['path', 'old_text', 'new_text'],
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
      name: 'run_terminal',
      description:
        'Run a shell command inside the workspace. Prefer readonly commands. Destructive commands may require user confirmation.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          timeout_ms: { type: 'integer', description: 'Timeout in ms, default 60000' },
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
  'search_code',
  'glob_files',
  'ask_user',
]);

export function toolsForMode(mode: 'ask' | 'plan' | 'agent'): ToolDefinition[] {
  if (mode === 'agent') return AGENT_TOOL_DEFINITIONS;
  return AGENT_TOOL_DEFINITIONS.filter((t) => READONLY_TOOL_NAMES.has(t.function.name));
}
