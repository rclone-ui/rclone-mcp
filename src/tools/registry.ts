import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import spec from 'rclone-openapi'
import type { Rclone, RcloneResult } from '../client.js'
import { OVERRIDES } from './overrides.js'
import {
    annotationsFor,
    camelToSnake,
    getToolsetForPath,
    isLongRunning,
    kindOf,
} from './toolsets.js'

export type JsonSchema = Record<string, unknown>

type InputSchema = {
    type: 'object'
    properties: JsonSchema
    required?: string[]
    additionalProperties: unknown
}

export type Tool = {
    name: string
    title?: string
    description: string
    inputSchema: InputSchema
    annotations: ToolAnnotations
    run(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>
}

export type ToolOptions = {
    toolsets: Set<string>
    readOnly: boolean
    /** The most characters of output a call returns. */
    maxOutput: number
}

type Parameter = {
    name: string
    in: string
    description?: string
    required?: boolean
    schema?: JsonSchema
}

type Operation = {
    operationId: string
    summary?: string
    description?: string
    parameters?: unknown[]
    requestBody?: { content?: Record<string, { schema?: JsonSchema }> }
    responses: Record<string, unknown>
}

const BACKGROUND_FIELD = 'run_in_background'
const BACKGROUND_SCHEMA = {
    type: 'boolean',
    description:
        'Start the call in the background and return a job ID right away, instead of waiting for it to finish. Check on it with job_status. Use this for anything that could take more than a few seconds.',
}

/** Replaces each `$ref` with what it points to, because MCP clients get no `components`. */
function resolveRefs<T>(node: T, seen: string[] = []): T {
    if (Array.isArray(node)) return node.map((item) => resolveRefs(item, seen)) as T
    if (!node || typeof node !== 'object') return node
    const ref = (node as { $ref?: string }).$ref
    if (ref) {
        if (seen.includes(ref)) throw new Error(`The spec has a circular reference at ${ref}`)
        const target = ref
            .slice(2)
            .split('/')
            .reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], spec)
        return resolveRefs(target as T, [...seen, ref])
    }
    return Object.fromEntries(
        Object.entries(node).map(([key, value]) => [key, resolveRefs(value, seen)])
    ) as T
}

/**
 * Merges a body's `allOf` into one object, because a tool's input has to be a plain object at the
 * top. Unless the spec says a route is open, unknown fields are rejected, since rclone would
 * ignore them without saying so.
 */
function bodyToInput(body: JsonSchema): InputSchema {
    const input: InputSchema = { type: 'object', properties: {}, additionalProperties: false }
    const required: string[] = []
    for (const part of (body.allOf as JsonSchema[] | undefined) ?? [body]) {
        Object.assign(input.properties, part.properties)
        required.push(...((part.required as string[] | undefined) ?? []))
        if (part.additionalProperties) input.additionalProperties = part.additionalProperties
    }
    if (required.length > 0) input.required = required
    return input
}

/** Builds a tool's input from query params, for the one route that isn't a JSON body. */
function queryToInput(parameters: Parameter[]): InputSchema {
    const query = parameters.filter((param) => param.in === 'query')
    const required = query.filter((param) => param.required).map((param) => param.name)
    return {
        type: 'object',
        properties: Object.fromEntries(
            query.map((param) => [param.name, { ...param.schema, description: param.description }])
        ),
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
    }
}

function failure(text: string): CallToolResult {
    return { isError: true, content: [{ type: 'text', text }] }
}

function describeError(error: unknown, status: number): string {
    if (status === 401) {
        return `Rclone rejected the login (${String(error).trim()}). Check RCLONE_USER and RCLONE_PASS.`
    }
    if (typeof error === 'string') return error
    // Rclone repeats the request in `input`, which can include the passwords that were just sent.
    const { input: _input, ...rest } = error as Record<string, unknown>
    return JSON.stringify(rest)
}

