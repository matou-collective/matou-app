/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      // Extend with your design tokens if needed
      colors: {
        // You can add custom colors here that match your design tokens
      },
    },
  },
  plugins: [],
  // No prefix - we're removing conflicting utilities
  corePlugins: {
    preflight: false, // Disable Tailwind's base reset since Quasar has its own
  },
}
