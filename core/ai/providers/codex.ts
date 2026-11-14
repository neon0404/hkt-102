import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../../config'
import { type ImageResult, type LlmProvider, ProviderError, type StructuredRequest, type StructuredResult } from '../provider'

export class CodexProvider implements LlmProvider {
  name = 'chatgpt_account' as const

  async generateStructured(req: StructuredRequest): Promise<StructuredResult> {
    const dir = await mkdtemp(join(tmpdir(), 'aim-codex-'))
    const started = Date.now()
    try {
      const schemaPath = join(dir, 'schema.json')
      const outPath = join(dir, 'out.json')
      await writeFile(schemaPath, JSON.stringify(req.schema))
      const prompt = [
        'Ты работаешь как функция: получаешь задание и возвращаешь один JSON по заданной схеме.',
        'Не запускай команды, не читай и не создавай файлы, не ищи в интернете. Используй только текст ниже.',
        '',
        '# Правила',
        req.system,
        '',
        '# Задание и данные',
        req.user,
      ].join('\n')
      const run = await runCodex(
        ['-s', 'read-only', '--output-schema', schemaPath, '-o', outPath],
        prompt, dir, req.timeoutMs ?? 120_000,
      )
      let text = ''
      try { text = await readFile(outPath, 'utf8') }
      catch { text = run.lastMessage }
      let data: unknown
      try { data = JSON.parse(text) }
      catch { throw new ProviderError('invalid_response', `Ответ не является JSON: ${text.slice(0, 200)}`, this.name) }
      return {
        data, provider: this.name, model: run.model || config.codexModel || await codexDefaultModel() || 'codex',
        inputTokens: run.inputTokens, outputTokens: run.outputTokens, durationMs: Date.now() - started,
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  async generateImage(prompt: string): Promise<ImageResult | null> {
    const dir = await mkdtemp(join(tmpdir(), 'aim-codex-img-'))
    const started = Date.now()
    try {
      const task = [
        'Сгенерируй одно изображение встроенным инструментом генерации изображений и сохрани его в текущую папку под именем bg.png.',
        'Требования: квадратный формат, без текста и букв, без людей и лиц, без логотипов.',
        `Описание: ${prompt}`,
        'В ответе напиши только слово done.',
      ].join('\n')
      const run = await runCodex(['-s', 'workspace-write'], task, dir, 300_000)
      const png = await readFile(join(dir, 'bg.png')).catch(() => null) ?? await generatedImage(run.threadId)
      if (!png) {
        console.warn('[image] Codex не вернул картинку:', run.lastMessage.slice(0, 200))
        return null
      }
      return {
        png, provider: this.name, model: run.model || config.codexModel || await codexDefaultModel() || 'codex', durationMs: Date.now() - started,
        inputTokens: run.inputTokens, outputTokens: run.outputTokens,
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function generatedImage(threadId: string): Promise<Buffer | null> {
  if (!threadId) return null
  const dir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'generated_images', threadId)
  const files = await readdir(dir).catch(() => [] as string[])
  const pngs = await Promise.all(files.filter(f => /.(png|jpe?g|webp)$/i.test(f)).map(async f => ({ f, t: (await stat(join(dir, f))).mtimeMs })))
  const last = pngs.sort((a, b) => b.t - a.t)[0]
  if (!last) return null
  const buf = await readFile(join(dir, last.f)).catch(() => null)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return buf
}

let configuredModel: string | null = null
async function codexDefaultModel(): Promise<string> {
  if (configuredModel !== null) return configuredModel
  try {
    const home = process.env.CODEX_HOME || join(homedir(), '.codex')
    configuredModel = (await readFile(join(home, 'config.toml'), 'utf8')).match(/^models*=s*"([^"]+)"/m)?.[1] ?? ''
  }
  catch { configuredModel = '' }
  return configuredModel
}

interface CodexRun { lastMessage: string, inputTokens: number, outputTokens: number, model: string, threadId: string }

function runCodex(extraArgs: string[], prompt: string, cwd: string, timeoutMs: number): Promise<CodexRun> {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--json', '--color', 'never']
  if (config.codexModel) args.push('-m', config.codexModel)
  if (config.codexReasoning) args.push('-c', `model_reasoning_effort="${config.codexReasoning}"`)
  args.push(...extraArgs, '-')

  return new Promise((resolve, reject) => {
    const child = spawn(config.codexBin, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new ProviderError('timeout', `Codex не ответил за ${Math.round(timeoutMs / 1000)} с`, 'chatgpt_account'))
    }, timeoutMs)

    child.stdout.on('data', d => (stdout += d))
    child.stderr.on('data', d => (stderr += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new ProviderError('unavailable', `Не удалось запустить Codex CLI: ${e.message}`, 'chatgpt_account'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const run: CodexRun = { lastMessage: '', inputTokens: 0, outputTokens: 0, model: '', threadId: '' }
      let errorText = ''
      for (const line of stdout.split('\n')) {
        if (!line.trim().startsWith('{')) continue
        try {
          const ev = JSON.parse(line)
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') run.lastMessage = ev.item.text ?? ''
          if (ev.type === 'turn.completed' && ev.usage) {
            run.inputTokens += ev.usage.input_tokens ?? 0
            run.outputTokens += ev.usage.output_tokens ?? 0
          }
          if (ev.model) run.model = ev.model
          if (ev.type === 'thread.started' && ev.thread_id) run.threadId = ev.thread_id
          if (ev.type === 'error' || ev.type === 'turn.failed') errorText += ` ${ev.message ?? ev.error?.message ?? ''}`
        }
        catch {}
      }
      if (code === 0 && !errorText) return resolve(run)
      const all = `${errorText} ${stderr}`.toLowerCase()
      const kind = /usage limit|rate limit|429|quota/.test(all)
        ? 'limit'
        : /not logged in|login|unauthorized|401|auth/.test(all) ? 'auth' : 'unavailable'
      reject(new ProviderError(kind, (errorText || stderr || `Codex завершился с кодом ${code}`).trim().slice(0, 500), 'chatgpt_account'))
    })
    child.stdin.end(prompt)
  })
}

export function codexLoginStatus(): Promise<{ ok: boolean, text: string }> {
  return new Promise((resolve) => {
    const child = spawn(config.codexBin, ['login', 'status'], { windowsHide: true })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    child.on('error', e => resolve({ ok: false, text: `Codex CLI не найден: ${e.message}` }))
    child.on('close', code => resolve({ ok: code === 0 && /logged in/i.test(out), text: out.trim() }))
  })
}