/** Names the fields at fault, which a model needs in order to correct its call. */
function describeInvalid(errors: ErrorObject[] | null | undefined): string {
    const problems = (errors ?? []).map(({ instancePath, message, params }) => {
        const field = (params as { additionalProperty?: string }).additionalProperty
        return `${instancePath || 'input'} ${message}${field ? `: ${field}` : ''}`
    })
    return `Invalid arguments: ${problems.join('; ')}`
}

function capped(data: unknown, status: number, maxOutput: number): CallToolResult {
    const text =
        data === undefined
            ? `OK (${status})`
            : typeof data === 'string'
              ? data
              : JSON.stringify(data)
    if (text.length <= maxOutput) return { content: [{ type: 'text', text }] }
    const note = `\n\n[Output cut to ${maxOutput} of ${text.length} characters. Ask for less, such as a smaller path or a filter. The limit is RCLONE_MCP_MAX_OUTPUT.]`
    return { content: [{ type: 'text', text: text.slice(0, maxOutput) + note }] }
}

/** Generates a tool for each route in the spec that the options allow. */
export function buildTools(rclone: Rclone, options: ToolOptions): Tool[] {
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    const paths = spec.paths as Record<string, { post?: Operation }>
    const tools: Tool[] = []

    for (const [path, { post: operation }] of Object.entries(paths)) {
        if (!operation?.operationId) continue

        const toolset = getToolsetForPath(path)
        if (!toolset || !options.toolsets.has(toolset)) continue
        if (options.readOnly && kindOf(path) !== 'read') continue

        const override = OVERRIDES[operation.operationId]
        const body = operation.requestBody?.content?.['application/json']?.schema
        const inputSchema = body
            ? bodyToInput(resolveRefs(body))
            : queryToInput(resolveRefs(operation.parameters ?? []) as Parameter[])

        const localFields: Record<string, JsonSchema> = { ...override?.localFields }
        if (isLongRunning(path) && operation.responses['202']) {
            localFields[BACKGROUND_FIELD] = BACKGROUND_SCHEMA
        }
        Object.assign(inputSchema.properties, localFields)
        if (override?.requiredLocalFields) {
            inputSchema.required = [
                ...(inputSchema.required ?? []),
                ...override.requiredLocalFields,
            ]
        }

        const validate = ajv.compile(inputSchema)

        tools.push({
            name: camelToSnake(operation.operationId),
            title: operation.summary,
            description: [operation.summary, operation.description].filter(Boolean).join(' — '),
            inputSchema,
            annotations: annotationsFor(path),
            async run(args, signal) {
                if (!validate(args)) return failure(describeInvalid(validate.errors))

                const versionProblem = await rclone.versionProblem()
                if (versionProblem) return failure(versionProblem)

                const fields: Record<string, unknown> = {}
                const local: Record<string, unknown> = {}
                for (const [key, value] of Object.entries(args)) {
                    if (value !== undefined) {
                        ;(Object.hasOwn(localFields, key) ? local : fields)[key] = value
                    }
                }

                try {
                    let result: RcloneResult
                    if (override?.send) {
                        result = await override.send(rclone, path, fields, local)
                    } else if (local[BACKGROUND_FIELD]) {
                        result = await rclone.background(path, fields)
                    } else {
                        result = await rclone.post(path, fields, signal)
                    }

                    if (result.error !== undefined) {
                        return failure(describeError(result.error, result.response.status))
                    }
                    // A job's response is its ID, so there's nothing for a transform to work on yet.
                    const data =
                        override?.transform && !local[BACKGROUND_FIELD]
                            ? override.transform(result.data, local)
                            : result.data
                    return capped(data, result.response.status, options.maxOutput)
                } catch (err) {
                    if (signal?.aborted) return failure('The call was cancelled.')
                    // fetch reports a failed connection as a TypeError with the reason in `cause`.
                    if (err instanceof TypeError && err.cause) {
                        return failure(
                            `The request to rclone at ${rclone.baseUrl} failed (${String(err.cause)}). ${rclone.unreachableHint}`
                        )
                    }
                    return failure(err instanceof Error ? err.message : String(err))
                }
            },
        })
    }

    return tools
}
