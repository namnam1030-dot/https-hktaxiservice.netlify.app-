/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./result.html",
    "./fleet.html",
    "./booking.html",
    "./booking-success.html"
  ],
  theme: {
    extend: {
      colors: {
        'brand-yellow': '#FFF200',
        'brand-dark': '#0B0B0B',
        'brand-gray': '#161616',
        'brand-card': '#1E1E1E'
      }
    }
  },
  plugins: [],
}