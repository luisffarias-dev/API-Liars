import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  // Cria a instância da aplicação baseada no AppModule
  const app = await NestFactory.create(AppModule);

  // 1. Configuração do ValidationPipe (Crucial para os seus DTOs funcionarem)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Remove campos do corpo da requisição que não estão no DTO
      forbidNonWhitelisted: true, // Retorna erro se enviarem campos extras (como o role: ADMIN)
      transform: true, // Converte tipos automaticamente
    }),
  );

  // 2. Configuração do Swagger (Para bater com os decorators que você já usou)
  const config = new DocumentBuilder()
    .setTitle('Liars Deck API')
    .setDescription('API de Webhooks e Gerenciamento de Jogadores')
    .setVersion('1.0')
    .addBearerAuth() // Habilita a opção de colocar o Token JWT no Swagger
    .build();
  
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  // 3. Habilita o CORS (Importante se você for conectar um front-end ou mobile depois)
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: '*',
  });

  // Inicia o servidor na porta 3000
  await app.listen(process.env.PORT || 3000, '0.0.0.0');
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();