import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; 
import { Server, Socket } from 'socket.io';

// 1. Definimos o que fica salvo na RAM do servidor
interface GameState {
  playerIds: string[];
  playerNicknames: Record<string, string>;
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
  // 2. Os Maps que seguram a partida e os cronômetros na memória
  private activeGames: Map<string, GameState> = new Map();
  private disconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  // 👇 NOVO: Relógio da morte de 1 minuto para inatividade
  private turnTimeouts: Map<string, NodeJS.Timeout> = new Map(); 

  constructor(private prisma: PrismaService) {}

  // --- Função Auxiliar: Desarma a bomba de 1 minuto ---
  private clearTurnTimeout(matchId: string) {
    if (this.turnTimeouts.has(matchId)) {
      clearTimeout(this.turnTimeouts.get(matchId));
      this.turnTimeouts.delete(matchId);
    }
  }

  async initializeGame(matchId: string, playerIds: string[], server: Server) {
    console.log(`[Game] 🃏 Iniciando distribuição para a partida ${matchId}`);

    const users = await this.prisma.user.findMany({
      where: { id: { in: playerIds } }
    });
    
    const playerNicknames: Record<string, string> = {};
    for (const u of users) {
      playerNicknames[u.id] = u['nickname'] || u['name'] || 'Jogador';
    }

    const deck = this.generateDeck();
    const shuffledDeck = this.shuffle(deck);

    for (let i = 0; i < playerIds.length; i++) {
      const userId = playerIds[i];
      const hand = shuffledDeck.slice(i * 13, (i + 1) * 13);
      
      try {
        await this.prisma.matchPlayer.updateMany({
          where: { matchId: matchId, userId: userId },
          data: { cards: hand }
        });

        server.to(userId).emit('your_hand', { cards: hand });
      } catch (error) {
        console.error(`[Game] ❌ Erro ao salvar a mão:`, error.message);
      }
    }

    const validCards = ['ROCK', 'PAPER', 'SCISSORS'];
    const initialRoundCard = validCards[Math.floor(Math.random() * validCards.length)];

    server.to(matchId).emit('game_ready', { 
      message: 'As cartas foram distribuídas! O duelo começou.',
      matchId: matchId
    });

    this.activeGames.set(matchId, {
      playerIds: playerIds,
      playerNicknames: playerNicknames,
      currentTurnIndex: 0, 
      isPenaltyMode: false,
      roundCard: initialRoundCard,
      cardsOnTableCount: 0
    });

    this.emitTurn(matchId, server);
  }

  // --- Função para emitir de quem é a vez ---
  private emitTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    const currentPlayerId = game.playerIds[game.currentTurnIndex];
    const currentPlayerNickname = game.playerNicknames[currentPlayerId] || currentPlayerId;

    console.log(`[Game] ⏳ Turno de ${currentPlayerNickname} (${currentPlayerId}) | Carta: ${game.roundCard}`);

    server.to(matchId).emit('turn_start', {
      currentPlayerId: currentPlayerId,
      currentPlayerNickname: currentPlayerNickname,
      roundCard: game.roundCard,
      cardsOnTableCount: game.cardsOnTableCount,
      message: `É a vez de ${currentPlayerNickname}!`
    });

    // 👇 NOVO: Limpa o timer velho e inicia a contagem de 60 segundos
    this.clearTurnTimeout(matchId);
    const timeout = setTimeout(() => {
      this.handleTurnTimeout(matchId, currentPlayerId, server);
    }, 60000); // 60 segundos = 1 minuto

