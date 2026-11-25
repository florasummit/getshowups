// Contrast-safe use of a business's brand colour on its public pages (WCAG relative luminance).
const HEX = /^#[0-9a-f]{6}$/i
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const mix = (hex, to, t) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + parseInt(to.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('')
const INK = '#0f1a2c'

// accent → the CSS variables PublicShell sets. The accent itself is used for selection and focus; text links use a
// darkened version that reads on white (AA 4.5:1); the primary button uses the accent only when white text passes AA,
// otherwise ink (so a light yellow brand never produces an unreadable button).
export function accentVars(accent, { product = false } = {}) {
  if (product || !HEX.test(accent || '')) return product ? { '--pub-accent': '#ff6a1a', '--pub-accent-ink': '#c2410c' } : { '--pub-accent': '#3b5bdb', '--pub-accent-ink': '#3b5bdb' }
  let ink = accent
  for (let t = 0.1; contrast(ink, '#ffffff') < 4.5 && t <= 0.9; t += 0.1) ink = mix(accent, '#000000', t)
  const onAccent = contrast(accent, '#ffffff') >= 4.5 ? '#ffffff' : INK
  return {
    '--pub-accent': accent,
    '--pub-accent-ink': ink,
    '--pub-on-accent': onAccent,
    ...(contrast(accent, '#ffffff') >= 4.5 ? { '--pub-action': accent, '--pub-on-action': '#ffffff' } : {}),
  }
}
