import { IsEmail, IsString, MinLength, IsNotEmpty, MaxLength, Matches} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreateUserDto {
  @ApiProperty({ example: 'Jogador123' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => value?.trim())
  @MaxLength(30, { message: 'O nickname não pode ter mais de 30 caracteres' })
  @Matches(/^[a-zA-Z0-9_]+$/, { message: 'Nickname só pode conter letras, números e underline' }) // 👈 Impede caracteres especiais (XSS)
  nickname: string;

  @ApiProperty({ example: 'player@liarsdeck.com' })
  @IsEmail({}, { message: 'Formato de e-mail inválido' })
  @Transform(({ value }) => value.toLowerCase().trim()) // 👈 Normaliza o e-mail
  email: string;

  @ApiProperty({ example: '123456', minLength: 6 })
  @IsString()
  @MinLength(6, { message: 'A senha deve ter pelo menos 6 caracteres' })
  @MaxLength(50, { message: 'A senha é muito longa' }) // 👈 Limite de segurança
  password: string;
}