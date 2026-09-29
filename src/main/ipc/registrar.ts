import type { IpcSenderLike } from '../validation'
import type { IpcInvokeChannel, IpcSendChannel } from '../../shared/ipc-channels'

export type IpcHandlerFn = (event: IpcSenderLike, ...args: any[]) => unknown

export type IpcRegistrar = (channel: IpcInvokeChannel, handler: IpcHandlerFn) => void

export type IpcListenerRegistrar = (channel: IpcSendChannel, handler: IpcHandlerFn) => void
