# API & Game Server - Liar's Deck

Servidor back-end e motor de jogo em tempo real para o aplicativo multiplataforma Liar's Deck. Construído sob uma arquitetura modular utilizando NestJS, este serviço gerencia autenticação, persistência de dados e a lógica de estado das partidas multiplayer simultâneas através de WebSockets.

## Arquitetura e Tecnologias

O projeto utiliza uma pilha tecnológica baseada em Node.js, otimizada para alta concorrência e tipagem estática rigorosa:

* **Framework:** NestJS
* **Linguagem:** TypeScript
* **Comunicação em Tempo Real:** Socket.io
* **Banco de Dados:** PostgreSQL
* **ORM:** Prisma ORM
* **Autenticação:** JSON Web Token (JWT) e Passport.js

## Funcionalidades Principais

O back-end está dividido em duas camadas de comunicação principais:

### 1. Camada REST (HTTP)
Responsável pelo gerenciamento de usuários e infraestrutura externa.
* Registro e autenticação segura de usuários (Bcrypt e JWT).
* Consulta de perfil, estatísticas e taxa de vitórias.
* Alteração de dados cadastrais e avatares.
* Geração de Rankings dinâmicos (Ordenação por Top Vitórias e Top Moedas).

### 2. Camada de Jogo (WebSocket)
Motor de estado em memória (RAM) que processa as regras de negócio durante as partidas.
* **Matchmaking:** Fila de espera e alocação dinâmica de jogadores.
* **Sincronização de Estado:** Distribuição segura de cartas, passagem de turnos e verificação de movimentos válidos.
* **Resolução de Conflitos (Bluff Engine):** Lógica de acusações (Challenge) e validação cruzada das cartas jogadas na mesa.
* **Sistema de Punição (Jokenpo):** Execução do duelo de penalidade automatizado contra o servidor.
* **Gestão de Sessão e AFK:** Cronômetros de inatividade de 1 minuto ("Death Clock"), processamento de W.O., sistemas de desistência (Surrender) e protocolo rigoroso para recuperação de estado em quedas de conexão (Reconnection).
* **Economia:** Distribuição automatizada de moedas baseada na colocação final do jogador na partida.

## Pré-requisitos

Para executar este servidor localmente, é necessário ter instalado em sua máquina:
* Node.js (v18 ou superior)
* npm ou yarn
* PostgreSQL (Local ou em Nuvem)

## Configuração do Ambiente

1. Clone o repositório:
```bash
git clone [https://github.com/luisffarias-dev/API-Liars.git](https://github.com/luisffarias-dev/API-Liars.git)
cd API-Liars
