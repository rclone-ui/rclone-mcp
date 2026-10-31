import { z } from 'zod'

/**
 * Per-operation extensions to the generic OpenAPI-driven tool registration.
 *
 * The MCP exposes rcd endpoints by iterating the rclone-openapi spec and
 * generating a Zod schema from each endpoint's `query` parameters. That
 * works for the vast majority of endpoints, but a few have responses that
 * are too large to send back to an MCP client unfiltered (e.g. `job/list`
 * with a long `--rc-job-expire-duration`). For those, we add MCP-layer-only
 * parameters and a response post-processor here.
 *
 * INPUT_AUGMENTATIONS: extra Zod params merged into the OpenAPI-derived
 *   schema. Keyed by OpenAPI `operationId` (camelCase, matching what
 *   `registry.ts` iterates over). These params are NOT forwarded to rcd;
 *   the registry callback filters them out and the matching POST_PROCESSORS
 *   entry consumes them.
 *
 * POST_PROCESSORS: transforms the rcd response before it is serialized
 *   back to the MCP client. Receives the parsed `response.data` and the
 *   full `args` object (including augmented params). Returns the value
 *   to be serialized.
 */

export const INPUT_AUGMENTATIONS: Record<string, Record<string, z.ZodTypeAny>> = {
    jobList: {
        limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
                'Return only the most recent N entries in each array (`jobids`, `finishedIds`, `runningIds`). Without this param, all retained jobs are returned, which can be thousands of entries if the rcd uses a long `--rc-job-expire-duration` and may exceed an MCP client context limit.'
            ),
        activeOnly: z
            .boolean()
            .optional()
            .describe(
                'If true, return only `runningIds` (omit `jobids` and `finishedIds`). Useful for "what is in flight right now?" queries.'
            ),
        completedOnly: z
            .boolean()
            .optional()
            .describe(
                'If true, return only `finishedIds` (omit `jobids` and `runningIds`). Useful for "what has completed in the retention window?" queries.'
            ),
    },
}

export type PostProcessor = (data: unknown, args: Record<string, unknown>) => unknown

export const POST_PROCESSORS: Record<string, PostProcessor> = {
    jobList: (data, args) => {
        if (!data || typeof data !== 'object') return data
        const d = data as {
            jobids?: number[]
            finishedIds?: number[]
            runningIds?: number[]
            [k: string]: unknown
        }

        const limit = typeof args.limit === 'number' ? args.limit : undefined
        const activeOnly = args.activeOnly === true
        const completedOnly = args.completedOnly === true

        const sliceMaybe = (arr: number[] | undefined): number[] | undefined => {
            if (!Array.isArray(arr)) return arr
            return limit !== undefined ? arr.slice(-limit) : arr
        }

        // rclone's job/list returns three arrays: `jobids` (master set),
        // `finishedIds` (subset, completed), `runningIds` (subset, active).
        // jobids = finishedIds ∪ runningIds.
        //
        // - default: keep all three, with `limit` applied to each
        // - activeOnly: keep only runningIds
        // - completedOnly: keep only finishedIds
        //
        // Rebuild the output object so we can omit arrays without `delete`
        // (biome's noDelete prefers this shape).
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(d)) {
            if (k === 'jobids' || k === 'finishedIds' || k === 'runningIds') continue
            out[k] = v
        }

        if (!activeOnly && !completedOnly && Array.isArray(d.jobids)) {
            out.jobids = sliceMaybe(d.jobids)
        }
        if (!activeOnly && Array.isArray(d.finishedIds)) {
            out.finishedIds = sliceMaybe(d.finishedIds)
        }
        if (!completedOnly && Array.isArray(d.runningIds)) {
            out.runningIds = sliceMaybe(d.runningIds)
        }

        return out
    },
}
