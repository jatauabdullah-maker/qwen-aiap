const test = require('node:test')
const assert = require('node:assert/strict')
const { PassThrough, Readable } = require('node:stream')

const {
  SSEDecoder,
  consumeSSEStream,
  formatSSEFrame
} = require('../src/utils/sse.js')

test('SSEDecoder handles arbitrary TCP, UTF-8 and CRLF boundaries', () => {
  const decoder = new SSEDecoder()
  const wire = Buffer.from(
    'event: content\r\ndata: {"text":"你好"}\r\n\r\n' +
    'data: first\ndata: second\n\n' +
    'data: [DONE]\n\n'
  )
  const frames = []
  for (let i = 0; i < wire.length; i += 3) {
    frames.push(...decoder.push(wire.subarray(i, i + 3)))
  }
  frames.push(...decoder.end())

  assert.equal(frames.length, 3)
  assert.equal(frames[0].event, 'content')
  assert.equal(frames[0].data, '{"text":"你好"}')
  assert.equal(frames[1].data, 'first\nsecond')
  assert.equal(frames[2].data, '[DONE]')
})

test('SSEDecoder dispatches the final event even without a trailing blank line', () => {
  const decoder = new SSEDecoder()
  assert.deepEqual(decoder.push('data: {"ok":true}'), [])
  const frames = decoder.end()
  assert.equal(frames.length, 1)
  assert.equal(frames[0].data, '{"ok":true}')
})

test('consumeSSEStream serializes async handlers before resolving', async () => {
  const stream = new PassThrough()
  const seen = []
  const consuming = consumeSSEStream(stream, async frame => {
    await new Promise(resolve => setTimeout(resolve, 10))
    seen.push(frame.data)
  })

  stream.end('data: one\n\ndata: two\n\ndata: [DONE]\n\n')
  const result = await consuming

  assert.deepEqual(seen, ['one', 'two', '[DONE]'])
  assert.equal(result.sawDone, true)
  assert.equal(result.eventCount, 3)
})

test('formatSSEFrame produces a frame that survives byte-by-byte decoding', async () => {
  const encoded = formatSSEFrame({ event: 'message', data: '第一行\n第二行', id: '42' })
  const frames = []
  await consumeSSEStream(Readable.from([...Buffer.from(encoded)].map(byte => Buffer.from([byte]))), frame => {
    frames.push(frame)
  })
  assert.equal(frames[0].event, 'message')
  assert.equal(frames[0].id, '42')
  assert.equal(frames[0].data, '第一行\n第二行')
})
