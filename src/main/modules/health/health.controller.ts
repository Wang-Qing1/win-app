import { IpcChannel } from '@shared/ipc-channels'
import { registerHandler } from '../../core/ipc-handler'
import type { HealthService } from './health.service'

export function registerHealthHandlers(service: HealthService): void {
  registerHandler(IpcChannel.HealthPing, {
    label: '健康检查',
    handle: () => service.ping()
  })

  registerHandler(IpcChannel.HealthReady, {
    label: '就绪检查',
    handle: () => service.ready()
  })
}
