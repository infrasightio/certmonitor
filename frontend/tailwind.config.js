/** @type {import('tailwindcss').Config} */

/*
 * The theme is defined here rather than page by page.
 *
 * `slate` is the app's neutral and is used about a thousand times across the
 * pages, so it is REDEFINED here instead of being swapped out at every call
 * site: retuning the ramp restyles the whole product in one place, and no
 * screen can drift off-theme by forgetting to adopt a token. The same applies
 * to `brand`. Anything that needs a colour reaches for one of these two, or
 * for a semantic status colour - never for a raw hex.
 *
 * The neutral is cool and low-chroma so the only saturated things on an
 * operations screen are the ones that mean something: a red endpoint, an
 * amber certificate, a green recovery.
 *
 * Both modes are tuned for a long shift rather than for a screenshot. Light
 * is a shade off white so a wall of panels does not glare; dark is a dark
 * room rather than a void, because light text on near-black halates and
 * leaves nowhere to show elevation. One ramp serves both - its light end is
 * light mode's surfaces and dark mode's text, its dark end the reverse.
 */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        /*
         * Paper, not paper-white.
         *
         * Cards, the shell, inputs and the sidebar are the largest areas on
         * screen, and at #FFF they are the brightest thing in the room on a
         * monitor someone stares at all day. Four percent off is invisible as
         * a colour and noticeable as glare. Redefining `white` rather than
         * introducing a `paper` token means every existing `bg-white` gets it
         * without a sweep, and `text-white` on a brand or red fill softens by
         * the same amount - which is the other place the product was
         * brightest.
         */
        white: '#f9fafc',

        /*
         * Cool graphite. Lower chroma than stock Tailwind slate, which carries
         * enough blue to compete with the brand and to tint every white card
         * it borders.
         *
         * 50-300 are surfaces, borders and dividers; 400-600 are text; 700-950
         * are dark-mode surfaces AND light-mode strong text, which is why the
         * step from 600 to 700 is larger than the others.
         *
         * The ramp is deliberately COMPRESSED at both ends, because the two
         * ends are the two modes:
         *
         *  - the light end (50-300) sits a few percent down from where a
         *    stock ramp puts it, so a screen of panels and dividers stops
         *    glaring;
         *  - the dark end (800-950) sits a few percent UP, so dark mode is a
         *    dark room rather than a void. A near-black ground makes light
         *    text halate and leaves no room to show elevation - 950 to 900 to
         *    800 now steps far enough that a card reads as raised off the
         *    page and a dialog as raised off the card.
         *
         * 400 is darker than Tailwind's (#94a3b8): it carries every hint,
         * placeholder and empty state in the product, and at 2.8:1 those were
         * the least readable text on screen. This is 3.7:1 - still obviously
         * quiet, no longer a squint.
         */
        slate: {
          50: '#f2f4f8',
          100: '#e6e9f0',
          200: '#d6dbe5',
          300: '#bdc4d2',
          400: '#78829a',
          500: '#5e6880',
          600: '#475064',
          700: '#3b4351',
          800: '#2a3039',
          900: '#1c2129',
          950: '#12151c',
        },

        /*
         * Cobalt indigo. Deliberately NOT the blue Tailwind ships by default:
         * that blue is also the semantic "in progress / informational" colour
         * in this product, and an accent that matches a status colour makes
         * both mean less. Indigo sits clear of green, amber, red and the
         * informational blue.
         *
         * 600 is the primary: 6.9:1 against white, so it works as a button
         * fill with white text AND as link text on a card without changing
         * value. 400 is its dark-mode counterpart at 5.6:1 on slate-900.
         */
        brand: {
          50: '#eff2fe',
          100: '#e1e7fd',
          200: '#c7d2fa',
          300: '#a3b3f4',
          400: '#7a8deb',
          500: '#5666dd',
          600: '#3e4cc6',
          700: '#333fa3',
          800: '#2c3684',
          900: '#29316a',
          950: '#1a1d3f',
        },

        // Semantic health states. Used everywhere a status is shown, so
        // "green" means the same thing on every screen. Deepened slightly
        // from the previous values to sit on the lighter ground without
        // glowing.
        up: { DEFAULT: '#15803d', soft: '#dcfce7', dark: '#14532d' },
        down: { DEFAULT: '#dc2626', soft: '#fee2e2', dark: '#7f1d1d' },
        warn: { DEFAULT: '#c2700a', soft: '#fef3c7', dark: '#78350f' },
        unknown: { DEFAULT: '#5e6880', soft: '#e6e9f0', dark: '#3b4351' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        /*
         * Two-part shadows: a tight contact shadow that reads as the edge, and
         * a wider, softer one that reads as height. A single blurred shadow at
         * this opacity just looks like the card is out of focus.
         *
         * Tinted with the neutral's own hue rather than pure black, so a
         * shadow on the cool ground does not go grey-green.
         */
        card: '0 1px 2px 0 rgb(28 33 41 / 0.04), 0 1px 3px -1px rgb(28 33 41 / 0.06)',
        raised: '0 1px 2px 0 rgb(28 33 41 / 0.05), 0 6px 16px -6px rgb(28 33 41 / 0.12)',
        pop: '0 2px 4px -1px rgb(28 33 41 / 0.06), 0 12px 28px -8px rgb(28 33 41 / 0.18)',
        // Primary buttons: the fill already carries the weight, so this is
        // only enough to lift it off the surface it sits on.
        btn: '0 1px 2px 0 rgb(28 33 41 / 0.08)',
      },
      animation: {
        'pulse-slow': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
      },
    },
  },
  plugins: [],
}
