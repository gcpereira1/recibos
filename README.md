# Recibos

App web para o telemóvel: fotografar cada recibo no momento da compra, associá-lo a um projeto e, no fecho do mês, enviar todos de uma vez num ZIP pelo e-mail.

- Os recibos ficam só no aparelho (IndexedDB). Não há servidor nem base de dados.
- Fecho do mês: um ZIP com uma pasta por mês e por projeto, partilhado pela folha de partilha do sistema (Outlook, Mail, Guardar em Ficheiros).
- Funciona sem internet depois da primeira abertura.
- Nome da pessoa e da organização definidos em Ajustes.

## Instalar no iPhone
1. Abrir o link no Safari.
2. Partilhar, depois "Adicionar ao ecrã principal".

Instalar é importante: o Safari pode apagar os dados de sites que não estão no ecrã principal.

## Desenvolvimento
Sem dependências nem build. Servir a pasta com qualquer servidor estático, por exemplo `python3 -m http.server`.
Ao mudar ficheiros da app, aumentar a versão em `CACHE` no `sw.js`.
