// DSH 插件：启动本机定时任务调度器。
//
// 为什么需要它：容器里没有 root、没有 systemd，entrypoint 也是 root 只读改不了，
// 所以没法用系统级 init 拉起后台进程。这个插件在 DSH 启动时把 /data/cron/runner.py
// 拉起来，DSH 一挂调度器就在；DSH 挂了调度器自然也没了。
//
// 调度器本身是零依赖的 Python，完全独立于 DSH 运行。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

export const name = 'cron-runner'


export const Config = z.object({
  runnerPath: z.string().min(1).default('/data/cron/runner.py'),
  pythonBin: z.string().min(1).default('python3'),
  cwd: z.string().min(1).default('/data/cron'),
  // 启动后多久开始拉起调度器（留点时间让 DSH 自身先就绪）
  startDelayMs: z.number().step(1).min(0).default(15000),
  // 拉起失败后的重试间隔
  retryIntervalMs: z.number().step(1).min(5000).default(60000)
})

export function apply(ctx, config) {
  const cfg = config ?? {}
  const runnerPath = cfg.runnerPath ?? '/data/cron/runner.py'
  const pythonBin = cfg.pythonBin ?? 'python3'
  const cwd = cfg.cwd ?? '/data/cron'
  const startDelayMs = cfg.startDelayMs ?? 15000
  const retryIntervalMs = cfg.retryIntervalMs ?? 60000

  let child = null
  let stopping = false

  const spawnRunner = () => {
    if (stopping) return
    if (!existsSync(runnerPath)) {
      ctx.logger.warn(`cron-runner: 找不到 ${runnerPath}，${retryIntervalMs / 1000}s 后重试`)
      setTimeout(spawnRunner, retryIntervalMs)
      return
    }
    try {
      child = spawn(pythonBin, [runnerPath], {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env }
      })
      child.unref()
      child.on('exit', (code, signal) => {
        child = null
        if (stopping) return
        ctx.logger.warn(`cron-runner: 调度器退出 (code=${code} signal=${signal})，${retryIntervalMs / 1000}s 后重启`)
        setTimeout(spawnRunner, retryIntervalMs)
      })
      ctx.logger.info(`cron-runner: 调度器已启动 (pid=${child.pid})`)
    } catch (error) {
      ctx.logger.warn(`cron-runner: 启动失败: ${String(error)}`)
      setTimeout(spawnRunner, retryIntervalMs)
    }
  }

  const timer = setTimeout(spawnRunner, startDelayMs)

  // 说明：本 cordis 版本没有公开的插件清理钩子（ctx.cleanup 不存在，ctx.plugin() 是"创建插件"入口），
  // 因此不做卸载时 kill。runner 是容器内的脱离子进程，容器停止时随容器一起结束。
}
