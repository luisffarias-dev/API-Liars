import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global() // Esse decorator torna o módulo disponível em toda a aplicação
@Module({
  providers: [PrismaService],
  exports: [PrismaService], // O segredo está aqui: exportar o serviço!
})
export class PrismaModule {}