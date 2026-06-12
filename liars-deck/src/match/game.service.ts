import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; 
import { Server, Socket } from 'socket.io';

interface GameState {
  playerIds: string[];
  playerNicknames: Record<string, string>;
  playerAvatars: Record<string, string>;
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
  private activeGames: Map<string, GameState> = new Map();
  private disconnectTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private turnTimeouts: Map<string, NodeJS.Timeout> = new Map();

  constructor(private prisma: PrismaService) {}

  private clearTurnTimeout(matchId: string) {
    if (this.turnTimeouts.has(matchId)) {
      clearTimeout(this.turnTimeouts.get(matchId));
      this.turnTimeouts.delete(matchId);
    }
  }

  // 👇 NOVA FUNÇÃO: Limpa TODOS os timers de uma partida
  private clearAllMatchTimeouts(matchId: string, playerIds: string[]) {
    // 1. Limpa o timer do turno (60s)
    this.clearTurnTimeout(matchId);

    // 2. Limpa os timers de desconexão (30s) de todos os jogadores daquela mesa
    for (const id of playerIds) {
      if (this.disconnectTimeouts.has(id)) {
        clearTimeout(this.disconnectTimeouts.get(id));
        this.disconnectTimeouts.delete(id);
      }
    }
  }

  async initializeGame(matchId: string, playerIds: string[], server: Server) {
    console.log(`[Game] 🃏 Iniciando distribuição para a partida ${matchId}`);

    const users = await this.prisma.user.findMany({
      where: { id: { in: playerIds } }
    });
    
    const playerNicknames: Record<string, string> = {};
    const playerAvatars: Record<string, string> = {}; 

    for (const u of users) {
      playerNicknames[u.id] = u['nickname'] || u['name'] || 'Jogador';
      playerAvatars[u.id] = u['avatar'] || '1'; 
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

    // 👇 CORREÇÃO: Enviando o formato de payload esperado pelo seu cliente Flutter novo
    const playersInfo = playerIds.map(id => ({
      id: id, // Usando 'id' conforme seu novo Flutter espera
      nickname: playerNicknames[id],
      avatar: playerAvatars[id],
      cardsCount: 13,
      isAlive: true
    }));

    server.to(matchId).emit('game_ready', { 
      message: 'As cartas foram distribuídas! O duelo começou.',
      matchId: matchId,
      playersInfo: playersInfo
    });

    // Enviar o match_started também para garantir
    server.to(matchId).emit('match_started', {
      playersInfo: playersInfo,
      currentTurnPlayerId: playerIds[0] // Define provisoriamente o primeiro jogador
    });

    this.activeGames.set(matchId, {
      playerIds: playerIds,
      playerNicknames: playerNicknames,
      playerAvatars: playerAvatars, 
      currentTurnIndex: 0, 
      isPenaltyMode: false,
      roundCard: initialRoundCard,
      cardsOnTableCount: 0
    });

    this.emitTurn(matchId, server);
  }

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

    this.clearTurnTimeout(matchId);
    const timeout = setTimeout(() => {
      this.handleTurnTimeout(matchId, currentPlayerId, server);
    }, 60000); 

    this.turnTimeouts.set(matchId, timeout);
  }

  async handleTurnTimeout(matchId: string, afkPlayerId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return; // Trava contra partidas fantasmas

    if (game.playerIds[game.currentTurnIndex] !== afkPlayerId) return;

    this.clearTurnTimeout(matchId);
    const playerNick = game.playerNicknames[afkPlayerId] || 'Um jogador';
    
    console.log(`[TIMEOUT] ⏳ 1 minuto esgotado para o jogador ${playerNick} na sala ${matchId}`);

    await this.prisma.matchPlayer.updateMany({
      where: { matchId: matchId, userId: afkPlayerId },
      data: { status: 'ELIMINATED' },
    });

    server.to(matchId).emit('player_eliminated_afk', {
      userId: afkPlayerId,
      message: `💀 ${playerNick} demorou mais de 1 minuto para jogar e foi ELIMINADO por inatividade!`
    });

    // 👇 Passa o ID do eliminado para receber as moedas
    await this.checkGameOverOrContinue(matchId, server, afkPlayerId);
  }

  passTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game || game.playerIds.length === 0) return; 

    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
    
    this.activeGames.set(matchId, game);
    this.emitTurn(matchId, server);
  }

  async processMove(matchId: string, userId: string, cardsPlayed: string[], server: Server) {
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

  async challengeMove(matchId: string, challengerId: string, server: Server) {
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

    // 👇 Passa o ID se ele foi eliminado para calcular os ganhos
    await this.checkGameOverOrContinue(matchId, server, isEliminated ? userId : undefined);

    if (isEliminated) {
      console.log(`[Game] 🥾 Expulsando jogador ${userId} da sala ${matchId} (Eliminado)`);
      server.in(userId).socketsLeave(matchId);
    }

    return { success: true };
  }

  // --- 👇 ATUALIZADO: Verificação de Fim de Jogo e Distribuição de Moedas ---
  private async checkGameOverOrContinue(matchId: string, server: Server, newlyEliminatedId?: string) {
    const game = this.activeGames.get(matchId);
    if (!game) return; // Trava de segurança: Se o jogo não existe na memória, ignora (evita loops)

    const survivors = await this.prisma.matchPlayer.findMany({
      where: { matchId, status: { not: 'ELIMINATED' } }
    });

    // ==========================================
    // 💰 SISTEMA DE RECOMPENSAS E APOSTAS
    // ==========================================
    if (newlyEliminatedId) {
      let coinsWon = 0;
      // Define a recompensa baseada em quantos sobreviveram
      if (survivors.length === 3) coinsWon = 0;  // Ele foi o 1º a morrer (4º lugar)
      if (survivors.length === 2) coinsWon = 10; // Ele foi o 2º a morrer (3º lugar)
      if (survivors.length === 1) coinsWon = 25; // Ele foi o 3º a morrer (2º lugar)

      if (coinsWon > 0) {
        await this.prisma.user.update({
          where: { id: newlyEliminatedId },
          data: { coins: { increment: coinsWon } }
        });

        // Avisa o jogador que ele faturou uma grana (você pode ouvir esse evento no Flutter pra soltar um som de moeda!)
        server.to(newlyEliminatedId).emit('coins_awarded', { 
          coins: coinsWon, 
          message: `💰 Você ganhou ${coinsWon} moedas pela sua colocação!` 
        });
      }
    }
    // ==========================================

    if (survivors.length <= 1) {
      // 👇 IMPLEMENTADO: Limpeza total de timers
      this.clearAllMatchTimeouts(matchId, game.playerIds);
      
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

      // 🏆 Premiar o Vencedor Absoluto (Top 1)
      if (winnerId) {
        await this.prisma.user.update({
          where: { id: winnerId },
          data: { 
            wins: { increment: 1 },
            coins: { increment: 50 } // 👈 Prêmio do 1º Lugar!
          }
        });

        server.to(winnerId).emit('coins_awarded', { 
          coins: 50, 
          message: `🏆 GRANDE VITÓRIA! Você levou o prêmio máximo de 50 moedas!` 
        });
      }

      const winnerNick = winnerId ? game.playerNicknames[winnerId] : null;

      server.to(matchId).emit('game_over', { 
        winnerId: winnerId, 
        message: winnerId ? `🏆 ${winnerNick} é o grande campeão!` : '🤝 Empate/Todos eliminados.' 
      });

      // 👇 IMPLEMENTADO: Apaga a partida da RAM para impedir partidas fantasmas
      this.activeGames.delete(matchId);
      console.log(`[Game] 🧹 Mesa ${matchId} limpa e encerrada.`);
    } else { 
      // O JOGO CONTINUA - NOVA RODADA COMPLETA
      await this.prisma.match.update({ where: { id: matchId }, data: { status: 'PLAYING' } });

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

        // Prepara os dados atualizados dos jogadores para mandar no novo round
        const playersInfo = game.playerIds.map(id => ({
          id: id,
          nickname: game.playerNicknames[id],
          avatar: game.playerAvatars[id],
          cardsCount: 13,
          isAlive: true
        }));

        for (let i = 0; i < survivors.length; i++) {
          const survivorId = survivors[i].userId;
          const hand = shuffledDeck.slice(i * 13, (i + 1) * 13);
          
          await this.prisma.matchPlayer.updateMany({
            where: { matchId: matchId, userId: survivorId },
            data: { cards: hand }
          });

          server.to(survivorId).emit('new_round_cards', { 
            myCards: hand,
            playersInfo: playersInfo // Mandando as informações da mesa atualizadas
          });
        }

        game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
        
        this.activeGames.set(matchId, game);
        this.emitTurn(matchId, server);
      }
    }
  }

  async surrenderMatch(matchId: string, userId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    const playerNick = game.playerNicknames[userId] || 'Um jogador';
    console.log(`[Quit] 🏳️ ${playerNick} abandonou voluntariamente a partida ${matchId}.`);

    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
    }
    if (game.playerIds[game.currentTurnIndex] === userId) {
        this.clearTurnTimeout(matchId);
    }

    await this.prisma.matchPlayer.updateMany({
      where: { matchId: matchId, userId: userId },
      data: { status: 'ELIMINATED' }
    });

    server.to(matchId).emit('player_surrendered', {
      userId: userId,
      message: `🏳️ ${playerNick} arregou e abandonou a partida!`
    });

    server.in(userId).socketsLeave(matchId);

    // 👇 Passa o ID do cara que desistiu para calcular se ele ganha moedas
    await this.checkGameOverOrContinue(matchId, server, userId);
  }

  async recoverGameState(userId: string, client: Socket) {
    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
      console.log(`[AFK] 🛑 Eliminação revogada! Jogador ${userId} reconectou.`);
    }

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

    const playersInfo = game.playerIds.map(id => ({
      id: id,
      nickname: game.playerNicknames[id],
      avatar: game.playerAvatars[id],
      cardsCount: 13, // Isso pode ser dinâmico buscando no banco depois, mas para iniciar o round serve
      isAlive: true
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
      playersInfo: playersInfo, 
      lastPlay: game.lastPlay ? {
        userId: game.lastPlay.userId,
        count: game.lastPlay.cardsPlayed.length 
      } : null
    };

    client.emit('game_state_recovered', state);
    console.log(`[Reconexão] Jogador ${userId} recuperou o assento na partida ${matchId}`);

    return { success: true };
  }

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
      // Trava de segurança no timer
      const currentGameState = this.activeGames.get(matchId);
      if (!currentGameState) return;

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

      // 👇 Passa o ID do jogador desconectado para avaliar a recompensa dele
      await this.checkGameOverOrContinue(matchId, server, userId);
    }, 30000); 

    this.disconnectTimeouts.set(userId, timeout);
  }

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