import type { IpcSenderLike } from '../validation'
import type { IpcInvokeChannel, IpcSendChannel } from '../../renderer/src/types'

export type IpcHandlerFn = (event: IpcSenderLike, ...args: any[]) => unknown

export type IpcRegistrar = (channel: IpcInvokeChannel, handler: IpcHandlerFn) => void

export type IpcListenerRegistrar = (channel: IpcSendChannel, handler: IpcHandlerFn) => void
