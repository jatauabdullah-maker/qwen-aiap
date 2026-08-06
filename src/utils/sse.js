const { StringDecoder } = require('node:string_decoder')

/**
 * 解析单个 SSE frame。
 * 支持 event/id/retry 以及多行 data 字段；注释行会被忽略。
 * @param {string} rawFrame
 * @returns {{event: string|null, data: string, id: string|null, retry: number|null, raw: string}|null}
 */
const parseSSEFrame = (rawFrame) => {
    if (typeof rawFrame !== 'string') return null

    let event = null
    let id = null
    let retry = null
    const dataLines = []
    let hasField = false

    for (const line of rawFrame.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue

        const colonIndex = line.indexOf(':')
        const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
        let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
        if (value.startsWith(' ')) value = value.slice(1)

        if (field === 'data') {
            dataLines.push(value)
            hasField = true
        } else if (field === 'event') {
            event = value || null
            hasField = true
        } else if (field === 'id') {
            id = value
            hasField = true
        } else if (field === 'retry') {
            const parsedRetry = Number.parseInt(value, 10)
            retry = Number.isFinite(parsedRetry) ? parsedRetry : null
            hasField = true
        }
    }

    if (!hasField) return null
    return { event, data: dataLines.join('\n'), id, retry, raw: rawFrame }
}

/**
 * 增量 SSE 解码器。TCP 分块可以落在 UTF-8 字符、字段名、JSON 或空行中的任意位置。
 */
class SSEDecoder {
    constructor() {
        this.decoder = new StringDecoder('utf8')
        this.buffer = ''
    }

    /**
     * @param {Buffer|string|Uint8Array} chunk
     * @returns {Array<ReturnType<typeof parseSSEFrame>>}
     */
    push(chunk) {
        if (chunk !== undefined && chunk !== null) {
            this.buffer += typeof chunk === 'string'
                ? chunk
                : this.decoder.write(Buffer.from(chunk))
        }
        return this.#drain(false)
    }

    /**
     * 冲刷 UTF-8 decoder，并按 SSE 规范分派 EOF 前尚未带空行的最后一个事件。
     * @returns {Array<ReturnType<typeof parseSSEFrame>>}
     */
    end() {
        this.buffer += this.decoder.end()
        return this.#drain(true)
    }

    #drain(flush) {
        const frames = []

        while (this.buffer.length > 0) {
            const boundary = this.buffer.match(/\r?\n\r?\n/)
            if (!boundary || boundary.index === undefined) break

            const rawFrame = this.buffer.slice(0, boundary.index)
            this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
            const parsed = parseSSEFrame(rawFrame)
            if (parsed) frames.push(parsed)
        }

        if (flush && this.buffer.trim()) {
            const parsed = parseSSEFrame(this.buffer)
            if (parsed) frames.push(parsed)
            this.buffer = ''
        }

        return frames
    }
}

/**
 * 把解析后的事件重新编码为规范 SSE。用于安全透传，不依赖上游 TCP 分块方式。
 * @param {{event?: string|null, data?: string, id?: string|null, retry?: number|null}} frame
 * @returns {string}
 */
const formatSSEFrame = (frame = {}) => {
    const lines = []
    if (frame.event) lines.push(`event: ${frame.event}`)
    if (frame.id !== null && frame.id !== undefined) lines.push(`id: ${frame.id}`)
    if (frame.retry !== null && frame.retry !== undefined) lines.push(`retry: ${frame.retry}`)

    const data = typeof frame.data === 'string' ? frame.data : String(frame.data ?? '')
    for (const line of data.split('\n')) {
        lines.push(`data: ${line}`)
    }
    return `${lines.join('\n')}\n\n`
}

/**
 * 串行消费 Node readable 中的 SSE。for-await 会等待 onFrame，避免 end 事件越过异步 data handler。
 * @param {AsyncIterable<Buffer|string>} stream
 * @param {(frame: ReturnType<typeof parseSSEFrame>) => Promise<void>|void} onFrame
 * @returns {Promise<{sawDone: boolean, eventCount: number}>}
 */
const consumeSSEStream = async (stream, onFrame) => {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
        throw new TypeError('上游响应不是可读取的异步流')
    }

    const decoder = new SSEDecoder()
    let sawDone = false
    let eventCount = 0

    const consumeFrames = async (frames) => {
        for (const frame of frames) {
            eventCount += 1
            if (frame.data.trim() === '[DONE]') sawDone = true
            await onFrame(frame)
        }
    }

    for await (const chunk of stream) {
        await consumeFrames(decoder.push(chunk))
    }
    await consumeFrames(decoder.end())

    return { sawDone, eventCount }
}

module.exports = {
    SSEDecoder,
    parseSSEFrame,
    formatSSEFrame,
    consumeSSEStream
}
