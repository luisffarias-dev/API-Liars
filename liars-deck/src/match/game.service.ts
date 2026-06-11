import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; 
import { Server, Socket } from 'socket.io';

// 1. Definição do estado da partida guardado na RAM do servidor
interface GameState {
  playerIds: string[];
  playerNicknames: Record<string, string>; // Dicionário (userId -> nickname)
  playerAvatars: Record<string, string>;   // 👇 NOVO: Dicionário (userId -> avatarIndex/Path)
  currentTurnIndex: number;
  isPenaltyMode?: boolean;
  roundCard: string; 
  cardsOnTableCount: number; 
  lastPlay?: {
    userId: string;
    cardsPlayed: string[]; 
  };
}

@Injectable()
export class GameService {
  // Maps para gerenciar o estado das salas e os cronómetros em tempo real (RAM)
  private activeGames: Map<string, GameState> = new Map();
  private disconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private turnTimeouts: Map<string, NodeJS.Timeout> = new Map(); // 👇 Cronómetro de inatividade de 1 min

  constructor(private prisma: PrismaService) {}

  // --- Função Auxiliar: Desarma o cronómetro de turno de uma sala ---
  private clearTurnTimeout(matchId: string) {
    if (this.turnTimeouts.has(matchId)) {
      clearTimeout(this.turnTimeouts.get(matchId));
      this.turnTimeouts.delete(matchId);
    }
  }

  // --- Inicialização e Distribuição de Cartas ---
  async initializeGame(matchId: string, playerIds: string[], server: Server) {
    console.log(`[Game] 🃏 Iniciando distribuição para a partida ${matchId}`);

    // Puxa os dados de todos os jogadores do banco de dados de uma só vez
    const users = await this.prisma.user.findMany({
      where: { id: { in: playerIds } }
    });
    
    const playerNicknames: Record<string, string> = {};
    const playerAvatars: Record<string, string> = {}; // 👇 NOVO: Dicionário local

    for (const u of users) {
      playerNicknames[u.id] = u['nickname'] || u['name'] || 'Jogador';
      playerAvatars[u.id] = u['avatar'] || '1'; // 👇 NOVO: Captura o avatar (padrão '1' se nulo)
    }

    const deck = this.generateDeck();
    const shuffledDeck = this.shuffle(deck);

    // Distribui 13 cartas para cada um dos 4 jogadores
    for (let i = 0; i < playerIds.length; i++) {
      const userId = playerIds[i];
      const hand = shuffledDeck.slice(i * 13, (i + 1) * 13);
      
      try {
        await this.prisma.matchPlayer.updateMany({
          where: { matchId: matchId, userId: userId },
          data: { cards: hand }
        });

        // Envia a mão privada de forma segura para cada socket individual
        server.to(userId).emit('your_hand', { cards: hand });
      } catch (error) {
        console.error(`[Game] ❌ Erro ao salvar a mão:`, error.message);
      }
    }

    const validCards = ['ROCK', 'PAPER', 'SCISSORS'];
    const initialRoundCard = validCards[Math.floor(Math.random() * validCards.length)];

    // 👇 NOVO: Monta a estrutura com ID, Nick e Avatar para enviar ao Frontend
    const playersInfo = playerIds.map(id => ({
      userId: id,
      nickname: playerNicknames[id],
      avatar: playerAvatars[id]
    }));

    // Avisa a sala inteira que o jogo começou e envia as informações estéticas dos perfis
    server.to(matchId).emit('game_ready', { 
      message: 'As cartas foram distribuídas! O duelo começou.',
      matchId: matchId,
      playersInfo: playersInfo // 👇 Dados enviados aqui!
    });

    // Salva o estado inicial na memória RAM do servidor
    this.activeGames.set(matchId, {
      playerIds: playerIds,
      playerNicknames: playerNicknames,
      playerAvatars: playerAvatars, // 👇 Registado em RAM
      currentTurnIndex: 0, 
      isPenaltyMode: false,
      roundCard: initialRoundCard,
      cardsOnTableCount: 0
    });

    // Inicia o primeiro turno da partida
    this.emitTurn(matchId, server);
  }

