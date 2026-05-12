import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service'; 
import { Server, Socket } from 'socket.io';

// 1. Definimos o que fica salvo na RAM do servidor
interface GameState {
  playerIds: string[];
  currentTurnIndex: number;
  // Guarda quem jogou a última carta e o que era para a mecânica de Blefe
  lastPlay?: {
    userId: string;
    cardPlayed: string;
    claimedCard: string;
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

    server.to(matchId).emit('game_ready', { 
      message: 'As cartas foram distribuídas! O duelo começou.',
      matchId: matchId
    });

    // 3. Salva o estado da partida em memória (RAM)
    this.activeGames.set(matchId, {
      playerIds: playerIds,
      currentTurnIndex: 0 // O índice 0 é o primeiro jogador do array
    });

    // 4. Inicia o primeiro turno imediatamente após distribuir as cartas
    this.emitTurn(matchId, server);
  }

  // --- Função para emitir de quem é a vez ---
  private emitTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    // Descobre quem é o jogador atual usando o índice
    const currentPlayerId = game.playerIds[game.currentTurnIndex];

    console.log(`[Game] ⏳ Turno do jogador ${currentPlayerId} na partida ${matchId}`);

    // Avisa a SALA INTEIRA de quem é a vez
    server.to(matchId).emit('turn_start', {
      currentPlayerId: currentPlayerId,
      message: `É a vez do jogador!`
    });
  }

  // --- Função para passar a vez ---
  passTurn(matchId: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return;

    // Passa para o próximo índice. O operador '%' faz voltar pro 0 quando chegar no 4.
    game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
    
    // Atualiza o estado e emite o novo turno
    this.activeGames.set(matchId, game);
    this.emitTurn(matchId, server);
  }

  // --- Função para processar a jogada de uma carta ---
  async processMove(matchId: string, userId: string, cardValue: string, claimedValue: string, server: Server) {
    const game = this.activeGames.get(matchId);
    if (!game) return { success: false, message: 'Partida não encontrada.' };
    
    const currentPlayerId = game.playerIds[game.currentTurnIndex];
    if (currentPlayerId !== userId) return { success: false, message: 'Não é a sua vez!' };

    const player = await this.prisma.matchPlayer.findFirst({ where: { matchId, userId } });
    if (!player || !player.cards.includes(cardValue)) {
      return { success: false, message: 'Você não possui esta carta na mão.' };
    }

    // Remove a carta da mão no banco
    const newHand = [...player.cards];
    newHand.splice(newHand.indexOf(cardValue), 1);
    await this.prisma.matchPlayer.updateMany({ where: { matchId, userId }, data: { cards: newHand } });

    console.log(`[Game] Jogador ${userId} jogou oculto ${cardValue} (disse que era ${claimedValue})`);

    // Salva a jogada na memória antes de passar o turno para permitir o desafio
    game.lastPlay = { userId, cardPlayed: cardValue, claimedCard: claimedValue };
    this.activeGames.set(matchId, game);

    // Passa o turno para o próximo jogador
    this.passTurn(matchId, server);
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

    const { userId: targetId, cardPlayed, claimedCard } = game.lastPlay;
    
    // LÓGICA DE DETECÇÃO DE MENTIRA: é mentira se a carta for diferente e NÃO for Coringa
    const isLiar = cardPlayed !== claimedCard && cardPlayed !== 'JOKER';

    // Se quem jogou mentiu, ele perde. Se falou a verdade, quem duvidou perde.
    const loserId = isLiar ? targetId : challengerId;

    // Atualiza o banco com os Status de penalidade
    await this.prisma.match.update({ where: { id: matchId }, data: { status: 'PENALTY' } });
    await this.prisma.matchPlayer.updateMany({ 
      where: { matchId: matchId, userId: loserId }, 
      data: { status: 'IN_PENALTY' } 
    });

    console.log(`[Game] Desafio na partida ${matchId}! Alvo mentiu? ${isLiar}. Perdedor: ${loserId}`);

    // Avisa a mesa inteira sobre o resultado dramático
    server.to(matchId).emit('challenge_result', {
      challengerId: challengerId,
      targetId: targetId,
      isLiar: isLiar,
      actualCard: cardPlayed,
      loserId: loserId,
      message: isLiar 
        ? `🚨 PEGO NA MENTIRA! A carta era um(a) ${cardPlayed}.` 
        : `❌ ACUSAÇÃO FALSA! A carta realmente era um(a) ${claimedCard}.`
    });

    // Limpa a última jogada
    game.lastPlay = undefined;
    this.activeGames.set(matchId, game);

    // Inicia o evento de punição para o perdedor da rodada
    server.to(matchId).emit('start_penalty_duel', { loserId: loserId });

    return { success: true };
  }

  async resolvePenaltyDuel(matchId: string, userId: string, playerChoice: string, server: Server) {
    const validChoices = ['ROCK', 'PAPER', 'SCISSORS'];
    if (!validChoices.includes(playerChoice)) {
      return { success: false, message: 'Escolha inválida. Use ROCK, PAPER ou SCISSORS.' };
    }

    // Verifica se o jogador realmente está na berlinda (IN_PENALTY)
    const player = await this.prisma.matchPlayer.findFirst({
      where: { matchId, userId, status: 'IN_PENALTY' }
    });

    if (!player) {
      return { success: false, message: 'Você não está em um duelo de punição.' };
    }

    // A "Máquina" faz a sua jogada de forma aleatória
    const pcChoice = validChoices[Math.floor(Math.random() * validChoices.length)];

    // Lógica do Jokenpo: Verifica se o jogador perdeu
    let isEliminated = false;
    if (playerChoice === pcChoice) {
      // Empate: Sobrevive
      isEliminated = false; 
    } else if (
      (playerChoice === 'ROCK' && pcChoice === 'SCISSORS') ||
      (playerChoice === 'PAPER' && pcChoice === 'ROCK') ||
      (playerChoice === 'SCISSORS' && pcChoice === 'PAPER')
    ) {
      // Vitória: Sobrevive
      isEliminated = false;
    } else {
      // Derrota: Eliminado
      isEliminated = true;
    }

    // Atualiza o banco de dados
    const newStatus = isEliminated ? 'ELIMINATED' : 'SAFE';
    await this.prisma.matchPlayer.updateMany({
      where: { matchId, userId },
      data: { status: newStatus }
    });

    // Avisa a todos o que aconteceu na roleta
    server.to(matchId).emit('penalty_result', {
      userId,
      playerChoice,
      pcChoice,
      isEliminated,
      message: isEliminated 
        ? `💀 FIM DA LINHA! O jogador escolheu ${playerChoice} e o PC escolheu ${pcChoice}. O jogador foi ELIMINADO!` 
        : `🎉 POR POUCO! O jogador escolheu ${playerChoice} e o PC escolheu ${pcChoice}. O jogador sobreviveu!`
    });

    // 2. Checa se o jogo acabou ou se continua
    await this.checkGameOverOrContinue(matchId, server);

    return { success: true };
  }

  // 2. Método Auxiliar: Verifica fim de jogo ou inicia o próximo round
  private async checkGameOverOrContinue(matchId: string, server: Server) {
    // Busca todos os jogadores que ainda não foram eliminados
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

      // ---> NOVO: ATUALIZANDO O HISTÓRICO E RANKING <---
      
      // 1. Adiciona +1 partida jogada para TODOS os participantes da mesa
      const allPlayers = await this.prisma.matchPlayer.findMany({ where: { matchId } });
      for (const p of allPlayers) {
        await this.prisma.user.update({
          where: { id: p.userId },
          data: { matchesPlayed: { increment: 1 } } // Prisma faz a soma automática!
        });
      }

      // 2. Adiciona +1 vitória apenas para o Campeão
      if (winnerId) {
        await this.prisma.user.update({
          where: { id: winnerId },
          data: { wins: { increment: 1 } }
        });
      }
      
      // ---> FIM DA ATUALIZAÇÃO DO RANKING <---

      server.to(matchId).emit('game_over', { 
        winnerId: winnerId, 
        message: winnerId ? '🏆 Temos um grande campeão!' : '🤝 Empate/Todos eliminados.' 
      });

      this.activeGames.delete(matchId);
    } else  {
      // O JOGO CONTINUA! Volta o status para PLAYING e passa o turno
      await this.prisma.match.update({ 
        where: { id: matchId }, 
        data: { status: 'PLAYING' } 
      });

      const game = this.activeGames.get(matchId);
      if (game) {
        // Limpa a carta da mesa para o próximo round
        game.lastPlay = undefined;
        this.activeGames.set(matchId, game);
        
        // Passa o turno. Importante: Como alguém pode ter sido eliminado, 
        // vamos rodar o passTurn até cair em alguém que está SAFE.
        let nextPlayerIsEliminated = true;
        let loops = 0; // Trava de segurança
        
        while (nextPlayerIsEliminated && loops < 4) {
          game.currentTurnIndex = (game.currentTurnIndex + 1) % game.playerIds.length;
          const nextPlayerId = game.playerIds[game.currentTurnIndex];
          
          const checkStatus = survivors.find(s => s.userId === nextPlayerId);
          if (checkStatus) {
            nextPlayerIsEliminated = false; // Achou alguém vivo!
          }
          loops++;
        }
        
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

  // --- Embaralhamento Profissional (Fisher-Yates) ---
  private shuffle(array: string[]): string[] {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
  }
  // Tenta recuperar a partida se o jogador atualizou a página
  async recoverGameState(userId: string, client: Socket) {
    
    if (this.disconnectTimeouts.has(userId)) {
      clearTimeout(this.disconnectTimeouts.get(userId));
      this.disconnectTimeouts.delete(userId);
      console.log(`[AFK] 🛑 Eliminação cancelada! Jogador ${userId} reconectou a tempo.`);
    }
    // 1. Procura no banco se o jogador está em uma partida não finalizada
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

    // Se a partida estiver no banco mas não na RAM (ex: servidor reiniciou), encerramos ela por segurança
    if (!game) {
      await this.prisma.match.update({ where: { id: matchId }, data: { status: 'FINISHED' } });
      return { success: false, message: 'Partida expirou no servidor.' };
    }

    // 2. Reconecta o Socket nas salas corretas
    client.join(matchId); // Sala da partida
    client.join(userId);  // Sala privada para receber cartas no futuro

    // 3. Monta o "Resumão" de como está a mesa agora
    const state = {
      matchId: matchId,
      matchStatus: playerRecord.match.status,
      myStatus: playerRecord.status,
      myCards: playerRecord.cards,
      currentTurnPlayerId: game.playerIds[game.currentTurnIndex],
      lastPlay: game.lastPlay ? {
        userId: game.lastPlay.userId,
        claimedCard: game.lastPlay.claimedCard // Nunca envie a cardPlayed (real) para o cliente reconectado!
      } : null
    };

    // 4. Envia para o jogador o estado atual
    client.emit('game_state_recovered', state);
    console.log(`[Reconexão] Jogador ${userId} voltou para a partida ${matchId}`);

    return { success: true };
  }

  async handlePlayerDisconnect(userId: string, server: Server) {
    // 1. Verifica se o cara estava no meio de uma partida (e não apenas no menu)
    const player = await this.prisma.matchPlayer.findFirst({
      where: { 
        userId: userId, 
        match: { status: { in: ['PLAYING', 'PENALTY'] } },
        status: { not: 'ELIMINATED' } 
      }
    });

    if (!player) return; // Se não tava jogando, não faz nada

    const matchId = player.matchId;
    console.log(`[AFK] ⚠️ Jogador ${userId} caiu na partida ${matchId}. Iniciando timer de 30s...`);
    
    server.to(matchId).emit('player_disconnected', {
      userId,
      message: 'Um oponente perdeu a conexão. Aguardando 30 segundos para retornar...'
    });

    // 2. Inicia o cronômetro da morte
    const timeout = setTimeout(async () => {
      console.log(`[AFK] 💀 Tempo esgotado para ${userId}. Aplicando W.O.`);

      // Elimina o jogador no banco
      await this.prisma.matchPlayer.updateMany({
        where: { matchId: matchId, userId: userId },
        data: { status: 'ELIMINATED' }
      });

      // Avisa a mesa
      server.to(matchId).emit('player_eliminated_afk', {
        userId,
        message: 'Oponente eliminado por abandono de partida!'
      });

      this.disconnectTimeouts.delete(userId);

      // Checa se sobrou só um vivo ou se passa o turno
      await this.checkGameOverOrContinue(matchId, server);

    }, 30000); // 30.000 milissegundos = 30 segundos

    // Salva o cronômetro para poder cancelar se ele voltar
    this.disconnectTimeouts.set(userId, timeout);
  }
}