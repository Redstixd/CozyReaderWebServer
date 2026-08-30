// 回归测试：ranwen8.cc 书源正文是 base64 混淆（document.writeln(qsbs.bb('...'))），
// 由 ruleadapter.extractHtmlContent 的 @js: DSL 解码为中文纯文本，再经 cleanContent 切段。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import cheerio from 'cheerio'
import { extractHtmlContent, cleanContent } from '../lib/ruleadapter.js'

const here = dirname(fileURLToPath(import.meta.url))
const rules = JSON.parse(
  readFileSync(join(here, '..', 'so-novel', 'bundle', 'rules', 'main.json'), 'utf-8'),
)
const ranwen = rules.find((r) => r.url.includes('ranwen8'))
assert.ok(ranwen, 'ranwen8 rule exists in main.json')

// 从真实 fixture 取一段 base64 载荷（第一章开头）
const b64 =
  'PGJyIC8+Jm5ic3A7Jm5ic3A7Jm5ic3A7Jm5ic3A75Zub5Liq5Lq65pyA57uI5Zyo55Cq5Lqa5aic5Y+r5Zqj552A6KaB6L+95LiK5Y6755q'

test('ranwen8 chapter: @js: DSL decodes base64-obfuscated body', () => {
  // 模拟 #htmlContent 的 innerHTML：一段 <br> 打头的 script 混淆块
  const innerHtml =
    '<br><script>document.writeln(qsbs.bb(\'' + b64 + '\'));</script>'
  const $doc = cheerio.load(`<div id="htmlContent">${innerHtml}</div>`)

  const decoded = extractHtmlContent($doc, ranwen.chapter.content)

  // 原始 document.writeln 字符串必须被解码掉
  assert.equal(decoded.includes('document.writeln'), false, 'raw JS must be decoded away')
  assert.equal(decoded.includes('qsbs.bb'), false, 'base64 payload must be decoded')
  // 解出的应是 <br/> 打头的 HTML（含 &nbsp; 段首缩进），而非 JS
  assert.match(decoded, /<br/, 'decoded output is HTML with <br/>')
  assert.ok(/[\u4e00-\u9fff]/.test(decoded), 'decoded output contains Chinese text')
})

test('ranwen8 chapter: cleanContent splits decoded HTML into paragraphs and strips nbsp', () => {
  const innerHtml =
    '<br><script>document.writeln(qsbs.bb(\'' + b64 + '\'));</script>'
  const $doc = cheerio.load(`<div id="htmlContent">${innerHtml}</div>`)

  const decoded = extractHtmlContent($doc, ranwen.chapter.content)
  const text = cleanContent(decoded, ranwen.chapter)

  // 正文必须完全干净：无 document.writeln、无 <script>、无裸 &nbsp; 前缀
  assert.equal(text.includes('document.writeln'), false)
  assert.equal(text.includes('<script'), false)
  assert.equal(text.includes('&nbsp;'), false, 'no literal &nbsp; entity')
  // 段落为中文纯文本
  assert.match(text, /[\u4e00-\u9fff]/)
})