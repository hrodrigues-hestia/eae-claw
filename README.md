# Eae Claw 🦀

Desktop app para conversar com o Claw por texto e voz.

## Requisitos

- **Node.js** (v18+)
- **Rust** (`rustup install` → https://rustup.rs)
- **Port forwarding** da VirtualBox: `localhost:18789` → VM `10.0.2.15:18789`

## Setup

```bash
# 1. Instala dependências do frontend
npm install

# 2. Roda em modo dev (compila Rust + abre a janela)
npx tauri dev
```

Na primeira execução, vai pedir o **token do gateway**. Pega ele com:
```bash
# Na VM do OpenClaw:
openclaw config get gateway.auth.token
```

## Build (produção)

```bash
npx tauri build
```

O `.exe` fica em `src-tauri/target/release/`.

## Features (v0.1)

- ✅ Chat por texto
- ✅ Gravação de áudio (botão ou Ctrl+Shift+C)
- ✅ Comunicação direta com OpenClaw gateway
- ✅ Interface dark mode compacta

## Roadmap

- [ ] Wake word "Eae Claw" (Picovoice Porcupine)
- [ ] Hotkey global (funciona mesmo com app minimizado)
- [ ] TTS nas respostas (resposta por voz)
- [ ] Histórico persistente
- [ ] Always-on-top toggle
