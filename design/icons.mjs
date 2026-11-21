// Copia os ícones do Carbon usados pelo app para um sprite SVG dentro do index.html.
import { readFileSync, writeFileSync } from 'node:fs';
const names = ['camera', 'document--add', 'document--pdf', 'send', 'home', 'list', 'tag', 'settings', 'close', 'chevron--down', 'chevron--right', 'add', 'cloud--upload', 'trash-can', 'renew', 'checkmark', 'warning', 'information', 'folder', 'edit', 'user', 'arrow--right'];
const symbols = names.map((n) => {
  const svg = readFileSync(`node_modules/@carbon/icons/svg/32/${n}.svg`, 'utf8');
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/g, '');
  return `  <symbol id="i-${n.replace(/--/g, '-')}" viewBox="0 0 32 32">${inner}</symbol>`;
}).join('\n')
  // Símbolo de partilhar do iOS (caixa com seta para cima), para as instruções de instalação.
  + '\n  <symbol id="i-ios-share" viewBox="0 0 32 32"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 12H8v16h16V12h-3"/><path d="M16 4v16"/><path d="M11 9l5-5 5 5"/></g></symbol>';
const html = readFileSync('index.html', 'utf8');
const out = html.replace(/<!-- icons:start -->[\s\S]*<!-- icons:end -->/, `<!-- icons:start -->\n<svg width="0" height="0" style="position:absolute" aria-hidden="true">\n${symbols}\n</svg>\n<!-- icons:end -->`);
writeFileSync('index.html', out);
