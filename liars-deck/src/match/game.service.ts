import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; 
import { Server, Socket } from 'socket.io';

// 1. Definimos o que fica salvo na RAM do servidor
interface GameState {
  playerIds: string[];
  playerNicknames: Record<string, string>; // Dicionário para salvar os nicknames em RAM (userId -> nickname)
  currentTurnIndex: number;
  isPenaltyMode?: boolean;
  roundCard: string; // A carta que a mesa exige nesta rodada
  cardsOnTableCount: number; // Acumulador de cartas na mesa
  lastPlay?: {
    userId: string;
    cardsPlayed: string[]; // Array de cartas jogadas
  };
}

@Injectable()
export class GameService {
  // 2. O Map que segura a partida na memória
  private activeGames: Map<string, GameState> = new Map();
  private disconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(private prisma: PrismaService) {}

  async initializeGame(matchId: string, playerIds: string[], server: Server) {
    console.log(`[Game] 🃏 Iniciando distribuição para a partida ${matchId}`);

    // --- BUSCA OS NICKNAMES DOS JOGADORES NO BANCO ---
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

    // Sorteia a Carta da Rodada Inicial (ROCK, PAPER ou SCISSORS)
    const validCards = ['ROCK', 'PAPER', 'SCISSORS'];
    const initialRoundCard = validCards[Math.floor(Math.random() * validCards.length)];

    server.to(matchId).emit('game_ready', { 
      message: 'As cartas foram distribuídas! O duelo começou.',
      matchId: matchId
    });

    // 3. Salva o estado da partida em memória (RAM)
    this.activeGames.set(matchId, {
      playerIds: playerIds,
      playerNicknames: playerNicknames, // Salva o dicionário de nicknames na RAM
      currentTurnIndex: 0, 
      isPenaltyMode: false,
      roundCard: initialRoundCard,
      cardsOnTableCount: 0
    });

    // 4. Inicia o primeiro turno
    this.emitTurn(matchId, server);
  }

  // --- Função para emitir de quem é a vez ---
  private emitTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    const currentPlayerId = game.playerIds[game.currentTurnIndex];
    const currentPlayerNickname = game.playerNicknames[currentPlayerId] || currentPlayerId;

    console.log(`[Game] ⏳ Turno de ${currentPlayerNickname} (${currentPlayerId}) | Carta: ${game.roundCard}`);

