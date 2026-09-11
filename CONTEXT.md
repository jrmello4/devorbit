# 🧠 AI Memory & Handoff — devorbit

### 🎯 Objetivo atual
- Evoluir o DevOrbit como hub desktop seguro para projetos, Git e ferramentas de IA.
- Manter a interface acessível, o build reproduzível e as operações Git previsíveis.

### 🧭 Onde paramos
- O projeto usa Electron, React, TypeScript, Vite e Tailwind CSS.
- A orquestração usa Astra como coordenador/revisor e Luna para execução.
- A memória canônica editável fica em `.devorbit/memory.md`; `CONTEXT.md` é apenas fallback legado.

### ⚠️ Cuidados conhecidos
- Não compartilhar `node_modules` entre checkouts ou projetos.
- Não registrar e-mails, tokens ou caminhos absolutos pessoais.
- A sincronização Git deve recusar árvores sujas e usar apenas fast-forward.

### 💡 Decisões técnicas
- Validar dados IPC em runtime, além dos tipos TypeScript.
- Limitar concorrência em varreduras e operações Git.
- Preservar rascunhos do usuário e indicar quando a memória estiver desatualizada.

### 📋 Próximos passos
- Executar typecheck, testes, lint, build e revisão independente antes de publicar.
- Manter o CI e os testes de regressão atualizados com novas funcionalidades.
