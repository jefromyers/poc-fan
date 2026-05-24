import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        cl: {
          blue: "var(--cl-blue)",
          navy: "var(--cl-navy)",
          yellow: "var(--cl-yellow)",
          ice: "var(--cl-ice)",
          success: "var(--cl-success)",
          warning: "var(--cl-warning)",
          error: "var(--cl-error)",
          slate: "var(--cl-slate)",
          border: "var(--cl-border)",
          bg: "var(--cl-bg)",
          "bg-soft": "var(--cl-bg-soft)",
        },
      },
      fontFamily: {
        sans: ["Inter", "Geist", "-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", "sans-serif"],
      },
      borderRadius: {
        card: "6px",
        btn: "4px",
      },
    },
  },
  plugins: [],
};

export default config;
