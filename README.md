# Recibos

App web para o telemóvel: fotografar cada recibo no momento da compra, associá-lo a um projeto e, no fecho do mês, enviar todos de uma vez num ZIP pelo e-mail.

- Os recibos ficam só no aparelho (IndexedDB). Não há servidor nem base de dados.
- Cópia de segurança e restauro por ZIP, guardado onde a pessoa escolher (por exemplo, iCloud Drive).
- Fecho do mês: um ZIP com uma pasta por mês e por projeto, partilhado pela folha de partilha do sistema (Outlook, Mail, Guardar em Ficheiros).
- Funciona sem internet depois da primeira abertura.
- Nome da pessoa e da organização definidos em Ajustes.

## Instalar no iPhone
1. Abrir o link no Safari.
2. Partilhar, depois "Adicionar ao ecrã principal".

Instalar é importante: o Safari pode apagar os dados de sites que não estão no ecrã principal.

## Desenvolvimento
O app não tem build: os ficheiros são servidos tal como estão (`python3 -m http.server`).

O visual usa o [Carbon Design System](https://carbondesignsystem.com/) da IBM, tema White, com o azul trocado por preto (ver `app.css`). Só o subconjunto usado está em `carbon.css`, junto com a fonte IBM Plex Sans (`fonts/`) e os ícones Carbon (sprite no `index.html`). Para os regenerar depois de mudar `design/`:

```bash
npm install
npm run build
```

Ao mudar ficheiros da app, aumentar o número em `CACHE` no `sw.js` e em `APP_VERSION` no `app.js` (aparece em Ajustes).
