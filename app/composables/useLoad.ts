export function useLoad<T>(loader: () => Promise<T>, opts: { poll?: number } = {}) {
  const data = ref<T | null>(null) as Ref<T | null>
  const error = ref('')
  const loading = ref(true)
  let timer: ReturnType<typeof setInterval> | null = null

  async function reload(silent = false) {
    if (!silent) loading.value = true
    try { data.value = await loader(); error.value = '' }
    catch (e: any) { if (!silent || data.value === null) error.value = e.message }
    finally { loading.value = false }
  }
  onMounted(() => {
    reload()
    if (opts.poll) timer = setInterval(() => reload(true), opts.poll)
  })
  onUnmounted(() => { if (timer) clearInterval(timer) })
  return { data, error, loading, reload }
}
