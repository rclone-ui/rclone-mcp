import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
    CallToolRequestSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
} from '@modelcontextprotocol/sdk/types.js'
import pkg from '../package.json'
import type { Tool } from './tools/registry.js'

export const serverVersion = pkg.version

/**
 * Creates one MCP server for a set of tools. This uses the low-level `Server`, because `McpServer`
 * only takes Zod schemas, and the tools already have JSON Schemas from the spec.
 */
export function createMcpServer(tools: Tool[]): Server {
    const server = new Server(
        { name: 'rclone-mcp', version: serverVersion },
        { capabilities: { tools: {} } }
    )
    const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
    const listing = tools.map(({ run: _run, ...tool }) => tool)

    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listing }))
    server.setRequestHandler(CallToolRequestSchema, ({ params }, extra) => {
        const tool = toolsByName.get(params.name)
        if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${params.name}`)
        // A client that cancels a call cancels it in rclone too.
        return tool.run(params.arguments ?? {}, extra.signal)
    })

    return server
}
