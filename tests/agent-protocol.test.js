const test = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')

process.env.API_KEY = process.env.API_KEY || 'test-only-key'

const { createUpstreamDeltaNormalizer, formatHistoryMessages } = require('../src/utils/chat-helpers.js')
const {
  normalizeOpenAIFinishReason,
  handleStreamResponse,
  handleNonStreamResponse
} = require('../src/controllers/chat.js')
const {
  mapAnthropicStopReason,
  handleAnthropicStream,
  handleAnthropicNonStream
} = require('../src/controllers/anthropic.js')

test.after(() => {
  require('../src/utils/account.js').destroy()
})

const createMockResponse = () => ({
  output: '',
  headers: {},
  headersSent: false,
  writableEnded: false,
  statusCode: 200,
  set(headers) {
    Object.assign(this.headers, headers)
    return this
  },
  setHeader(name, value) {
    this.headers[name] = value
  },
  write(chunk) {
    this.headersSent = true
    this.output += String(chunk)
    return true
  },
  end(chunk = '') {
    if (chunk) this.write(chunk)
    this.writableEnded = true
  },
  status(code) {
    this.statusCode = code
    return this
  },
  json(value) {
    this.headersSent = true
    this.output += JSON.stringify(value)
    this.writableEnded = true
    return this
  }
})

test('phase-less answer content is not silently discarded', () => {
  const normalize = createUpstreamDeltaNormalizer()
  assert.deepEqual(normalize({ content: 'final answer' }), {
    phase: 'answer',
    content: 'final answer'
  })
  assert.deepEqual(normalize({ reasoning_content: 'thinking' }), {
    phase: 'think',
    content: 'thinking'
  })
})

test('finish reasons preserve truncation instead of reporting normal completion', () => {
  assert.equal(normalizeOpenAIFinishReason('length', false, true), 'length')
  assert.equal(normalizeOpenAIFinishReason(null, false, false), null)
  assert.equal(mapAnthropicStopReason('length', false, true), 'max_tokens')
  assert.equal(mapAnthropicStopReason(null, false, false), null)
  assert.equal(mapAnthropicStopReason('stop', true, true), 'tool_use')
})

test('history envelope preserves role and punctuation with JSONL', () => {
  const history = formatHistoryMessages([
    { role: 'system', content: 'keep: semicolons; intact' },
    { role: 'assistant', content: 'done; not really' }
  ])
  const lines = history.split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines, [
    { role: 'system', content: 'keep: semicolons; intact' },
    { role: 'assistant', content: 'done; not really' }
  ])
})

test('controller modules can consume fragmented terminal frames', async () => {
  const chunks = [
    Buffer.from('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"len'),
    Buffer.from('gth"}]}\r\n\r\ndata: [DO'),
    Buffer.from('NE]\r\n\r\n')
  ]
  const { consumeUpstream } = require('../src/controllers/anthropic.js')
  const seen = []
  const result = await consumeUpstream(Readable.from(chunks), json => seen.push(json))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].choices[0].finish_reason, 'length')
  assert.equal(result.sawDone, true)
})

test('OpenAI stream propagates length and rejects incomplete EOF', async () => {
  const completedRes = createMockResponse()
  await handleStreamResponse(
    completedRes,
    Readable.from([
      'data: {"choices":[{"delta":{"content":"partial answer"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ]),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(completedRes.output, /"finish_reason":"length"/)
  assert.doesNotMatch(completedRes.output, /"finish_reason":"stop"/)

  const incompleteRes = createMockResponse()
  await handleStreamResponse(
    incompleteRes,
    Readable.from(['data: {"choices":[{"delta":{"content":"cut"},"finish_reason":null}]}\n\n']),
    false,
    false,
    { messages: [] },
    {}
  )
  assert.match(incompleteRes.output, /"code":"upstream_incomplete"/)
  assert.doesNotMatch(incompleteRes.output, /"finish_reason":"stop"/)
})

test('Anthropic stream emits thinking signature, max_tokens and tool parse errors', async () => {
  const thinkingRes = createMockResponse()
  await handleAnthropicStream(
    thinkingRes,
    {
      message_id: 'msg_test',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [] }
    },
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"think","content":"reason"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
    ])
  )
  assert.match(thinkingRes.output, /"type":"signature_delta"/)
  assert.match(thinkingRes.output, /"stop_reason":"max_tokens"/)
  assert.match(thinkingRes.output, /event: message_stop/)

  const invalidToolRes = createMockResponse()
  await handleAnthropicStream(
    invalidToolRes,
    {
      message_id: 'msg_tool',
      model: 'qwen-test',
      hasTools: true,
      toolChoice: 'auto',
      allowedToolNames: ['read_file'],
      requestBody: { messages: [] }
    },
    Readable.from([
      'data: {"choices":[{"delta":{"phase":"answer","content":"<tool_call>{\\"name\\":\\"read_file\\",\\"arguments\\":{\\"path\\":\\""},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
    ])
  )
  assert.match(invalidToolRes.output, /event: error/)
  assert.match(invalidToolRes.output, /invalid_tool_call_error/)
  assert.doesNotMatch(invalidToolRes.output, /event: message_stop/)
})

test('non-stream responses preserve truncation for both protocols', async () => {
  const frames = [
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
  ]

  const openAIRes = createMockResponse()
  await handleNonStreamResponse(
    openAIRes,
    Readable.from(frames),
    false,
    false,
    'qwen-test',
    { messages: [] },
    {}
  )
  assert.match(openAIRes.output, /"finish_reason":"length"/)

  const anthropicRes = createMockResponse()
  await handleAnthropicNonStream(
    anthropicRes,
    {
      message_id: 'msg_nonstream',
      model: 'qwen-test',
      hasTools: false,
      requestBody: { messages: [] }
    },
    Readable.from(frames)
  )
  assert.match(anthropicRes.output, /"stop_reason":"max_tokens"/)
})
