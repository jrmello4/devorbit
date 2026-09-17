# Piloto TypeSafe em modo sombra

O piloto observa a classificacao `fast`, `deep` ou `review` sem alterar o
roteamento real do DevOrbit. A decisao usada pelo produto continua sendo a
classificacao deterministica local.

## Ativar

Defina as duas variaveis no mesmo ambiente que inicia o Electron. Carregue a
chave de um cofre local ou do gerenciador de secrets; nunca grave a chave neste
repositorio, em `AppConfig`, em `.env` versionado ou no renderer.

```powershell
$env:DEVORBIT_TYPESAFE_SHADOW = '1'
$env:TYPESAFE_API_KEY = '<chave fornecida pelo secret manager>'
npm.cmd run dev
```

Para testar o aplicativo empacotado, execute `npm.cmd run build` e depois
`npm.cmd start` no mesmo ambiente. O judge e criado sob demanda no processo
main. Por isso, reinicie o Electron sempre que ligar ou desligar o piloto.

## Desativar

```powershell
Remove-Item Env:DEVORBIT_TYPESAFE_SHADOW -ErrorAction SilentlyContinue
Remove-Item Env:TYPESAFE_API_KEY -ErrorAction SilentlyContinue
```

O piloto tambem fica desligado quando qualquer uma das duas variaveis falta ou
quando a flag nao e exatamente `1`.

## Relatorio

O main grava o arquivo estavel:

```text
<app.getPath('userData')>/typesafe-shadow-routing-metrics.json
```

O relatorio e uma fotografia agregada da janela de observacoes da sessao. Ele
contem apenas `total`, concordancia por `fast` e `deep`, `reviewRate`, contagem
por outcome, `cacheHits` e estatisticas `latencyMs` (`count`, `min`, `max`,
`mean`, `p50`, `p95`). Nao contem prompt, state, texto redigido, hash, path,
token, resposta, excecao ou chave. Falhas de escrita sao silenciosas e nao
interrompem os turnos.

O arquivo fica em `userData`, nao e exposto por IPC e nao aparece no renderer.
Para recuperar os dados, copie o JSON localmente depois de fechar o app ou
leia-o enquanto o app estiver em execucao.

## Gates de promocao

Promova o roteamento somente depois de revisar um conjunto representativo de
turnos e registrar os limiares aprovados para o produto. Os gates minimos sao:

1. nenhum segredo, caminho local, prompt ou resposta crua no relatorio ou no
   corpo enviado ao TypeSafe;
2. respostas invalidas, timeouts e erros ficam em fallback silencioso, sem
   alterar o tier, modelo, provedor ou failover deterministico;
3. concordancia `fast`/`deep`, taxa de `review`, latencia p95 e outcomes sao
   estaveis no conjunto representativo;
4. a taxa de falhas degradadas fica abaixo do limite operacional aprovado e o
   p95 permanece abaixo do timeout configurado;
5. os testes de sanitizacao, resposta `Choice`, cache, circuito, timeout,
   limite do relatorio e isolamento main/renderer passam em CI.

Os limiares de qualidade devem ser definidos com dados do DevOrbit; o relatorio
nao autoriza sozinho a troca do roteamento.
