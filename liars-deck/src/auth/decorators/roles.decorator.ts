import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client'; // Importa o Enum que você criou no Prisma

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);