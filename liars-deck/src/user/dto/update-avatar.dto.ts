import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator'; // <-- Importar as validações

export class UpdateAvatarDto {
  @ApiProperty({ 
    example: 'user8.png', 
    description: 'Nome do ficheiro de imagem guardado nos assets do app' 
  })
  @IsString({ message: 'O avatar deve ser um texto válido.' }) // <-- Diz ao NestJS que este campo é permitido
  @IsNotEmpty({ message: 'O nome do avatar não pode estar vazio.' })
  avatar: string;
}