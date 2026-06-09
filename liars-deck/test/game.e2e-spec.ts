import * as dotenv from 'dotenv';
dotenv.config();

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
const request = require('supertest');
import { io, Socket } from 'socket.io-client';
import { AppModule } from './../src/app.module';
import { GameService } from './../src/match/game.service';

describe('Matchmaking e Game (e2e)', () => {
  let app: INestApplication;
  let serverUrl: string;
  let gameService: GameService;
  
  // Nossos 4 bots
  let p1: Socket, p2: Socket, p3: Socket, p4: Socket;
  let t1: string, t2: string, t3: string, t4: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.listen(0); 
    serverUrl = await app.getUrl();

    gameService = app.get(GameService);

    if (!process.env.TEST_USER4_EMAIL) {
      throw new Error('As 4 variáveis de teste não foram encontradas no .env!');
    }

    // Função auxiliar para não repetir código de login
    const doLogin = async (email, password) => {
      const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password });
      return res.body.access_token || res.body.token;
    };

    t1 = await doLogin(process.env.TEST_USER1_EMAIL, process.env.TEST_USER1_PASSWORD);
    t2 = await doLogin(process.env.TEST_USER2_EMAIL, process.env.TEST_USER2_PASSWORD);
    t3 = await doLogin(process.env.TEST_USER3_EMAIL, process.env.TEST_USER3_PASSWORD);
    t4 = await doLogin(process.env.TEST_USER4_EMAIL, process.env.TEST_USER4_PASSWORD);
  });

  afterAll(async () => {
    // 1. Limpa todos os temporizadores de desconexão que estiverem rodando
    // Acessamos a variável privada apenas para testes (uma gambiarra justificada)
    const timeoutsMap = (gameService as any).disconnectTimeouts;
    for (const [key, timeout] of timeoutsMap.entries()) {
        clearTimeout(timeout);
    }
    timeoutsMap.clear();

    // 2. Desconecta os sockets tranquilamente
    if (p1) p1.disconnect();
    if (p2) p2.disconnect();
    if (p3) p3.disconnect();
    if (p4) p4.disconnect();

    // 3. Dá um respiro para o Prisma terminar eventuais transações pendentes
    await new Promise(resolve => setTimeout(resolve, 500)); 

    // 4. Fecha a aplicação do NestJS (encerra o pool de conexões do Prisma)
    await app.close();
  });

  it('Deve conectar 4 jogadores, encher a fila e iniciar a partida', (done) => {
    p1 = io(serverUrl, { auth: { token: t1 } });
    p2 = io(serverUrl, { auth: { token: t2 } });
    p3 = io(serverUrl, { auth: { token: t3 } });
    p4 = io(serverUrl, { auth: { token: t4 } });

    let connectedCount = 0;

    const tryFindMatch = () => {
      connectedCount++;
      // Só emite o find_match quando os 4 estiverem perfeitamente conectados
      if (connectedCount === 4) {
        p1.emit('find_match');
        p2.emit('find_match');
        p3.emit('find_match');
        p4.emit('find_match');
      }
    };

    p1.on('connect', tryFindMatch);
    p2.on('connect', tryFindMatch);
    p3.on('connect', tryFindMatch);
    p4.on('connect', tryFindMatch);

    // Avalia se o Jogador 1 recebeu o evento de partida pronta
    p1.on('game_ready', (data) => {
      expect(data).toBeDefined();
      expect(data.matchId).toBeDefined();
      expect(data.message).toContain('O duelo começou');
      done(); 
    });

    p1.on('connect_error', (err) => done(err));
  });
});