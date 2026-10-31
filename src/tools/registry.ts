import { createRequire } from 'node:module'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RCDClient } from 'rclone-sdk'
import { z } from 'zod'
import { INPUT_AUGMENTATIONS, POST_PROCESSORS, type PostProcessor } from './overrides.js'
import { camelToSnake, getToolsetForPath, isReadOnly } from './toolsets.js'

// Use createRequire to load the bundled JSON spec from rclone-openapi
const require = createRequire(import.meta.url)

type OpenApiParam = {
    name: string
    in: string
    description?: string
    required?: boolean
    schema?: {
        type?: string
        items?: Record<string, unknown>
        [key: string]: unknown
    }
    [key: string]: unknown
}

type OpenApiOperation = {
    operationId: string
    summary?: string
    description?: string
    parameters?: (OpenApiParam | { $ref: string })[]
}

type OpenApiSpec = {
    paths: Record<string, { post?: OpenApiOperation }>
    components?: {
        parameters?: Record<string, OpenApiParam>
    }
}

function resolveRef(spec: OpenApiSpec, ref: string): OpenApiParam | undefined {
    // refs look like "#/components/parameters/SomeName"
    const parts = ref.replace('#/', '').split('/')
    let current: unknown = spec
    for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
            current = (current as Record<string, unknown>)[part]
        } else {
            return undefined
        }
    }
    return current as OpenApiParam
}

function resolveParam(
    spec: OpenApiSpec,
    param: OpenApiParam | { $ref: string }
): OpenApiParam | undefined {
    if ('$ref' in param && typeof param.$ref === 'string') {
        return resolveRef(spec, param.$ref)
    }
    return param as OpenApiParam
}

function openApiTypeToZod(schema: OpenApiParam['schema']): z.ZodTypeAny {
    if (!schema) return z.unknown()

    switch (schema.type) {
        case 'string':
            return z.string()
        case 'boolean':
            return z.boolean()
        case 'integer':
            return z.number().int()
        case 'number':
            return z.number()
        case 'array':
            return z.array(z.unknown())
        case 'object':
            return z.record(z.unknown())
        default:
            return z.unknown()
    }
}

function buildInputSchema(
    spec: OpenApiSpec,
    parameters: (OpenApiParam | { $ref: string })[]
): Record<string, z.ZodTypeAny> | undefined {
    const shape: Record<string, z.ZodTypeAny> = {}
    let hasParams = false

    for (const rawParam of parameters) {
        const param = resolveParam(spec, rawParam)
        if (!param || param.in !== 'query') continue

        let zodType = openApiTypeToZod(param.schema)

        if (param.description) {
            zodType = zodType.describe(param.description)
        }

        if (!param.required) {
            zodType = zodType.optional()
        }

        shape[param.name] = zodType
        hasParams = true
    }

    return hasParams ? shape : undefined
}

export function registerTools(
    server: McpServer,
    client: RCDClient,
    enabledToolsets: Set<string>,
    readOnly: boolean
): number {
    const spec: OpenApiSpec = require('rclone-openapi')
    let count = 0

    for (const [apiPath, pathItem] of Object.entries(spec.paths)) {
        const operation = pathItem.post
        if (!operation?.operationId) continue

        const toolset = getToolsetForPath(apiPath)
        if (!toolset || !enabledToolsets.has(toolset)) continue

        if (readOnly && !isReadOnly(operation.operationId)) continue

        const toolName = camelToSnake(operation.operationId)
        const description = [operation.summary, operation.description].filter(Boolean).join(' — ')
        const inputSchema = operation.parameters
            ? buildInputSchema(spec, operation.parameters)
            : undefined

        const augmentation: Record<string, z.ZodTypeAny> | undefined =
            INPUT_AUGMENTATIONS[operation.operationId]
        const augmentationKeys = augmentation ? new Set(Object.keys(augmentation)) : null
        const finalSchema = augmentation ? { ...(inputSchema ?? {}), ...augmentation } : inputSchema
        const postProcessor: PostProcessor | undefined = POST_PROCESSORS[operation.operationId]

        const cb = async (args: Record<string, unknown>) => {
            try {
                const queryParams: Record<string, unknown> = {}
                for (const [key, value] of Object.entries(args)) {
                    if (value === undefined) continue
                    // Augmented params are MCP-layer only; don't forward to rcd.
                    if (augmentationKeys?.has(key)) continue
                    queryParams[key] = value
                }

                const response = await (
                    client as unknown as {
                        POST: (
                            url: string,
                            init?: { params?: { query?: Record<string, unknown> } }
                        ) => Promise<{ data?: unknown; error?: unknown; response: Response }>
                    }
                ).POST(apiPath, {
                    params:
                        Object.keys(queryParams).length > 0 ? { query: queryParams } : undefined,
                })

                if (response.error) {
                    const errMsg =
                        typeof response.error === 'string'
                            ? response.error
                            : JSON.stringify(response.error, null, 2)
                    return {
                        isError: true as const,
                        content: [{ type: 'text' as const, text: 'Error: ' + errMsg }],
                    }
                }

                const data =
                    typeof postProcessor === 'function' && response.data !== undefined
                        ? postProcessor(response.data, args)
                        : response.data

                const text =
                    data !== undefined
                        ? JSON.stringify(data, null, 2)
                        : `OK (${response.response.status})`

                return {
                    content: [{ type: 'text' as const, text }],
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                return {
                    isError: true as const,
                    content: [{ type: 'text' as const, text: 'Request failed: ' + message }],
                }
            }
        }

        if (finalSchema) {
            server.tool(toolName, description, finalSchema, cb)
        } else {
            server.tool(toolName, description, cb)
        }

        count++
    }

    return count
}
