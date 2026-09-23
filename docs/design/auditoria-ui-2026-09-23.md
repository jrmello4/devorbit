# Auditoria de UI — DevOrbit (2026-09-23)

Varredura completa das telas reais (screenshots em `artifacts/ui/`, build 1.0.37) +
sistema de tokens atual (`src/renderer/src/index.css`) + direção histórica
(`DESIGN.md`). Proposta visual acompanhante: `proposta-ui-2026-09-23.html`
(renderizada em `artifacts/design/proposta-*.png`).

## Diagnóstico

1. **Elevação achatada no dark** — página `#0d0f14`, painel `#171a22` e cards
   `#141820` se misturam; bordas `#252a34` quase invisíveis. Cards da
   biblioteca, nós do canvas e painéis competem no mesmo tom. Nós do canvas
   quase pretos sobre fundo quase preto; arestas cinza-escuro somem.
2. **Acento diluído** — o DESIGN.md pede "tema claro sem azul, acento oliva",
   mas o app hoje usa um azul-acinzentado (`#5b6b86`/`#8797b4`) como acento e
   um amarelo pontual no canvas. Resultado: nenhuma cor "pertence" ao app.
3. **Cards com pouco sinal de informação** — na biblioteca, o único sinal de
   estado Git é um pontinho de 8px no canto; ícone de pasta repetido 36× não
   informa; ~40% do card é espaço morto; branch em texto apagado.
4. **Filtros que não filtram nada** — abas "Todos 36 / Em desenvolvimento 36 /
   Arquivados 0" repetem o mesmo número; a situação real do Git (limpo,
   pendente, à frente, sem repo) não é filtrável.
5. **Toolbar do canvas sobrecarregada** — 2 grupos de ações de texto + 6
   presets de zoom fixos + % + fullscreen + chip do projeto, tudo com o mesmo
   peso visual.
6. **Arestas sem estado** — a conexão é sempre o mesmo traço fino; orquestração
   ativa, cabo de piping e ligação de nota são visualmente idênticos.
7. **Cabeçalhos de painel inconsistentes** — "Arquivos", "renamed-notes.md",
   "Terminal interno" e "Pesquisa web" usam quatro padrões diferentes de
   cabeçalho (altura, peso, posição de ações).
8. **Três botões-toggle onde caberia um seletor** — Canvas/Terminal/Web no
   cabeçalho do projeto são botões independentes; o estado "qual visão estou"
   fica implícito.
9. **Paleta de comandos com ruído de atalhos** — a rodapé lista 10+ chips
   "G then P / G then C…" de uma vez.
10. **Toast sobre o inspetor** — notificações nascem no canto inferior direito,
    exatamente onde o inspetor trabalha; hint de 3 linhas de instruções fixo no
    rodapé do canvas.

## Direção proposta ("Grafite + Oliva")

- **Escada de elevação**: página `#0f1116` → painel `#171b24` → elevado
  `#1d222e` → poço (canvas/terminal) `#0a0c10`; bordas em alpha
  (8%/16% de branco). Terminal continua preto puro (contraste de conteúdo).
- **Um acento**: oliva `#a6bf8a` (UI) / `#4a6038` (botão primário) — resgata a
  intenção do DESIGN.md em versão dark; amarelo `#d9a441` reservado a
  orquestração ativa.
- **Semântica Git consistente**: limpo `#69a986`, pendente `#d0a05a`, à frente
  `#b29dd6`, conflito `#c97a85`, sem Git cinza — usada em espinha de card,
  filtros, lista, statusbar.
- **Card compacto**: 26% mais curto, espinha de 3px + branch em pílula mono +
  ações no hover; filtros por situação real do Git.
- **Canvas**: toolbar única em pílula (criação ▸ conexão ▸ zoom com presets em
  dropdown ▸ foco); nós com espinha de tipo e preview; aresta cinza idle vs
  âmbar animada em orquestração; toast no topo; hint em botão "?".
- **Workspace**: seletor segmentado Canvas·Código·Web; cabeçalho de painel
  único (32px, rótulo 11px caixa-alta, ações à direita); empty state no painel
  web.
- **Mapeamento 1:1 nos tokens atuais** (`--color-bg-*`, `--color-accent*`) — a
  adoção é incremental, tela a tela, sem reescrita.

## Prioridade sugerida

1. Tokens de elevação + acento oliva (1 arquivo CSS, efeito global).
2. Biblioteca: espinha Git + card compacto + filtros por situação.
3. Canvas: agrupar toolbar + aresta com estado + toast no topo.
4. Workspace: seletor de visão + cabeçalhos de painel unificados.
5. Polimento: paleta sem chips de atalho, hint do canvas em "?".
