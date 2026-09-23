# DevOrbit — Interface desktop

## Direção
Sistema **"Grafite + Oliva"**: tema escuro por padrão com escada de elevação clara (página → painel → elevado → poço), um único acento oliva funcional e cores semânticas de Git compartilhadas por todo o app. O tema claro permanece como alternativa, com o mesmo acento oliva. Modo de uso: operar projetos locais com teclado e mouse; leitura prolongada, divisões discretas, sem gradientes nem efeitos de vidro.

## Organização espacial
A janela é um grid de três linhas: barra de título de 52 px, workspace flexível e barra de status de 28 px. Não há rolagem da página.

Dentro do workspace, a navegação ocupa 184 px (60 px recolhida). A Biblioteca usa cards compactos com espinha de situação Git; o restante é a área do projeto. Abaixo de 1150 px, navegação e lista diminuem para 160 e 240 px. Listas, detalhes extensos e conteúdo de diálogos possuem rolagem interna independente.

- **Barra superior:** identidade, busca por projeto/pasta/branch/tecnologia, ações rápidas, atualização e controles nativos de janela.
- **Biblioteca:** filtros por situação real do Git (Todas as situações · Pendentes · Limpos · Sem Git, com contagens), ordenação, grade/lista; cada card traz espinha de 3 px com a situação, pílula de branch com sincronização (↑n ↓n) e ações no hover.
- **Workspace:** seletor segmentado Canvas · Código · Web; painéis (Arquivos, Editor, Terminal, Pesquisa web) compartilham o mesmo cabeçalho de 32 px com rótulo em caixa-alta.
- **Canvas:** toolbar em pílula única (criação · conectar · zoom com presets em dropdown · foco); arestas neutras em repouso e âmbar animadas durante orquestração; nós com espinha de tipo (agente oliva, nota âmbar, terminal elevado); toast no topo-centro; ajuda contextual no botão "?".
- **Contas e uso:** cotas informadas pelo provedor em destaque; estimativas locais e ajustes em divulgação progressiva.
- **Diálogos:** mesmo tema, foco contido, fechamento por Escape conforme as proteções existentes.

## Tokens (dark, defaults do app)
| Token | Valor | Uso |
|---|---|---|
| `--color-bg-page` | `#0f1116` | Fundo do app e da navegação recolhida |
| `--color-bg-header` / `--color-bg-toolbar` | `#12151c` | Barra de título e barras auxiliares |
| `--color-bg-panel` | `#171b24` | Cartões e painéis |
| `--color-bg-popover` / `--color-bg-raised` | `#1d222e` | Popovers, toolbar flutuante do canvas, item ativo |
| `--color-bg-inset` | `#0a0c10` | Poço do canvas |
| `--color-border-subtle` / `-strong` | `rgba(232,236,243,.08/.16)` | Divisões e contornos |
| `--text-primary` | `#e8ecf3` | Texto principal |
| `--color-text-secondary` / `-muted` | `#a8b1c2` / `#7c8598` | Texto secundário/apagado |
| `--color-accent` | `#a6bf8a` | Ênfase, foco, espinha de agente |
| `--color-accent-strong` | `#4a6038` | Ação primária com texto branco |
| `--color-git-clean/pending/ahead/conflict/none` | `#69a986` `#d0a05a` `#b29dd6` `#c97a85` `#59616f` | Situação Git em cards, filtros e status |
| `--color-orchestrating` | `#d9a441` | Orquestração ativa (arestas, badge, nota) |

Os valores são definidos em `src/renderer/src/index.css` e espelhados em `src/renderer/src/theme.ts` (aplicados em runtime no `:root`). O tema claro usa os mesmos nomes com valores próprios.

## Tipografia e densidade
Segoe UI com fallback para system-ui; 13 px / 1,5 no corpo. Rótulos de painel 11 px caixa-alta (650, +0,8 px), títulos de navegação 17 px, título de página 20–24 px. Monospace (Consolas/Cascadia) em branches, caminhos e dados técnicos. Escala de espaçamento: 4, 8, 12, 16, 20, 24 e 32 px. Bordas de 1 px, raios de 5–11 px. Sombra reservada a elementos flutuantes (toolbar do canvas, popovers, diálogos).

## Interação e acessibilidade
Controles compactos de 28–36 px; seleção de projeto com a linha inteira clicável. Foco de 2 px em oliva (`:focus-visible`) — seleção usa tint de fundo/anel interno para não competir com o foco. Estados ativos reforçados por fundo, borda e semântica. Erros, pendências e sucesso são descritos por texto, não apenas por cor. Animações respeitam `prefers-reduced-motion` e pausam durante gestos do canvas.

Ctrl+K abre a paleta de ações; Ctrl+R atualiza os projetos. Tab e Shift+Tab percorrem os controles. Enter/Espaço acionam botões e seleções; Escape fecha diálogos respeitando as proteções para operações em andamento e rascunhos.

## Limites da validação
O harness `scripts/verify-ui.cjs` usa uma ponte simulada isolada, com projetos fictícios, para verificar layout, tokens (fundo, acento, poço do canvas, família neutra de nós) e interações sem modificar repositórios ou iniciar ferramentas. Validação de operações reais de Git, login e executáveis depende do ambiente desktop configurado.

## Contraste verificado (dark)
Cálculo de luminância relativa sRGB: texto principal sobre página 15,94:1 (AAA); secundário sobre painel 7,99:1; apagado sobre painel 4,65:1 (AA); branco no botão primário 6,95:1; oliva sobre página 9,39:1. Todos atendem ao mínimo AA para texto normal. Isso não substitui uma auditoria completa de acessibilidade de todos os estados.
