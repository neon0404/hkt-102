export default defineAppConfig({
  ui: {
    tv: {
      twMergeConfig: {
        extend: {
          theme: {
            text: ['display', 'stat', 'title', 'heading', 'body', 'meta', 'caption'],
            radius: ['card', 'tile', 'tile-sm', 'nav'],
          },
        },
      },
    },
    colors: {
      primary: 'petrol',
      secondary: 'azure',
      success: 'sea',
      info: 'azure',
      warning: 'amber',
      error: 'coral',
      neutral: 'glass',
    },
  },
})
