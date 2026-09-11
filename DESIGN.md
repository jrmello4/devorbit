# DevOrbit — Interface desktop

## Direção
Tema claro corporativo, solicitado pelo usuário, sem azul. Superfícies brancas e cinzas quentes, texto carvão e verde-oliva funcional. Modo de uso: operar projetos locais com teclado e mouse. A identidade favorece leitura prolongada e divisões discretas, sem gradientes ou efeitos de vidro.

## Organização espacial
A janela é um grid de três linhas: barra de título de 52 px, workspace flexível e barra de status de 28 px. Não há rolagem da página.

Dentro do workspace, a navegação ocupa 184 px (60 px recolhida). A seção Projetos usa uma lista de 280 px e o restante para os detalhes do projeto. Em 1366×768, isso deixa 902×688 px para as ações e informações do projeto; em 1920×1080, 1456×1000 px. Abaixo de 1150 px, navegação e lista diminuem para 160 e 240 px. Listas, detalhes extensos e conteúdo de diálogos possuem rolagem interna independente.

- **Barra superior:** identidade, busca por projeto/pasta/branch/tecnologia, ações rápidas, atualização e controles nativos de janela.
- **Navegação:** Projetos, Contas e uso, sincronização Git global e configurações. Conta ativa e troca de conta no rodapé lateral.
- **Lista mestre:** filtros de estado Git e tecnologia, ordenação alfabética ou por modificação, seleção persistente entre atualizações quando possível, contagem de resultados.
- **Detalhes:** nome e caminho, tecnologias, estado Git e ações do projeto selecionado. Editores, terminal, assistentes IA, navegadores e contexto aparecem uma vez, sem repetição por projeto.
- **Contas e uso:** cotas informadas pelo provedor em destaque; estimativas locais e ajustes em divulgação progressiva. Dados indisponíveis não são apresentados como consumo zero.
- **Diálogos:** preservam os fluxos de configurações, Git, autenticação e memória, com o mesmo tema claro, foco contido e fechamento por Escape conforme as proteções existentes.

## Tokens
| Token | Valor | Uso |
|---|---|---|
| `--color-bg-page` | `#f5f5f2` | Fundo do app |
| `--color-bg-header` | `#fcfcfa` | Barra de título |
| `--color-bg-toolbar` | `#f0f1ed` | Barra auxiliar |
| `--color-bg-panel` | `#ffffff` | Área de trabalho e diálogos |
| `--color-border-subtle` | `#d9dcd5` | Divisões estruturais |
| `--text-primary` | `#242923` | Texto principal |
| `--color-text-muted` | `#62695f` | Texto secundário |
| `--color-accent` | `#49643b` | Ênfase e foco |
| `--color-accent-strong` | `#3e562f` | Ação primária com texto branco |
| `--surface-selected` | `#e7ecdf` | Seleção |
| `--surface-hover` | `#eceee7` | Hover neutro |

## Tipografia e densidade
Segoe UI com fallback para system-ui; 13 px / 1,5 no corpo. Rótulos auxiliares 11–12 px, títulos de navegação 17 px, títulos de projeto 21–24 px. Peso 600–650 nas ações e títulos. Consolas/monospace somente em caminhos, branches e dados técnicos. Escala de espaçamento: 4, 8, 12, 16, 20, 24 e 32 px. Bordas de 1 px, raios de 5–8 px. Sombra reservada aos diálogos.

## Interação e acessibilidade
Controles compactos de 28–36 px; seleção de projeto com a linha inteira clicável. Foco de 2 px em oliva; estados ativos reforçados por fundo, borda e semântica. Erros, pendências e sucesso são descritos por texto, não apenas por cor. Suporte a redução de movimento e modo de cores forçadas.

Ctrl+K abre a paleta de ações; Ctrl+R atualiza os projetos. Tab e Shift+Tab percorrem os controles. Enter/Espaço acionam botões e seleções; Escape fecha diálogos respeitando as proteções para operações em andamento e rascunhos.

## Limites da validação
O harness `scripts/verify-ui.cjs` usa uma ponte simulada isolada, com projetos fictícios, para verificar layout e interações sem modificar repositórios ou iniciar ferramentas. Validação de operações reais de Git, login e executáveis depende do ambiente desktop configurado.

## Contraste verificado
Cálculo de luminância relativa sRGB: texto principal sobre branco 14,83:1; texto secundário sobre branco 5,67:1; texto secundário sobre barra auxiliar 4,99:1; branco no botão primário 8,15:1; oliva sobre seleção 5,51:1. Estes pares atendem ao mínimo AA de 4,5:1 para texto normal. Isso não substitui uma auditoria completa de acessibilidade de todos os estados.
