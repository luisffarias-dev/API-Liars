import { ApiProperty } from '@nestjs/swagger';

export class UserProfileResponseDto {
  @ApiProperty({ example: 'uuid-1234-5678' })
  id: string;

  @ApiProperty({ example: 'jogador1' })
  nickname: string;
 
  @ApiProperty({ example: 'default.png' })
  avatar: string;

  @ApiProperty({ example: 12 })
  wins: number;

  @ApiProperty({ example: 16 })
  matchesPlayed: number;

  @ApiProperty({ example: 4 })
  losses: number;

  @ApiProperty({ example: 75 })
  winRate: number;

  @ApiProperty({ example: '2026-06-08T10:00:00Z' })
  createdAt: Date;
}