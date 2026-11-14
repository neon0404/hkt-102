export default defineNuxtConfig({
  compatibilityDate: '2026-01-01',
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  ssr: false,
  devtools: { enabled: false },
  app: {
    head: {
      title: 'AI-маркетолог · Салаватстекло',
      htmlAttrs: { lang: 'ru' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'theme-color', content: '#196C7F' }],
      link: [{ rel: 'icon', type: 'image/png', href: '/favicon.png' }],
      script: [{ innerHTML: "try{if(location.pathname.indexOf('/app')===0&&location.hash.indexOf('tgWebAppData')>-1)sessionStorage.setItem('tg-launch-hash',location.hash)}catch(e){}" }],
    },
  },
  ui: { fonts: false },
  colorMode: { preference: 'light', fallback: 'light' },
  nitro: {
    externals: { external: ['@resvg/resvg-js', '@napi-rs/canvas'] },
  },
  typescript: { typeCheck: false },
})