    this.turnTimeouts.set(matchId, timeout);
  }

  // --- 👇 NOVO: Função que elimina o jogador afk e reinicia a rodada ---
  async handleTurnTimeout(matchId: string, afkPlayerId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    // Se a partida mudou de vez muito rápido, aborta pra não bugar
    if (game.playerIds[game.currentTurnIndex] !== afkPlayerId) return;

    this.clearTurnTimeout(matchId);
    const playerNick = game.playerNicknames[afkPlayerId] || 'Um jogador';
    
    console.log(`[TIMEOUT] ⏳ 1 minuto esgotado! ${playerNick} será eliminado da sala ${matchId}`);

    // Elimina no banco de dados
    await this.prisma.matchPlayer.updateMany({
      where: { matchId: matchId, userId: afkPlayerId },
      data: { status: 'ELIMINATED' },
    });

    server.to(matchId).emit('player_eliminated_afk', {
      userId: afkPlayerId,
      message: `💀 ${playerNick} demorou 1 minuto e foi ELIMINADO por inatividade! Iniciando nova rodada...`
    });

    // Aproveitamos a sua função que já sabe como limpar a mesa e iniciar nova rodada (ou finalizar se só sobrar 1)
    await this.checkGameOverOrContinue(matchId, server);
  }

  // --- Função para passar a vez ---
  passTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game || game.playerIds.length === 0) return; 

    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
    
    this.activeGames.set(matchId, game);
    this.emitTurn(matchId, server);
  }

  // --- Função para processar a jogada de múltiplas cartas ---
  async processMove(matchId: string, userId: string, cardsPlayed: string[], server: Server) {
    // 👇 NOVO: O jogador agiu, desarma a bomba!
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

  // --- Função Auxiliar: Punição por não duvidar ---
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

  // --- Função do Desafio (DUVIDAR / MENTIRA) ---
  async challengeMove(matchId: string, challengerId: string, server: Server) {
    // 👇 NOVO: O jogador agiu, desarma a bomba!
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

  // --- Resolução do Jokenpô (Punição) ---
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

  // --- Verifica Fim de Jogo ou Continua (Nova Rodada) ---
  private async checkGameOverOrContinue(matchId: string, server: Server) {
    const survivors = await this.prisma.matchPlayer.findMany({
      where: { matchId, status: { not: 'ELIMINATED' } }
    });

    if (survivors.length <= 1) {
      this.clearTurnTimeout(matchId); // Garante que a bomba não exploda depois de acabar
      
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
      // O JOGO CONTINUA - NOVA RODADA
      await this.prisma.match.update({ where: { id: matchId }, data: { status: 'PLAYING' } });

      const game = this.activeGames.get(matchId);
      if (game) {
        game.isPenaltyMode = false; 
        game.lastPlay = undefined;
        game.cardsOnTableCount = 0;

        const validCards = ['ROCK', 'PAPER', 'SCISSORS'];
        game.roundCard = validCards[Math.floor(Math.random() * validCards.length)];
        
        const survivorIds = survivors.map(s => s.userId);
        game.playerIds = game.playerIds.filter(id => survivorIds.includes(id));
        
        if (game.currentTurnIndex >= game.playerIds.length) {
            game.currentTurnIndex = 0; 
        }

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

        // Passa o turno para o próximo vivo e chama o emitTurn (que vai disparar a contagem de 1 min de novo)
        game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
        
        this.activeGames.set(matchId, game);
        this.emitTurn(matchId, server);
      }
    }
  }
  
  // --- Geração do Baralho ---
  private generateDeck(): string[] {
    const deck: string[] = [];
    for (let i = 0; i < 16; i++) {
      deck.push('ROCK', 'PAPER', 'SCISSORS');
    }
    deck.push('JOKER', 'JOKER', 'JOKER', 'JOKER');
    return deck;
  }

  // --- Embaralhamento ---
  private shuffle(array: string[]): string[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }

  // --- Recuperar a partida ---
  async recoverGameState(userId: string, client: Socket) {
    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
      console.log(`[AFK] 🛑 Eliminação cancelada! Jogador ${userId} reconectou a tempo.`);
    }

    const playerRecord = await this.prisma.matchPlayer.findFirst({
      where: { 
        userId: userId, 
        match: { status: { in: ['PLAYING', 'PENALTY'] } },
        status: { not: 'ELIMINATED' } // 👇 CORREÇÃO: Impede sala zumbi pra quem já perdeu!
      },
      include: { match: true }
    });

    if (!playerRecord) {
      return { success: false, message: 'Nenhuma partida ativa encontrada.' };
    }

    const matchId = playerRecord.matchId;
    const game = this.activeGames.get(matchId);

    if (!game) {
      await this.prisma.match.update({ where: { id: matchId }, data: { status: 'FINISHED' } });
      return { success: false, message: 'Partida expirou no servidor.' };
    }

    client.join(matchId);
    client.join(userId);

    const currentPlayerId = game.playerIds[game.currentTurnIndex];

    const state = {
      matchId: matchId,
      matchStatus: playerRecord.match.status,
      myStatus: playerRecord.status,
      myCards: playerRecord.cards,
      currentTurnPlayerId: currentPlayerId,
      currentTurnPlayerNickname: game.playerNicknames[currentPlayerId],
      roundCard: game.roundCard, 
      cardsOnTableCount: game.cardsOnTableCount,
      lastPlay: game.lastPlay ? {
        userId: game.lastPlay.userId,
        count: game.lastPlay.cardsPlayed.length 
      } : null
    };

    client.emit('game_state_recovered', state);
    console.log(`[Reconexão] Jogador ${userId} voltou para a partida ${matchId}`);

    return { success: true };
  }

  // --- Lidar com desconexões prolongadas ---
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

    console.log(`[AFK] ⚠️ ${playerNick} caiu na partida ${matchId}. Iniciando timer de 30s...`);
    
    server.to(matchId).emit('player_disconnected', {
      userId,
      message: `${playerNick} perdeu a conexão. Aguardando 30 segundos para retornar...`
    });

    const timeout = setTimeout(async () => {
      console.log(`[AFK] 💀 Tempo esgotado para ${playerNick}. Aplicando W.O.`);

      await this.prisma.matchPlayer.updateMany({
        where: { matchId: matchId, userId: userId },
        data: { status: 'ELIMINATED' }
      });

      server.to(matchId).emit('player_eliminated_afk', {
        userId,
        message: `${playerNick} foi eliminado por abandono de partida!`
      });

      this.disconnectTimeouts.delete(userId);
      await this.checkGameOverOrContinue(matchId, server);
    }, 30000);

    this.disconnectTimeouts.set(userId, timeout);
  }
}