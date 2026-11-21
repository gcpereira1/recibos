import { copyFileSync } from 'node:fs';
const src = 'node_modules/@ibm/plex-sans/fonts/split/woff2/';
for (const f of ['IBMPlexSans-Regular-Latin1.woff2', 'IBMPlexSans-SemiBold-Latin1.woff2']) copyFileSync(src + f, 'fonts/' + f);
copyFileSync('node_modules/@ibm/plex-sans/LICENSE.txt', 'fonts/LICENSE-IBM-Plex-OFL.txt');
copyFileSync('node_modules/@carbon/styles/LICENSE', 'LICENSE-Carbon-Apache-2.0.txt');