    // Avisa a SALA INTEIRA de quem é a vez, qual a carta da rodada e o volume da mesa
    server.to(matchId).emit('turn_start', {
      currentPlayerId: currentPlayerId,
      currentPlayerNickname: currentPlayerNickname, // Enviando o Nickname limpo para o Frontend
      roundCard: game.roundCard,
      cardsOnTableCount: game.cardsOnTableCount,
      message: `É a vez de ${currentPlayerNickname}!`
    });
  }

  // --- Função para passar a vez ---
  passTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    // 👇 Proteção extra: se não houver jogadores válidos na RAM, aborta
    if (!game || game.playerIds.length === 0) return; 

    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
    
    this.activeGames.set(matchId, game);
    this.emitTurn(matchId, server);
  }

  // --- Função para processar a jogada de múltiplas cartas ---
  async processMove(matchId: string, userId: string, cardsPlayed: string[], server: Server) {
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

    // --- REGRA DE ZERAR A MÃO ---
    if (game.lastPlay) {
      const prevPlayer = await this.prisma.matchPlayer.findFirst({ where: { matchId, userId: game.lastPlay.userId } });
      if (prevPlayer && prevPlayer.cards.length === 0) {
        return this.forceLoseForNotChallenging(matchId, userId, game.lastPlay.userId, server);
      }
    }

    const player = await this.prisma.matchPlayer.findFirst({ where: { matchId, userId } });
    if (!player) return { success: false, message: 'Jogador não encontrado.' };

    // Verifica se o jogador tem TODAS as cartas selecionadas
    const newHand = [...player.cards];
    for (const card of cardsPlayed) {
      const index = newHand.indexOf(card);
      if (index === -1) {
        return { success: false, message: 'Você não possui essas cartas na mão.' };
      }
      newHand.splice(index, 1);
    }

    // Atualiza o banco com a nova mão (cartas removidas)
    await this.prisma.matchPlayer.updateMany({ where: { matchId, userId }, data: { cards: newHand } });

    const playerNick = game.playerNicknames[userId] || 'Oponente';
    console.log(`[Game] ${playerNick} jogou ${cardsPlayed.length} carta(s) alegando ser ${game.roundCard}`);

    // Atualiza a memória
    game.cardsOnTableCount += cardsPlayed.length;
    game.lastPlay = { userId, cardsPlayed };
    this.activeGames.set(matchId, game);

    // Notifica a mesa sobre a jogada
    server.to(matchId).emit('card_played', {
      userId: userId,
      count: cardsPlayed.length,
      cardsLeft: newHand.length,
      totalOnTable: game.cardsOnTableCount,
      message: `${playerNick} colocou ${cardsPlayed.length} carta(s) na mesa.`
    });

    // Passa o turno para o próximo jogador
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

    // ---> NOVA REGRA: TRATANDO O EMPATE <---
    if (playerChoice === pcChoice) {
      console.log(`[Game] ⚖️ Empate no Jokenpô! ${playerNick} e PC escolheram ${pcChoice}.`);
      
      server.to(matchId).emit('penalty_result', {
        userId,
        playerChoice,
        pcChoice,
        isEliminated: false,
        isTie: true, // Avisa o front que foi empate
        message: `⚖️ EMPATE! PC também escolheu ${pcChoice}. Jogue novamente!`
      });
      
      // Retorna mais cedo. NÃO chama o checkGameOverOrContinue e não limpa a punição.
      return { success: true };
    }

    // Se não foi empate, verifica quem ganhou
    let isEliminated = false;
    if (
      (playerChoice === 'ROCK' && pcChoice === 'SCISSORS') ||
      (playerChoice === 'PAPER' && pcChoice === 'ROCK') ||
      (playerChoice === 'SCISSORS' && pcChoice === 'PAPER')
    ) {
      isEliminated = false; // Jogador ganhou da máquina
    } else {
      isEliminated = true;  // Jogador perdeu da máquina
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
      // TEMOS UM VENCEDOR!
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
        
        // 👇 A MÁGICA ACONTECE AQUI: Atualiza a RAM removendo quem foi eliminado
        const survivorIds = survivors.map(s => s.userId);
        game.playerIds = game.playerIds.filter(id => survivorIds.includes(id));
        
        // Como o array de jogadores diminuiu, garantimos que o currentTurnIndex não estoure os limites
        if (game.currentTurnIndex >= game.playerIds.length) {
            game.currentTurnIndex = 0; 
        }

        // REDISTRIBUIÇÃO DE CARTAS
        const deck = this.generateDeck();
        const shuffledDeck = this.shuffle(deck);

        // Distribui apenas para quem ainda está vivo (survivors)
        for (let i = 0; i < survivors.length; i++) {
          const survivorId = survivors[i].userId;
          const hand = shuffledDeck.slice(i * 13, (i + 1) * 13);
          
          await this.prisma.matchPlayer.updateMany({
            where: { matchId: matchId, userId: survivorId },
            data: { cards: hand }
          });

          // Envia o evento avisando o jogador específico da nova mão dele
          server.to(survivorId).emit('new_round_cards', { 
            myCards: hand,
            opponentCardsLeft: 13 
          });
        }

        // Passa o turno para o próximo vivo (baseado na nova lista limpa)
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

  // --- Embaralhamento (Fisher-Yates) ---
  private shuffle(array: string[]): string[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }

  // --- Recuperar a partida em caso de Reload/Queda rápida ---
  async recoverGameState(userId: string, client: Socket) {
    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
      console.log(`[AFK] 🛑 Eliminação cancelada! Jogador ${userId} reconectou a tempo.`);
    }

    const playerRecord = await this.prisma.matchPlayer.findFirst({
      where: { 
        userId: userId, 
        match: { status: { in: ['PLAYING', 'PENALTY'] } } 
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

    // Monta estado recuperado
    const state = {
      matchId: matchId,
      matchStatus: playerRecord.match.status,
      myStatus: playerRecord.status,
      myCards: playerRecord.cards,
      currentTurnPlayerId: currentPlayerId,
      currentTurnPlayerNickname: game.playerNicknames[currentPlayerId], // Envia o nickname da vez
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