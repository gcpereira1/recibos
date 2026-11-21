// Copia os ícones do Carbon usados pelo app para um sprite SVG dentro do index.html.
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['camera', 'document--add', 'document--pdf', 'send', 'home', 'list', 'tag', 'settings', 'close', 'chevron--down', 'chevron--right', 'add', 'cloud--upload', 'trash-can', 'renew', 'checkmark', 'warning', 'information', 'folder', 'edit', 'user', 'arrow--right'];
const symbols = names.map((n) => {
  const svg = readFileSync(`node_modules/@carbon/icons/svg/32/${n}.svg`, 'utf8');
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/g, '');
  return `  <symbol id="i-${n.replace(/--/g, '-')}" viewBox="0 0 32 32">${inner}</symbol>`;
}).join('\n')
  // Símbolo de partilhar do iOS (caixa com seta para cima), para as instruções de instalação.
  // Ícones da barra de baixo, ao estilo iOS: contorno quando inativos, cheios na secção atual (ver app.css).
  + '\n  <symbol id="i-tab-home" viewBox="0 0 32 32"><g style="fill:var(--tab-fill,none)" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 14 16 4l12 10v14H19v-8h-6v8H4z"/></g></symbol>'
  + '\n  <symbol id="i-tab-receipts" viewBox="0 0 32 32"><g stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path style="fill:var(--tab-fill,none)" d="M7 4h18v24l-3-2-3 2-3-2-3 2-3-2-3 2z"/><path style="fill:none;stroke:var(--tab-hole,currentColor)" d="M11 11h10M11 16h10M11 21h6"/></g></symbol>'
  + '\n  <symbol id="i-tab-projects" viewBox="0 0 32 32"><g stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path style="fill:var(--tab-fill,none)" d="M4 16V4h12l12 12-12 12z"/><circle style="fill:var(--tab-hole,none);stroke:var(--tab-hole,currentColor)" cx="10" cy="10" r="2"/></g></symbol>'
  + '\n  <symbol id="i-tab-settings" viewBox="0 0 32 32"><g stroke="currentColor" stroke-width="2"><path style="fill:none" stroke-width="4" d="M25.50 16.00L29.50 16.00 M22.72 22.72L25.55 25.55 M16.00 25.50L16.00 29.50 M9.28 22.72L6.45 25.55 M6.50 16.00L2.50 16.00 M9.28 9.28L6.45 6.45 M16.00 6.50L16.00 2.50 M22.72 9.28L25.55 6.45"/><circle style="fill:var(--tab-fill,none)" cx="16" cy="16" r="9.5"/><circle style="fill:var(--tab-hole,none);stroke:var(--tab-hole,currentColor)" cx="16" cy="16" r="3.5"/></g></symbol>'
  + '\n  <symbol id="i-ios-share" viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12H8v16h16V12h-3"/><path d="M16 4v16"/><path d="M11 9l5-5 5 5"/></g></symbol>';
const html = readFileSync('index.html', 'utf8');
const out = html.replace(/<!-- icons:start -->[\s\S]*<!-- icons:end -->/, `<!-- icons:start -->\n<svg width="0" height="0" style="position:absolute" aria-hidden="true">\n${symbols}\n</svg>\n<!-- icons:end -->`);
writeFileSync('index.html', out);
