import 'dotenv/config'; // 🚨 Garante que o .env seja lido imediatamente
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Busca a URL do seu Supabase
    const connectionString = process.env.DATABASE_URL;
    
    // Trava de segurança: se a URL não existir, o Nest te avisa no terminal ao invés de dar erro 500
    if (!connectionString) {
      throw new Error('❌ DATABASE_URL não foi encontrada pelo NestJS!');
    }
    
    // Cria o pool de conexões utilizando o driver nativo do Postgres
    const pool = new Pool({ connectionString });
    
    // Instancia o adaptador do Prisma
    const adapter = new PrismaPg(pool);

    // O Prisma 7 recebe o adapter obrigatório, validando o super() e eliminando o erro
    super({ adapter }); 
  }

  async onModuleInit() {
    await this.$connect();
    console.log('✅ Banco conectado via PG Adapter!');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}