  // --- Emissão de Turno com Inicialização do Cronómetro ---
  private emitTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    const currentPlayerId = game.playerIds[game.currentTurnIndex];
    const currentPlayerNickname = game.playerNicknames[currentPlayerId] || currentPlayerId;

    console.log(`[Game] ⏳ Turno de ${currentPlayerNickname} (${currentPlayerId}) | Carta Pediada: ${game.roundCard}`);

    server.to(matchId).emit('turn_start', {
      currentPlayerId: currentPlayerId,
      currentPlayerNickname: currentPlayerNickname, 
      roundCard: game.roundCard,
      cardsOnTableCount: game.cardsOnTableCount,
      message: `É a vez de ${currentPlayerNickname}!`
    });

    // 👇 NOVO: Limpa o temporizador antigo e arma a bomba de inatividade de 1 minuto
    this.clearTurnTimeout(matchId);
    const timeout = setTimeout(() => {
      this.handleTurnTimeout(matchId, currentPlayerId, server);
    }, 60000); // 60.000 milissegundos = 1 minuto

    this.turnTimeouts.set(matchId, timeout);
  }

  // --- 👇 NOVO: Guilhotina de Inatividade (Executada após 1 minuto sem jogar) ---
  async handleTurnTimeout(matchId: string, afkPlayerId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    // Proteção: Garante que o jogador de facto ainda é o dono do turno atual
    if (game.playerIds[game.currentTurnIndex] !== afkPlayerId) return;

    this.clearTurnTimeout(matchId);
    const playerNick = game.playerNicknames[afkPlayerId] || 'Um jogador';
    
    console.log(`[TIMEOUT] ⏳ 1 minuto esgotado para o jogador ${playerNick} na sala ${matchId}`);

    // 1. Atualiza o status dele para ELIMINATED no banco de dados
    await this.prisma.matchPlayer.updateMany({
      where: { matchId: matchId, userId: afkPlayerId },
      data: { status: 'ELIMINATED' },
    });

    // 2. Notifica a sala sobre a eliminação por AFK
    server.to(matchId).emit('player_eliminated_afk', {
      userId: afkPlayerId,
      message: `💀 ${playerNick} demorou mais de 1 minuto para jogar e foi ELIMINADO por inatividade!`
    });

    // 3. Deixa a sua função principal avaliar se o jogo acabou ou se deve reiniciar a rodada
    await this.checkGameOverOrContinue(matchId, server);
  }

  // --- Passagem de Turno Regular ---
  passTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game || game.playerIds.length === 0) return; 

    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
    
    this.activeGames.set(matchId, game);
    this.emitTurn(matchId, server);
  }

  // --- Processamento de Jogada (Cartas na Mesa) ---
  async processMove(matchId: string, userId: string, cardsPlayed: string[], server: Server) {
    // 👇 NOVO: O jogador agiu a tempo! Desarma o cronómetro imediatamente.
    this.clearTurnTimeout(matchId);

    const game = this.activeGames.get(matchId);
    if (!game) return { success: false, message: 'Partida não encontrada.' };
    
    if (game.isPenaltyMode) {
      return { success: false, message: 'Aguarde o duelo de punição terminar!' };
    }

    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (match && match.status === 'PENALTY') {
      return { success: false, message: 'Aguarde o duelo de punição terminar!' };
    }

    const currentPlayerId = game.playerIds[game.currentTurnIndex];
    if (currentPlayerId !== userId) return { success: false, message: 'Não é a sua vez!' };

    if (!cardsPlayed || cardsPlayed.length === 0) {
      return { success: false, message: 'Você precisa jogar pelo menos uma carta!' };
    }

    if (game.lastPlay) {
      const prevPlayer = await this.prisma.matchPlayer.findFirst({ where: { matchId, userId: game.lastPlay.userId } });
      if (prevPlayer && prevPlayer.cards.length === 0) {
        return this.forceLoseForNotChallenging(matchId, userId, game.lastPlay.userId, server);
      }
    }

    const player = await this.prisma.matchPlayer.findFirst({ where: { matchId, userId } });
    if (!player) return { success: false, message: 'Jogador não encontrado.' };

    const newHand = [...player.cards];
    for (const card of cardsPlayed) {
      const index = newHand.indexOf(card);
      if (index === -1) {
        return { success: false, message: 'Você não possui essas cartas na mão.' };
      }
      newHand.splice(index, 1);
    }

    await this.prisma.matchPlayer.updateMany({ where: { matchId, userId }, data: { cards: newHand } });

    const playerNick = game.playerNicknames[userId] || 'Oponente';
    console.log(`[Game] ${playerNick} jogou ${cardsPlayed.length} carta(s) alegando ser ${game.roundCard}`);

    game.cardsOnTableCount += cardsPlayed.length;
    game.lastPlay = { userId, cardsPlayed };
    this.activeGames.set(matchId, game);

    server.to(matchId).emit('card_played', {
      userId: userId,
      count: cardsPlayed.length,
      cardsLeft: newHand.length,
      totalOnTable: game.cardsOnTableCount,
      message: `${playerNick} colocou ${cardsPlayed.length} carta(s) na mesa.`
    });

    this.passTurn(matchId, server);
    return { success: true };
  }

  // --- Punição por não duvidar quando o oponente zera a mão ---
  private async forceLoseForNotChallenging(matchId: string, loserId: string, winnerId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return { success: false };

    game.isPenaltyMode = true;
    this.activeGames.set(matchId, game);

    await this.prisma.match.update({ where: { id: matchId }, data: { status: 'PENALTY' } });
    await this.prisma.matchPlayer.updateMany({ where: { matchId, userId: loserId }, data: { status: 'IN_PENALTY' } });
    
    server.to(matchId).emit('challenge_result', {
      isLiar: false,
      actualCards: [],
      loserId: loserId,
      message: `🚨 VOCÊ PERDEU! O oponente jogou todas as cartas e você não duvidou.`
    });

    server.to(matchId).emit('start_penalty_duel', { loserId: loserId });
    return { success: true };
  }

  // --- Processamento de Desafio (DUVIDAR) ---
  async challengeMove(matchId: string, challengerId: string, server: Server) {
    // 👇 NOVO: O desafiante agiu! Desarma o cronómetro.
    this.clearTurnTimeout(matchId);

    const game = this.activeGames.get(matchId);
    if (!game || !game.lastPlay) {
      return { success: false, message: 'Não há jogada anterior para duvidar.' };
    }

    const currentPlayerId = game.playerIds[game.currentTurnIndex];
    if (currentPlayerId !== challengerId) {
      return { success: false, message: 'Você só pode duvidar no seu turno!' };
    }

    const { userId: targetId, cardsPlayed } = game.lastPlay;
    
    const isLiar = cardsPlayed.some(c => c !== game.roundCard && c !== 'JOKER');
    const loserId = isLiar ? targetId : challengerId;

    game.isPenaltyMode = true;
    this.activeGames.set(matchId, game);

    await this.prisma.match.update({ where: { id: matchId }, data: { status: 'PENALTY' } });
    await this.prisma.matchPlayer.updateMany({ 
      where: { matchId: matchId, userId: loserId }, 
      data: { status: 'IN_PENALTY' } 
    });

    console.log(`[Game] Desafio na partida ${matchId}! Mentira? ${isLiar}. Perdedor: ${loserId}`);

    server.to(matchId).emit('challenge_result', {
      challengerId: challengerId,
      targetId: targetId,
      isLiar: isLiar,
      actualCards: cardsPlayed,
      loserId: loserId,
      message: isLiar 
        ? `🚨 PEGO NA MENTIRA! As cartas reais eram: ${cardsPlayed.join(', ')}.` 
        : `❌ ACUSAÇÃO FALSA! Eram realmente cartas de ${game.roundCard} ou Mímicos.`
    });

    server.to(matchId).emit('start_penalty_duel', { loserId: loserId });

    return { success: true };
  }

  // --- Resolução do Duelo de Jokenpô (Punição) ---
  async resolvePenaltyDuel(matchId: string, userId: string, playerChoice: string, server: Server) {
    const validChoices = ['ROCK', 'PAPER', 'SCISSORS'];
    if (!validChoices.includes(playerChoice)) {
      return { success: false, message: 'Escolha inválida. Use ROCK, PAPER ou SCISSORS.' };
    }

    const player = await this.prisma.matchPlayer.findFirst({
      where: { matchId, userId, status: 'IN_PENALTY' }
    });

    if (!player) {
      return { success: false, message: 'Você não está em um duelo de punição.' };
    }

    const pcChoice = validChoices[Math.floor(Math.random() * validChoices.length)];
    const game = this.activeGames.get(matchId);
    const playerNick = game?.playerNicknames[userId] || 'O jogador';

    if (playerChoice === pcChoice) {
      console.log(`[Game] ⚖️ Empate no Jokenpô! ${playerNick} e PC escolheram ${pcChoice}.`);
      
      server.to(matchId).emit('penalty_result', {
        userId,
        playerChoice,
        pcChoice,
        isEliminated: false,
        isTie: true,
        message: `⚖️ EMPATE! PC também escolheu ${pcChoice}. Jogue novamente!`
      });
      
      return { success: true };
    }

    let isEliminated = false;
    if (
      (playerChoice === 'ROCK' && pcChoice === 'SCISSORS') ||
      (playerChoice === 'PAPER' && pcChoice === 'ROCK') ||
      (playerChoice === 'SCISSORS' && pcChoice === 'PAPER')
    ) {
      isEliminated = false;
    } else {
      isEliminated = true;
    }

    const newStatus = isEliminated ? 'ELIMINATED' : 'SAFE';
    await this.prisma.matchPlayer.updateMany({
      where: { matchId, userId },
      data: { status: newStatus }
    });

    server.to(matchId).emit('penalty_result', {
      userId,
      playerChoice,
      pcChoice,
      isEliminated,
      isTie: false,
      message: isEliminated 
        ? `💀 FIM DA LINHA! PC escolheu ${pcChoice}. ${playerNick} foi ELIMINADO!` 
        : `🎉 SOBREVIVEU! PC escolheu ${pcChoice}. Retornando ao jogo...`
    });

    await this.checkGameOverOrContinue(matchId, server);

    if (isEliminated) {
      console.log(`[Game] 🥾 Expulsando jogador ${userId} da sala ${matchId} (Eliminado)`);
      server.in(userId).socketsLeave(matchId);
    }

    return { success: true };
  }

  // --- Verificação de Fim de Jogo ou Continuação da Próxima Rodada ---
  private async checkGameOverOrContinue(matchId: string, server: Server) {
    const survivors = await this.prisma.matchPlayer.findMany({
      where: { matchId, status: { not: 'ELIMINATED' } }
    });

    if (survivors.length <= 1) {
      this.clearTurnTimeout(matchId); // Para o relógio se a partida acabar
      
      const winnerId = survivors.length === 1 ? survivors[0].userId : null;
      
      await this.prisma.match.update({ 
        where: { id: matchId }, 
        data: { status: 'FINISHED' } 
      });

      const allPlayers = await this.prisma.matchPlayer.findMany({ where: { matchId } });
      for (const p of allPlayers) {
        await this.prisma.user.update({
          where: { id: p.userId },
          data: { matchesPlayed: { increment: 1 } }
        });
      }

      if (winnerId) {
        await this.prisma.user.update({
          where: { id: winnerId },
          data: { wins: { increment: 1 } }
        });
      }

      const game = this.activeGames.get(matchId);
      const winnerNick = winnerId && game ? game.playerNicknames[winnerId] : null;

      server.to(matchId).emit('game_over', { 
        winnerId: winnerId, 
        message: winnerId ? `🏆 ${winnerNick} é o grande campeão!` : '🤝 Empate/Todos eliminados.' 
      });

      this.activeGames.delete(matchId);
    } else { 
      // O JOGO CONTINUA - NOVA RODADA COMPLETA
      await this.prisma.match.update({ where: { id: matchId }, data: { status: 'PLAYING' } });

      const game = this.activeGames.get(matchId);
      if (game) {
        game.isPenaltyMode = false; 
        game.lastPlay = undefined;
        game.cardsOnTableCount = 0;

        const validCards = ['ROCK', 'PAPER', 'SCISSORS'];
        game.roundCard = validCards[Math.floor(Math.random() * validCards.length)];
        
        // Remove quem morreu da lista ativa na RAM
        const survivorIds = survivors.map(s => s.userId);
        game.playerIds = game.playerIds.filter(id => survivorIds.includes(id));
        
        if (game.currentTurnIndex >= game.playerIds.length) {
            game.currentTurnIndex = 0; 
        }

        // Gera e redistribui novo baralho limpo de 13 cartas para os sobreviventes
        const deck = this.generateDeck();
        const shuffledDeck = this.shuffle(deck);

        for (let i = 0; i < survivors.length; i++) {
          const survivorId = survivors[i].userId;
          const hand = shuffledDeck.slice(i * 13, (i + 1) * 13);
          
          await this.prisma.matchPlayer.updateMany({
            where: { matchId: matchId, userId: survivorId },
            data: { cards: hand }
          });

          server.to(survivorId).emit('new_round_cards', { 
            myCards: hand,
            opponentCardsLeft: 13 
          });
        }

        // Passa a vez e dispara o emitTurn (que ativa o novo temporizador de 1 minuto)
        game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
        
        this.activeGames.set(matchId, game);
        this.emitTurn(matchId, server);
      }
    }
  }

  // --- 👇 NOVO: Sistema de Desistência Instantânea (Quit/Surrender) ---
  async surrenderMatch(matchId: string, userId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    const playerNick = game.playerNicknames[userId] || 'Um jogador';
    console.log(`[Quit] 🏳️ ${playerNick} abandonou voluntariamente a partida ${matchId}.`);

    // 1. Desarma imediatamente os cronómetros dele (AFK de queda de net e de turno)
    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
    }
    if (game.playerIds[game.currentTurnIndex] === userId) {
        this.clearTurnTimeout(matchId);
    }

    // 2. Executa a morte no banco instantaneamente
    await this.prisma.matchPlayer.updateMany({
      where: { matchId: matchId, userId: userId },
      data: { status: 'ELIMINATED' }
    });

    // 3. Alerta a mesa do abandono
    server.to(matchId).emit('player_surrendered', {
      userId: userId,
      message: `🏳️ ${playerNick} capitulou e abandonou a partida!`
    });

    // 4. Ejeta o socket da sala do Socket.io
    server.in(userId).socketsLeave(matchId);

    // 5. Avalia o encerramento do jogo
    await this.checkGameOverOrContinue(matchId, server);
  }

  // --- Recuperação de Estado Avançada (Reconexões) ---
  async recoverGameState(userId: string, client: Socket) {
    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
      console.log(`[AFK] 🛑 Eliminação revogada! Jogador ${userId} reconectou.`);
    }

    // 👇 TRAVA ANTI-LIMBO ATIVADA: Ignora se o jogador já estiver como ELIMINATED no banco
    const playerRecord = await this.prisma.matchPlayer.findFirst({
      where: { 
        userId: userId, 
        match: { status: { in: ['PLAYING', 'PENALTY'] } },
        status: { not: 'ELIMINATED' } 
      },
      include: { match: true }
    });

    if (!playerRecord) {
      return { success: false, message: 'Nenhuma partida ativa encontrada para este perfil.' };
    }

    const matchId = playerRecord.matchId;
    const game = this.activeGames.get(matchId);

    if (!game) {
      await this.prisma.match.update({ where: { id: matchId }, data: { status: 'FINISHED' } });
      return { success: false, message: 'A mesa expirou na RAM do servidor.' };
    }

    client.join(matchId);
    client.join(userId);

    const currentPlayerId = game.playerIds[game.currentTurnIndex];

    // 👇 NOVO: Remonta e envia a lista de quem ainda está jogando e suas fotos de perfil
    const playersInfo = game.playerIds.map(id => ({
      userId: id,
      nickname: game.playerNicknames[id],
      avatar: game.playerAvatars[id]
    }));

    const state = {
      matchId: matchId,
      matchStatus: playerRecord.match.status,
      myStatus: playerRecord.status,
      myCards: playerRecord.cards,
      currentTurnPlayerId: currentPlayerId,
      currentTurnPlayerNickname: game.playerNicknames[currentPlayerId],
      roundCard: game.roundCard, 
      cardsOnTableCount: game.cardsOnTableCount,
      playersInfo: playersInfo, // 👇 Reenviando a lista na reconexão
      lastPlay: game.lastPlay ? {
        userId: game.lastPlay.userId,
        count: game.lastPlay.cardsPlayed.length 
      } : null
    };

    client.emit('game_state_recovered', state);
    console.log(`[Reconexão] Jogador ${userId} recuperou o assento na partida ${matchId}`);

    return { success: true };
  }

  // --- Gerenciamento de Quedas Involuntárias (Internet/App Fechado sem Desistir) ---
  async handlePlayerDisconnect(userId: string, server: Server) {
    const player = await this.prisma.matchPlayer.findFirst({
      where: { 
        userId: userId, 
        match: { status: { in: ['PLAYING', 'PENALTY'] } },
        status: { not: 'ELIMINATED' } 
      }
    });

    if (!player) return;

    const matchId = player.matchId;
    const game = this.activeGames.get(matchId);
    const playerNick = game?.playerNicknames[userId] || 'Um jogador';

    console.log(`[AFK] ⚠️ ${playerNick} perdeu a ligação com a partida ${matchId}. Aguardando 30s de tolerância...`);
    
    server.to(matchId).emit('player_disconnected', {
      userId,
      message: `${playerNick} perdeu a conexão. Aguardando 30 segundos para retornar...`
    });

    const timeout = setTimeout(async () => {
      console.log(`[AFK] 💀 W.O. aplicado! Tempo esgotado para o jogador ${playerNick}.`);

      await this.prisma.matchPlayer.updateMany({
        where: { matchId: matchId, userId: userId },
        data: { status: 'ELIMINATED' }
      });

      server.to(matchId).emit('player_eliminated_afk', {
        userId,
        message: `💀 ${playerNick} foi eliminado por abandono involuntário de partida!`
      });

      this.disconnectTimeouts.delete(userId);
      await this.checkGameOverOrContinue(matchId, server);
    }, 30000); // 30 segundos para reconectar

    this.disconnectTimeouts.set(userId, timeout);
  }

  // --- Algoritmos Internos do Deck ---
  private generateDeck(): string[] {
    const deck: string[] = [];
    for (let i = 0; i < 16; i++) {
      deck.push('ROCK', 'PAPER', 'SCISSORS');
    }
    deck.push('JOKER', 'JOKER', 'JOKER', 'JOKER');
    return deck;
  }

  private shuffle(array: string[]): string[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }
}