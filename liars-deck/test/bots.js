const { io } = require('socket.io-client');

// Função para criar um bot
function criarBot(email, senha) {
  // 1. Faz o fetch do login (igual você fez no HTML) para pegar o token
  // 2. Conecta no socket
  const socket = io('http://localhost:3000', { auth: { token: 'TOKEN_DO_BOT' } });

  socket.on('connect', () => {
    console.log(`🤖 Bot conectado! Entrando na fila...`);
    socket.emit('find_match');
  });

  socket.on('turn_start', (data) => {
    // Se for a vez do bot, ele joga uma carta aleatória depois de 2 segundos!
    if (data.currentPlayerId === MEU_ID) {
      setTimeout(() => {
        socket.emit('play_card', { matchId: data.matchId, cardsPlayed: ['ROCK'] });
      }, 2000);
    }
  });
}

// Cria 4 bots de uma vez
criarBot('bot1@teste.com', '123456');
criarBot('bot2@teste.com', '123456');
criarBot('bot3@teste.com', '123456');
criarBot('bot4@teste.com', '123456');