export {
  MCP_PROTOCOL_VERSION,
  MCP_CLIENT_INFO,
  MCP_ERROR,
  LineJsonRpcDecoder,
  flattenMcpContent,
  mcpToolName,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
} from './protocol.js';
export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcSuccess,
  JsonRpcFailure,
} from './protocol.js';

export {
  StdioMcpTransport,
  McpTransportClosedError,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from './transport.js';
export type { StdioTransportOptions } from './transport.js';

export { McpManager, MAX_TOOLS_PER_SERVER } from './manager.js';
export type { McpServerConfig, McpToolInfo, McpServerStatus } from './manager.js';
