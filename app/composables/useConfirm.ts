import ConfirmDialog from '~/components/ConfirmDialog.vue'

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  confirmIcon?: string
  color?: 'error' | 'primary'
  action?: () => Promise<unknown>
}

export function useConfirm() {
  const overlay = useOverlay()
  return async (opts: ConfirmOptions): Promise<boolean> => {
    const ok = await overlay.create(ConfirmDialog, { destroyOnClose: true }).open(opts).result
    return ok === true
  }
}
