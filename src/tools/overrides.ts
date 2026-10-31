import type { Rclone, RcloneResult } from '../client.js'
import type { JsonSchema } from './registry.js'

type Fields = Record<string, unknown>

/** Per-route changes to the tools that the registry generates from the spec. Keyed by operationId. */
export type Override = {
    /** Input fields that this server consumes. They're never sent to rclone. */
    localFields?: Record<string, JsonSchema>
    /** Local fields that a call has to include. */
    requiredLocalFields?: string[]
    /** Changes rclone's response before it goes to the client. */
    transform?(data: unknown, local: Fields): unknown
    /** Replaces the JSON call, for a route that doesn't take a JSON body. */
    send?(rclone: Rclone, path: string, fields: Fields, local: Fields): Promise<RcloneResult>
}

const DEFAULT_JOB_LIMIT = 100
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

type JobList = { jobids?: number[]; runningIds?: number[]; finishedIds?: number[] }
type UploadFile = { name: string; content: string; encoding?: 'utf8' | 'base64' }

export const OVERRIDES: Record<string, Override> = {
    // A server that keeps jobs for a long time can return thousands of IDs, which is more than some
    // clients can take. Rclone also returns them in random order, so they need sorting to be useful.
    jobList: {
        localFields: {
            limit: {
                type: 'integer',
                minimum: 1,
                default: DEFAULT_JOB_LIMIT,
                description: `The most job IDs to return from each list, starting from the newest. Defaults to ${DEFAULT_JOB_LIMIT}. \`runningTotal\` and \`finishedTotal\` give the full counts. Every call to rclone counts as a job, including this one and job_status, so the newest IDs aren't always work you started.`,
            },
            status: {
                type: 'string',
                enum: ['running', 'finished'],
                description: 'Return only the running jobs, or only the finished ones.',
            },
        },
        transform(data, { limit = DEFAULT_JOB_LIMIT, status }) {
            if (!isObject(data)) return data
            // `jobids` is only the other two lists put together, so it's left out.
            const { jobids: _jobids, runningIds = [], finishedIds = [], ...rest } = data as JobList
            const newest = (ids: number[]) =>
                [...ids].sort((a, b) => a - b).slice(-(limit as number))
            return {
                ...rest,
                ...(status === 'finished'
                    ? {}
                    : { runningIds: newest(runningIds), runningTotal: runningIds.length }),
                ...(status === 'running'
                    ? {}
                    : { finishedIds: newest(finishedIds), finishedTotal: finishedIds.length }),
            }
        },
    },

    // A failed item in a batch repeats its request in `input`, even though the batch returns 200,
    // and that request can hold the passwords that were just sent.
    jobBatch: {
        transform(data) {
            if (!isObject(data) || !Array.isArray(data.results)) return data
            return {
                ...data,
                results: data.results.map((item: unknown) => {
                    if (!isObject(item)) return item
                    const { input: _input, ...rest } = item
                    return rest
                }),
            }
        },
    },

    // Rclone reads this route's files from a multipart form, and skips any part with no file name
    // while still returning 200. Taking names and contents here means that can't happen.
    operationsUploadfile: {
        localFields: {
            files: {
                type: 'array',
                minItems: 1,
                description: 'The files to upload into the directory that `remote` names.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', minLength: 1, description: 'The file name.' },
                        content: { type: 'string', description: 'The contents of the file.' },
                        encoding: {
                            type: 'string',
                            enum: ['utf8', 'base64'],
                            default: 'utf8',
                            description: 'How `content` is encoded. Use `base64` for binary files.',
                        },
                    },
                    required: ['name', 'content'],
                    additionalProperties: false,
                },
            },
        },
        requiredLocalFields: ['files'],
        send(rclone, path, fields, local) {
            const form = new FormData()
            for (const file of local.files as UploadFile[]) {
                // Buffer.from skips anything it can't decode, which would write a corrupt file.
                if (file.encoding === 'base64' && !BASE64.test(file.content)) {
                    throw new Error(`The content of ${file.name} isn't valid base64`)
                }
                const bytes = Buffer.from(file.content, file.encoding ?? 'utf8')
                form.append('file', new Blob([bytes]), file.name)
            }
            return rclone.upload(path, fields, form)
        },
    },
}
