const test = require('node:test')
const assert = require('node:assert/strict')

const {
  parseToolCallsFromText,
  createToolCallStreamParser,
  createNativeToolCallAccumulator
} = require('../src/utils/tool-prompt.js')

test('stream parser accepts split valid calls and preserves JSON string arguments', () => {
  const parser = createToolCallStreamParser({ allowedToolNames: ['read_file'] })
  const first = parser.push('before<tool_')
  const second = parser.push('call>{"name":"read_file","arguments":"{\\"path\\":\\"a\\"}"}</tool_call>')
  const tail = parser.flush()

  assert.equal(first.textDelta, 'before')
  assert.equal(second.completedCalls.length, 1)
  assert.equal(second.completedCalls[0].function.arguments, '{"path":"a"}')
  assert.equal(tail.textDelta, '')
  assert.equal(parser.hasParseError(), false)
})

test('truncated and unknown tool calls become explicit parser errors', () => {
  const truncated = createToolCallStreamParser({ allowedToolNames: ['read_file'] })
  truncated.push('<tool_call>{"name":"read_file","arguments":{"path":"a')
  truncated.flush()
  assert.equal(truncated.hasEmittedAnyCall(), false)
  assert.equal(truncated.hasParseError(), true)

  const unknown = parseToolCallsFromText(
    '<tool_call>{"name":"missing","arguments":{}}</tool_call>',
    { allowedToolNames: ['read_file'] }
  )
  assert.equal(unknown.toolCalls.length, 0)
  assert.equal(unknown.errors[0].type, 'unknown_tool')
})

test('native tool accumulator rebuilds fragmented OpenAI tool deltas', () => {
  const accumulator = createNativeToolCallAccumulator({ allowedToolNames: ['read_file'] })
  accumulator.push([{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } }])
  accumulator.push([{ index: 0, function: { arguments: '{"path":' } }])
  accumulator.push([{ index: 0, function: { arguments: '"a"}' } }])

  const calls = accumulator.finalize()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].id, 'call_1')
  assert.equal(calls[0].function.arguments, '{"path":"a"}')
  assert.equal(accumulator.hasParseError(), false)
})
